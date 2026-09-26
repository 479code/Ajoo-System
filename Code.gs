/**
 * Ajoo Ledger — runs entirely inside this Google Sheet.
 *
 * This script both serves the ledger's web page AND stores its data in this
 * spreadsheet. It creates and manages its own tabs (Batches, Participants,
 * Queue, History, HistoryPayments) and a hidden config tab ("Config") — you
 * don't need to set up any columns yourself. Each tab holds plain,
 * readable rows (no JSON blobs) so you can open the sheet directly and see
 * exactly what's going on.
 *
 * SETUP (one time):
 *   1. In this spreadsheet: Extensions > Apps Script.
 *   2. Delete anything in the Code.gs editor and paste this whole file in.
 *   3. Add a second file: File > New > HTML file, name it exactly "Index"
 *      (capital I, no .html — Apps Script adds that itself), and paste in
 *      the Index.html content you were given.
 *   4. Save (the disk icon, or Ctrl/Cmd+S).
 *   5. Click Deploy > New deployment.
 *   6. Type: "Web app".
 *   7. Execute as: "Me". Who has access: "Anyone".
 *   8. Click Deploy, authorize it when Google asks (click through the
 *      "Google hasn't verified this app" warning with Advanced > Go to
 *      project — that warning is normal for a script you wrote yourself).
 *   9. Open the "Web app URL" it gives you (ends in /exec) — that's the
 *      ledger. Share that link with your mum and the participants.
 *
 * If you ever edit this code again, use Deploy > Manage deployments > Edit
 * (pencil icon) > New version, so the same URL picks up your changes.
 *
 * If you're updating from an older version of this script that stored each
 * batch's data as one JSON blob, nothing to do — the very first time this
 * new version runs it automatically splits that data out into the readable
 * tabs below and leaves your existing batches exactly as they were.
 */

var BATCHES_SHEET = 'Batches';
var PARTICIPANTS_SHEET = 'Participants';
var SUB_PAYERS_SHEET = 'SubPayers';
var QUEUE_SHEET = 'Queue';
var HISTORY_SHEET = 'History';
var HISTORY_PAYMENTS_SHEET = 'HistoryPayments';
var CURRENT_PAYMENTS_SHEET = 'CurrentPayments';
var CONFIG_SHEET = 'Config';

var BATCHES_HEADER = ['id', 'name', 'amount', 'currency', 'startMonth', 'createdAt', 'archived'];
var PARTICIPANTS_HEADER = ['batchId', 'participantId', 'name', 'phone', 'order'];
var SUB_PAYERS_HEADER = ['batchId', 'participantId', 'subPayerId', 'name', 'phone', 'amount', 'order'];
var QUEUE_HEADER = ['batchId', 'participantId', 'queuePosition'];
var HISTORY_HEADER = ['batchId', 'round', 'collectorId', 'collectorName', 'monthLabel', 'collectedAt'];
var HISTORY_PAYMENTS_HEADER = ['batchId', 'round', 'participantId', 'status'];
var CURRENT_PAYMENTS_HEADER = ['batchId', 'participantId', 'status'];

var OLD_BATCHES_HEADER = ['id', 'name', 'amount', 'currency', 'startMonth', 'createdAt', 'archived', 'data'];

/* ---------------- serves the page ---------------- */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Ajoo Ledger')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------------- functions the page calls directly (google.script.run) ---------------- */

function api_getState() {
  return getState_();
}

function api_setPin(pin) {
  return setPin_(pin);
}

function api_verifyPin(pin) {
  var v = checkPin_(pin);
  return { ok: v.ok, error: v.error, message: v.message };
}

function api_setPaymentDetails(pin, accountNumber, accountName, bankName) {
  var pinCheck = checkPin_(pin);
  if (!pinCheck.ok) {
    return { error: pinCheck.error, message: pinCheck.message };
  }
  var sheets = ensureSheets_();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return { error: 'busy', message: 'The sheet is busy — please try again in a moment.' };
  }
  try {
    setConfig_(sheets, 'payAccountNumber', String(accountNumber || '').trim());
    setConfig_(sheets, 'payAccountName', String(accountName || '').trim());
    setConfig_(sheets, 'payBankName', String(bankName || '').trim());
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function api_changePin(oldPin, newPin) {
  var check = checkPin_(oldPin);
  if (!check.ok) {
    return { error: check.error, message: check.message };
  }
  if (!newPin || String(newPin).length < 4) {
    return { error: 'pin_too_short', message: 'Use at least 4 digits.' };
  }
  var sheets = ensureSheets_();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return { error: 'busy', message: 'The sheet is busy — please try again in a moment.' };
  }
  try {
    setConfig_(sheets, 'pinHash', hashPin_(newPin));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function api_mutate(action, pin, payload) {
  payload = payload || {};
  var pinCheck = checkPin_(pin);
  if (!pinCheck.ok) {
    return { error: pinCheck.error, message: pinCheck.message };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return { error: 'busy', message: 'The sheet is busy — please try again in a moment.' };
  }

  try {
    var state = getState_();
    var updated;
    switch (action) {
      case 'createBatch':
        updated = doCreateBatch_(state, payload.draft);
        break;
      case 'editBatch':
        updated = doEditBatch_(state, payload.batchId, payload.name, payload.amount, payload.startMonth);
        break;
      case 'togglePayment':
        updated = doTogglePayment_(state, payload.batchId, payload.payerId || payload.participantId);
        break;
      case 'markCollected':
        updated = doMarkCollected_(state, payload.batchId);
        break;
      case 'addParticipant':
        updated = doAddParticipant_(state, payload.batchId, payload.name, payload.phone, payload.subNames);
        break;
      case 'removeParticipant':
        updated = doRemoveParticipant_(state, payload.batchId, payload.participantId);
        break;
      case 'moveParticipant':
        updated = doMoveParticipant_(state, payload.batchId, payload.participantId, payload.dir);
        break;
      case 'toggleArchive':
        updated = doToggleArchive_(state, payload.batchId);
        break;
      case 'deleteBatch':
        updated = doDeleteBatch_(state, payload.batchId);
        break;
      default:
        return { error: 'unknown_action', message: 'Unknown action: ' + action };
    }

    if (action === 'togglePayment') {
      // Hot path: confirming a payment happens dozens of times per round, and
      // it only ever changes ONE cell. Patch that cell directly instead of
      // the full clear-and-rewrite saveState_() does for every sheet — that
      // full rewrite is what made a single tap feel slow once a batch had a
      // few rounds of history piled up.
      var payerId = payload.payerId || payload.participantId;
      var tb = findBatch_(updated, payload.batchId);
      var sheets = ensureSheets_();
      patchCurrentPayment_(sheets, payload.batchId, payerId, tb ? (tb.currentPayments[payerId] || 'pending') : 'pending');
    } else {
      saveState_(updated);
    }
    return updated;
  } catch (err) {
    return { error: 'server_error', message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- sheet setup + one-time migration ---------------- */

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var batches = ss.getSheetByName(BATCHES_SHEET);
  var batchesIsNew = false;
  if (!batches) {
    batches = ss.insertSheet(BATCHES_SHEET);
    batches.appendRow(BATCHES_HEADER);
    batches.setFrozenRows(1);
    batchesIsNew = true;
  }

  var participants = ss.getSheetByName(PARTICIPANTS_SHEET);
  var participantsIsNew = false;
  if (!participants) {
    participants = ss.insertSheet(PARTICIPANTS_SHEET);
    participants.appendRow(PARTICIPANTS_HEADER);
    participants.setFrozenRows(1);
    participantsIsNew = true;
    // Force the phone column to plain text so Sheets doesn't "helpfully"
    // read a number like 08012345678 and drop the leading zero.
    participants.getRange('D:D').setNumberFormat('@');
  }

  var subPayers = ss.getSheetByName(SUB_PAYERS_SHEET);
  if (!subPayers) {
    subPayers = ss.insertSheet(SUB_PAYERS_SHEET);
    subPayers.appendRow(SUB_PAYERS_HEADER);
    subPayers.setFrozenRows(1);
    subPayers.getRange('E:E').setNumberFormat('@');
  }

  var queue = ss.getSheetByName(QUEUE_SHEET);
  if (!queue) {
    queue = ss.insertSheet(QUEUE_SHEET);
    queue.appendRow(QUEUE_HEADER);
    queue.setFrozenRows(1);
  }

  var history = ss.getSheetByName(HISTORY_SHEET);
  if (!history) {
    history = ss.insertSheet(HISTORY_SHEET);
    history.appendRow(HISTORY_HEADER);
    history.setFrozenRows(1);
  }

  var historyPayments = ss.getSheetByName(HISTORY_PAYMENTS_SHEET);
  if (!historyPayments) {
    historyPayments = ss.insertSheet(HISTORY_PAYMENTS_SHEET);
    historyPayments.appendRow(HISTORY_PAYMENTS_HEADER);
    historyPayments.setFrozenRows(1);
  }

  var currentPayments = ss.getSheetByName(CURRENT_PAYMENTS_SHEET);
  if (!currentPayments) {
    currentPayments = ss.insertSheet(CURRENT_PAYMENTS_SHEET);
    currentPayments.appendRow(CURRENT_PAYMENTS_HEADER);
    currentPayments.setFrozenRows(1);
  }

  var config = ss.getSheetByName(CONFIG_SHEET);
  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
    config.appendRow(['key', 'value']);
    config.setFrozenRows(1);
    config.hideSheet();
    // Same fix as above — the payment account number is digits-only and
    // would otherwise lose a leading zero the moment Sheets treats it as a
    // number instead of text.
    config.getRange('B:B').setNumberFormat('@');
  }

  var sheets = {
    ss: ss, batches: batches, participants: participants, subPayers: subPayers, queue: queue,
    history: history, historyPayments: historyPayments,
    currentPayments: currentPayments, config: config
  };

  // One-time migration: only runs the very first time this new code sees an
  // old-format Batches sheet (Participants sheet didn't exist yet, meaning
  // we just created it above).
  if (!batchesIsNew && participantsIsNew) {
    var headerRow = batches.getRange(1, 1, 1, Math.max(batches.getLastColumn(), 1)).getValues()[0];
    if (headerRow[7] === 'data') {
      var lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
        migrateFromBlob_(sheets);
      } finally {
        lock.releaseLock();
      }
    }
  }

  ensurePlainTextColumns_(sheets);

  return sheets;
}

// Several columns hold digit-only or date-shaped text ("08012345678",
// "0013943449", "2026-06", "June 2026") that Google Sheets will silently
// reinterpret as a Number or a Date the moment it's written into a
// General-formatted cell — dropping leading zeros, or turning "June 2026"
// into an actual date that reads back as a mangled
// "Mon Jun 01 2026 00:00:00 GMT+0100 (West Africa Time)" string. Forcing
// these columns to Plain Text stops it from happening on every future
// write. This runs once per spreadsheet (tracked in Config so it doesn't
// cost an extra API round trip on every single request) and — unlike the
// per-sheet-creation formatting below, which only ever helps a brand new
// spreadsheet — it also repairs an already-live sheet the next time it's
// opened after this update.
function ensurePlainTextColumns_(sheets) {
  if (getConfig_(sheets, 'plainTextFmtV2') === 'done') return;
  sheets.participants.getRange('D:D').setNumberFormat('@');
  sheets.subPayers.getRange('E:E').setNumberFormat('@');
  sheets.config.getRange('B:B').setNumberFormat('@');
  sheets.batches.getRange('E:E').setNumberFormat('@');
  sheets.history.getRange('E:E').setNumberFormat('@');
  setConfig_(sheets, 'plainTextFmtV2', 'done');
}

function migrateFromBlob_(sheets) {
  var rows = sheets.batches.getDataRange().getValues();
  var batchRows = [BATCHES_HEADER];
  var participantRows = [PARTICIPANTS_HEADER];
  var queueRows = [QUEUE_HEADER];
  var historyRows = [HISTORY_HEADER];
  var historyPaymentRows = [HISTORY_PAYMENTS_HEADER];
  var currentPaymentRows = [CURRENT_PAYMENTS_HEADER];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    var id = String(r[0]);
    var data;
    try { data = JSON.parse(r[7] || '{}'); } catch (e) { data = {}; }
    var participants = data.participants || [];
    var queue = data.queue || [];
    var history = data.history || [];
    var currentPayments = data.currentPayments || {};

    batchRows.push([id, String(r[1] || ''), Number(r[2]) || 0, String(r[3] || 'NGN'), readStartMonthCell_(r[4]), String(r[5] || ''), r[6] === true || r[6] === 'TRUE']);

    var nameById = {};
    participants.forEach(function (p, idx) {
      nameById[p.id] = p.name || '';
      participantRows.push([id, p.id, p.name || '', p.phone || '', idx]);
    });
    queue.forEach(function (pid, idx) {
      queueRows.push([id, pid, idx]);
    });
    history.forEach(function (hEntry, round) {
      historyRows.push([id, round, hEntry.collectorId, nameById[hEntry.collectorId] || '', hEntry.monthLabel || '', hEntry.collectedAt || '']);
      var payments = hEntry.payments || {};
      Object.keys(payments).forEach(function (pid) {
        historyPaymentRows.push([id, round, pid, payments[pid]]);
      });
    });
    Object.keys(currentPayments).forEach(function (pid) {
      currentPaymentRows.push([id, pid, currentPayments[pid]]);
    });
  }

  writeAllRows_(sheets.batches, batchRows);
  writeAllRows_(sheets.participants, participantRows);
  writeAllRows_(sheets.queue, queueRows);
  writeAllRows_(sheets.history, historyRows);
  writeAllRows_(sheets.historyPayments, historyPaymentRows);
  writeAllRows_(sheets.currentPayments, currentPaymentRows);
}

function writeAllRows_(sheet, rows) {
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
}

/* ---------------- sheet <-> state ---------------- */

function getState_() {
  var sheets = ensureSheets_();

  var batchRows = sheets.batches.getDataRange().getValues();
  var batchesById = {};
  var order = [];
  for (var i = 1; i < batchRows.length; i++) {
    var r = batchRows[i];
    if (!r[0]) continue;
    var id = String(r[0]);
    batchesById[id] = {
      id: id,
      name: String(r[1] || ''),
      amount: Number(r[2]) || 0,
      currency: String(r[3] || 'NGN'),
      startMonth: readStartMonthCell_(r[4]),
      createdAt: String(r[5] || ''),
      archived: r[6] === true || r[6] === 'TRUE',
      participants: [],
      queue: [],
      history: [],
      currentPayments: {}
    };
    order.push(id);
  }

  var pRows = sheets.participants.getDataRange().getValues();
  var participantsByBatch = {};
  for (var i = 1; i < pRows.length; i++) {
    var r = pRows[i];
    if (!r[0] || !batchesById[String(r[0])]) continue;
    var bid = String(r[0]);
    (participantsByBatch[bid] = participantsByBatch[bid] || []).push({
      order: Number(r[4]) || 0,
      p: { id: String(r[1]), name: String(r[2] || ''), phone: String(r[3] || '') }
    });
  }
  Object.keys(participantsByBatch).forEach(function (bid) {
    var arr = participantsByBatch[bid].sort(function (a, b) { return a.order - b.order; });
    batchesById[bid].participants = arr.map(function (x) { return x.p; });
  });

  var participantIndexByBatch = {};
  Object.keys(batchesById).forEach(function (bid) {
    var idx = {};
    batchesById[bid].participants.forEach(function (p) { idx[p.id] = p; });
    participantIndexByBatch[bid] = idx;
  });

  var spRows = sheets.subPayers.getDataRange().getValues();
  var subPayersByBatchParticipant = {};
  for (var i = 1; i < spRows.length; i++) {
    var r = spRows[i];
    if (!r[0] || !batchesById[String(r[0])]) continue;
    var bid = String(r[0]);
    var key = bid + '|' + String(r[1]);
    (subPayersByBatchParticipant[key] = subPayersByBatchParticipant[key] || []).push({
      order: Number(r[6]) || 0,
      sp: { id: String(r[2]), name: String(r[3] || ''), phone: String(r[4] || ''), amount: Number(r[5]) || 0 }
    });
  }
  Object.keys(subPayersByBatchParticipant).forEach(function (key) {
    var parts = key.split('|');
    var bid = parts[0], pid = parts[1];
    var participant = participantIndexByBatch[bid] && participantIndexByBatch[bid][pid];
    if (!participant) return;
    var arr = subPayersByBatchParticipant[key].sort(function (a, b) { return a.order - b.order; });
    participant.subPayers = arr.map(function (x) { return x.sp; });
  });

  var qRows = sheets.queue.getDataRange().getValues();
  var queueByBatch = {};
  for (var i = 1; i < qRows.length; i++) {
    var r = qRows[i];
    if (!r[0] || !batchesById[String(r[0])]) continue;
    var bid = String(r[0]);
    (queueByBatch[bid] = queueByBatch[bid] || []).push({ pos: Number(r[2]) || 0, id: String(r[1]) });
  }
  Object.keys(queueByBatch).forEach(function (bid) {
    var arr = queueByBatch[bid].sort(function (a, b) { return a.pos - b.pos; });
    batchesById[bid].queue = arr.map(function (x) { return x.id; });
  });

  var hRows = sheets.history.getDataRange().getValues();
  var historyByBatch = {};
  for (var i = 1; i < hRows.length; i++) {
    var r = hRows[i];
    if (r[0] === '' || r[0] == null || !batchesById[String(r[0])]) continue;
    var bid = String(r[0]);
    (historyByBatch[bid] = historyByBatch[bid] || []).push({
      round: Number(r[1]) || 0,
      collectorId: String(r[2]),
      monthLabel: readMonthLabelCell_(r[4]),
      collectedAt: String(r[5] || ''),
      payments: {}
    });
  }

  var hpRows = sheets.historyPayments.getDataRange().getValues();
  var paymentsByBatchRound = {};
  for (var i = 1; i < hpRows.length; i++) {
    var r = hpRows[i];
    if (r[0] === '' || r[0] == null) continue;
    var key = String(r[0]) + '|' + (Number(r[1]) || 0);
    (paymentsByBatchRound[key] = paymentsByBatchRound[key] || {})[String(r[2])] = String(r[3] || 'pending');
  }

  Object.keys(historyByBatch).forEach(function (bid) {
    var arr = historyByBatch[bid].sort(function (a, b) { return a.round - b.round; });
    batchesById[bid].history = arr.map(function (x) {
      return {
        collectorId: x.collectorId,
        monthLabel: x.monthLabel,
        collectedAt: x.collectedAt,
        payments: paymentsByBatchRound[bid + '|' + x.round] || {}
      };
    });
  });

  var cpRows = sheets.currentPayments.getDataRange().getValues();
  var curByBatch = {};
  for (var i = 1; i < cpRows.length; i++) {
    var r = cpRows[i];
    if (r[0] === '' || r[0] == null || !batchesById[String(r[0])]) continue;
    var bid = String(r[0]);
    (curByBatch[bid] = curByBatch[bid] || {})[String(r[1])] = String(r[2] || 'pending');
  }
  order.forEach(function (bid) { batchesById[bid].currentPayments = curByBatch[bid] || {}; });

  var batches = order.map(function (id) { return batchesById[id]; });
  batches.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
  return {
    batches: batches,
    pinSet: !!getConfig_(sheets, 'pinHash'),
    paymentDetails: {
      accountNumber: getConfig_(sheets, 'payAccountNumber') || '',
      accountName: getConfig_(sheets, 'payAccountName') || '',
      bankName: getConfig_(sheets, 'payBankName') || ''
    }
  };
}

function saveState_(state) {
  var sheets = ensureSheets_();

  var batchRows = [BATCHES_HEADER];
  var participantRows = [PARTICIPANTS_HEADER];
  var subPayerRows = [SUB_PAYERS_HEADER];
  var queueRows = [QUEUE_HEADER];
  var historyRows = [HISTORY_HEADER];
  var historyPaymentRows = [HISTORY_PAYMENTS_HEADER];
  var currentPaymentRows = [CURRENT_PAYMENTS_HEADER];

  state.batches.forEach(function (b) {
    batchRows.push([b.id, b.name, b.amount, b.currency, b.startMonth, b.createdAt, !!b.archived]);

    var nameById = {};
    b.participants.forEach(function (p, idx) {
      nameById[p.id] = p.name;
      participantRows.push([b.id, p.id, p.name || '', p.phone || '', idx]);
      (p.subPayers || []).forEach(function (sp, spIdx) {
        subPayerRows.push([b.id, p.id, sp.id, sp.name || '', sp.phone || '', Number(sp.amount) || 0, spIdx]);
      });
    });
    b.queue.forEach(function (pid, idx) {
      queueRows.push([b.id, pid, idx]);
    });
    b.history.forEach(function (hEntry, round) {
      historyRows.push([b.id, round, hEntry.collectorId, nameById[hEntry.collectorId] || '', hEntry.monthLabel || '', hEntry.collectedAt || '']);
      var payments = hEntry.payments || {};
      Object.keys(payments).forEach(function (pid) {
        historyPaymentRows.push([b.id, round, pid, payments[pid]]);
      });
    });
    Object.keys(b.currentPayments || {}).forEach(function (pid) {
      currentPaymentRows.push([b.id, pid, b.currentPayments[pid]]);
    });
  });

  writeAllRows_(sheets.batches, batchRows);
  writeAllRows_(sheets.participants, participantRows);
  writeAllRows_(sheets.subPayers, subPayerRows);
  writeAllRows_(sheets.queue, queueRows);
  writeAllRows_(sheets.history, historyRows);
  writeAllRows_(sheets.historyPayments, historyPaymentRows);
  writeAllRows_(sheets.currentPayments, currentPaymentRows);
}

/* ---------------- config / pin ---------------- */

function getConfig_(sheets, key) {
  var rows = sheets.config.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) return rows[i][1];
  }
  return null;
}

function setConfig_(sheets, key, value) {
  var rows = sheets.config.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      sheets.config.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheets.config.appendRow([key, value]);
}

function hashPin_(pin) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'ajoo-ledger:' + String(pin));
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var b = digest[i];
    if (b < 0) b += 256;
    var h = b.toString(16);
    if (h.length < 2) h = '0' + h;
    hex += h;
  }
  return hex;
}

function setPin_(pin) {
  var sheets = ensureSheets_();
  var existing = getConfig_(sheets, 'pinHash');
  if (existing) {
    return { error: 'pin_already_set', message: 'An admin PIN is already set for this ledger.' };
  }
  if (!pin || String(pin).length < 4) {
    return { error: 'pin_too_short', message: 'Use at least 4 digits.' };
  }
  setConfig_(sheets, 'pinHash', hashPin_(pin));
  return { ok: true };
}

function checkPin_(pin) {
  var sheets = ensureSheets_();
  var stored = getConfig_(sheets, 'pinHash');
  if (!stored) {
    return { ok: false, error: 'pin_not_set', message: 'No admin PIN has been set yet.' };
  }
  if (!pin || hashPin_(pin) !== stored) {
    return { ok: false, error: 'wrong_pin', message: 'Incorrect PIN.' };
  }
  return { ok: true };
}

/* ---------------- ledger mutations (ported from the page's own logic) ---------------- */

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Defensive readers for the two month-shaped cells (Batches.startMonth,
// History.monthLabel). ensurePlainTextColumns_ stops NEW writes from ever
// becoming a Sheets Date, but a cell written before this update was applied
// can still hold one — reading it back as Date#toString() is what produced
// "Mon Jun 01 2026 00:00:00 GMT+0100 (West Africa Time)". A Date object
// still carries the correct calendar value it was given, though, so we can
// reconstruct the intended text from it instead of showing the raw dump.
function readStartMonthCell_(val) {
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = val.getMonth() + 1;
    return y + '-' + (m < 10 ? '0' + m : m);
  }
  return String(val || '');
}
function readMonthLabelCell_(val) {
  if (val instanceof Date) {
    return MONTH_NAMES[val.getMonth()] + ' ' + val.getFullYear();
  }
  return String(val || '');
}

function monthLabel_(startMonth, offset) {
  var parts = (startMonth || '').split('-');
  var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1;
  if (isNaN(y) || isNaN(m)) return 'Month ' + (offset + 1);
  var total = m + offset;
  y += Math.floor(total / 12);
  var mi = ((total % 12) + 12) % 12;
  return MONTH_NAMES[mi] + ' ' + y;
}

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function findBatch_(state, id) {
  for (var i = 0; i < state.batches.length; i++) {
    if (state.batches[i].id === id) return state.batches[i];
  }
  return null;
}

// A "slot" (participant) is normally paid by one person, but can be shared by
// two or more sub-payers who together count as that one rotation position.
// payerUnits_ returns whoever actually owes/pays money for a slot: either its
// list of sub-payers, or (for a normal solo slot) the slot itself.
function payerUnits_(p) {
  if (p.subPayers && p.subPayers.length) return p.subPayers;
  return [{ id: p.id, name: p.name, phone: p.phone, amount: undefined }];
}

function buildSlot_(name, phone, subNames, totalAmount) {
  var mainName = String(name || '').trim();
  var subs = (subNames || []).map(function (n) { return String(n || '').trim(); }).filter(function (n) { return !!n; });
  var slot = { id: newId_('p'), name: mainName, phone: String(phone || '').trim() };
  if (subs.length) {
    var allNames = [mainName].concat(subs);
    var share = allNames.length ? (Number(totalAmount) || 0) / allNames.length : 0;
    slot.subPayers = allNames.map(function (n) { return { id: newId_('sp'), name: n, phone: '', amount: share }; });
    slot.name = allNames.join(' & ');
  }
  return slot;
}

function doCreateBatch_(state, draft) {
  var totalAmount = Number(draft.amount) || 0;
  var participants = (draft.participants || []).map(function (p) {
    return buildSlot_(p.name, p.phone, p.subNames, totalAmount);
  });
  var payments = {};
  participants.forEach(function (p) {
    payerUnits_(p).forEach(function (u) { payments[u.id] = 'pending'; });
  });
  var batch = {
    id: newId_('b'),
    name: String(draft.name || '').trim(),
    amount: Number(draft.amount) || 0,
    currency: 'NGN',
    startMonth: draft.startMonth || '',
    createdAt: new Date().toISOString(),
    participants: participants,
    queue: participants.map(function (p) { return p.id; }),
    history: [],
    currentPayments: payments,
    archived: false
  };
  state.batches.unshift(batch);
  return state;
}

function doEditBatch_(state, batchId, name, amount, startMonth) {
  var b = findBatch_(state, batchId);
  if (!b) return state;
  if (name != null) {
    var n = String(name).trim();
    if (n) b.name = n;
  }
  if (amount != null) {
    var a = Number(amount);
    if (!isNaN(a) && a > 0) b.amount = a;
  }
  if (startMonth != null) {
    var sm = String(startMonth).trim();
    if (/^\d{4}-\d{2}$/.test(sm)) {
      b.startMonth = sm;
      // Retroactively relabel every already-collected round too, not just
      // current/upcoming ones — a round's label was frozen at collection time
      // using whatever startMonth existed back then (often blank, hence
      // "Month 1", "Month 2"...). Since rounds always collect in order, round
      // i's real month is simply monthLabel_(startMonth, i).
      (b.history || []).forEach(function (h, idx) {
        h.monthLabel = monthLabel_(sm, idx);
      });
    }
  }
  return state;
}

function doTogglePayment_(state, batchId, payerId) {
  var b = findBatch_(state, batchId);
  if (!b) return state;
  var cur = b.currentPayments[payerId];
  b.currentPayments[payerId] = cur === 'confirmed' ? 'pending' : 'confirmed';
  return state;
}

// Updates (or inserts) just one row of the CurrentPayments sheet, instead of
// the full clear-and-rewrite saveState_() does for every sheet. Used for the
// togglePayment hot path — see api_mutate.
function patchCurrentPayment_(sheets, batchId, payerId, status) {
  var rows = sheets.currentPayments.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(batchId) && String(rows[i][1]) === String(payerId)) {
      sheets.currentPayments.getRange(i + 1, 3).setValue(status);
      return;
    }
  }
  sheets.currentPayments.appendRow([batchId, payerId, status]);
}

function doMarkCollected_(state, batchId) {
  var b = findBatch_(state, batchId);
  if (!b || b.queue.length === 0) return state;
  var collectorId = b.queue[0];
  var idx = b.history.length;
  b.history.push({
    collectorId: collectorId,
    monthLabel: monthLabel_(b.startMonth, idx),
    collectedAt: new Date().toISOString(),
    payments: b.currentPayments
  });
  b.queue = b.queue.slice(1);
  if (b.queue.length > 0) {
    var np = {};
    b.participants.forEach(function (p) {
      payerUnits_(p).forEach(function (u) { np[u.id] = 'pending'; });
    });
    b.currentPayments = np;
  } else {
    b.currentPayments = {};
  }
  return state;
}

function doAddParticipant_(state, batchId, name, phone, subNames) {
  var b = findBatch_(state, batchId);
  if (!b) return state;
  var p = buildSlot_(name, phone, subNames, b.amount);
  b.participants.push(p);
  b.queue.push(p.id);
  if (b.currentPayments && Object.keys(b.currentPayments).length) {
    payerUnits_(p).forEach(function (u) { b.currentPayments[u.id] = 'pending'; });
  }
  return state;
}

function doRemoveParticipant_(state, batchId, participantId) {
  var b = findBatch_(state, batchId);
  if (!b) return state;
  if (b.queue.indexOf(participantId) === -1) return state; // already collected — keep history intact
  var removed = null;
  for (var i = 0; i < b.participants.length; i++) {
    if (b.participants[i].id === participantId) { removed = b.participants[i]; break; }
  }
  b.queue = b.queue.filter(function (id) { return id !== participantId; });
  b.participants = b.participants.filter(function (p) { return p.id !== participantId; });
  if (removed) {
    payerUnits_(removed).forEach(function (u) { delete b.currentPayments[u.id]; });
  }
  return state;
}

function doMoveParticipant_(state, batchId, participantId, dir) {
  var b = findBatch_(state, batchId);
  if (!b) return state;
  var upcoming = b.queue.slice(1);
  var idx = upcoming.indexOf(participantId);
  if (idx === -1) return state;
  var swap = idx + Number(dir);
  if (swap < 0 || swap >= upcoming.length) return state;
  var tmp = upcoming[idx]; upcoming[idx] = upcoming[swap]; upcoming[swap] = tmp;
  b.queue = [b.queue[0]].concat(upcoming);
  return state;
}

function doToggleArchive_(state, batchId) {
  var b = findBatch_(state, batchId);
  if (!b) return state;
  b.archived = !b.archived;
  return state;
}

function doDeleteBatch_(state, batchId) {
  var b = findBatch_(state, batchId);
  if (!b || b.history.length > 0) return state;
  state.batches = state.batches.filter(function (x) { return x.id !== batchId; });
  return state;
}
