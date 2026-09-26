import { google, sheets_v4 } from "googleapis";
import crypto from "crypto";
import type { Batch, HistoryEntry, LedgerState, Participant, PaymentDetails, PaymentStatus, SubPayer } from "./types";
import { MONTH_NAMES, findBatch as findBatchInState } from "./ledger";

/*
 * Server-side Google Sheets storage layer — a faithful port of the
 * Apps-Script version's Code.gs (getState_/saveState_/ensureSheets_ and the
 * doXxx_ mutation functions), adapted to run as Vercel serverless functions
 * talking to the Sheets API with a service account instead of running
 * inside the spreadsheet itself.
 *
 * Same schema, same tab names, same columns — an existing Ajoo Ledger sheet
 * (Apps Script version) works with this without any migration.
 */

const BATCHES_SHEET = "Batches";
const PARTICIPANTS_SHEET = "Participants";
const SUB_PAYERS_SHEET = "SubPayers";
const QUEUE_SHEET = "Queue";
const HISTORY_SHEET = "History";
const HISTORY_PAYMENTS_SHEET = "HistoryPayments";
const CURRENT_PAYMENTS_SHEET = "CurrentPayments";
const CONFIG_SHEET = "Config";

const BATCHES_HEADER = ["id", "name", "amount", "currency", "startMonth", "createdAt", "archived"];
const PARTICIPANTS_HEADER = ["batchId", "participantId", "name", "phone", "order"];
const SUB_PAYERS_HEADER = ["batchId", "participantId", "subPayerId", "name", "phone", "amount", "order"];
const QUEUE_HEADER = ["batchId", "participantId", "queuePosition"];
const HISTORY_HEADER = ["batchId", "round", "collectorId", "collectorName", "monthLabel", "collectedAt"];
const HISTORY_PAYMENTS_HEADER = ["batchId", "round", "participantId", "status"];
const CURRENT_PAYMENTS_HEADER = ["batchId", "participantId", "status"];

type Row = (string | number | boolean)[];

let sheetsClient: sheets_v4.Sheets | null = null;
let sheetIdsCache: Record<string, number> | null = null;
// Once ensureSheets() has successfully run in this serverless instance, the
// tabs/columns it checks can't disappear on their own — skip re-checking on
// every single request. This is the main fix for the Sheets API "read
// requests per minute" quota being blown through: without it, ensureSheets()
// (via ensurePlainTextColumns' getConfig read) was burning an extra Sheets
// API read on every poll, on top of everything else.
let sheetsEnsuredCache = false;

// Short-lived cache for GET reads (page loads, the 45s poll, multiple
// tabs/devices hitting the same warm instance close together). Any
// successful write invalidates it immediately, so it never serves stale
// data after a mutation from this instance — it only saves a round-trip
// when nothing has changed.
const STATE_CACHE_MS = 5000;
let stateCache: { data: LedgerState; ts: number } | null = null;
function invalidateStateCache(): void {
  stateCache = null;
}

function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("GOOGLE_SHEET_ID env var is not set.");
  return id;
}

function getClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY env vars are not set.");
  }
  // Vercel env vars can't hold real newlines cleanly — the key is stored
  // with literal \n escapes and unescaped here.
  key = key.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function getSheetIds(sheets: sheets_v4.Sheets): Promise<Record<string, number>> {
  if (sheetIdsCache) return sheetIdsCache;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId() });
  const map: Record<string, number> = {};
  (meta.data.sheets || []).forEach((s) => {
    if (s.properties?.title != null && s.properties?.sheetId != null) {
      map[s.properties.title] = s.properties.sheetId;
    }
  });
  sheetIdsCache = map;
  return map;
}

async function readRange(sheets: sheets_v4.Sheets, range: string): Promise<Row[]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range, valueRenderOption: "UNFORMATTED_VALUE" });
  return (res.data.values as Row[]) || [];
}

// Reads several ranges in a single Sheets API call instead of one call per
// range. batchGet counts as ONE "read request" against the per-minute quota
// no matter how many ranges it carries, so this is the key lever for
// staying under "Read requests per minute per user" — getState() used to
// spend 7+ separate read requests every time it ran.
async function batchReadRanges(sheets: sheets_v4.Sheets, ranges: string[]): Promise<Row[][]> {
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: getSpreadsheetId(),
    ranges,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const valueRanges = res.data.valueRanges || [];
  return ranges.map((_, i) => (valueRanges[i]?.values as Row[]) || []);
}

async function writeAllRows(sheets: sheets_v4.Sheets, sheetName: string, rows: Row[]): Promise<void> {
  // Mirrors writeAllRows_: clear the sheet, then write everything back in
  // one shot — small data volume, matches the Apps Script version's model.
  await sheets.spreadsheets.values.clear({ spreadsheetId: getSpreadsheetId(), range: sheetName });
  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: getSpreadsheetId(),
      range: sheetName + "!A1",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  }
  invalidateStateCache();
}

// Every column value, padded out to a fixed width so a row missing trailing
// (empty) cells — which the Sheets API omits rather than returning as ""
// — still compares equal to the same row written out in full. Used to tell
// whether a sheet's data actually changed before spending a write on it.
function normalizeRowsForDiff(rows: Row[], width: number): string {
  return JSON.stringify(
    rows.map((r) => {
      const out: Row = [];
      for (let i = 0; i < width; i++) out.push(r[i] ?? "");
      return out;
    })
  );
}

// Skips the clear-and-rewrite entirely when the sheet's data hasn't actually
// changed. Most mutations (toggle archive, edit a name, move someone in the
// queue) only touch one or two of the seven sheets — writing all seven every
// time was the main reason mutations felt slow and occasionally timed out.
async function writeRowsIfChanged(sheets: sheets_v4.Sheets, sheetName: string, newRows: Row[], oldRows: Row[], width: number): Promise<void> {
  if (normalizeRowsForDiff(newRows, width) === normalizeRowsForDiff(oldRows, width)) return;
  await writeAllRows(sheets, sheetName, newRows);
}

async function setPlainTextFormat(sheets: sheets_v4.Sheets, sheetName: string, columnIndex: number): Promise<void> {
  const ids = await getSheetIds(sheets);
  const sheetId = ids[sheetName];
  if (sheetId == null) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
            cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });
}

async function ensureSheetExists(sheets: sheets_v4.Sheets, name: string, header: string[]): Promise<boolean> {
  const ids = await getSheetIds(sheets);
  if (ids[name] != null) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
  });
  sheetIdsCache = null; // force refetch of ids next time
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: name + "!A1",
    valueInputOption: "RAW",
    requestBody: { values: [header] },
  });
  return true;
}

async function ensureSheets(sheets: sheets_v4.Sheets): Promise<void> {
  if (sheetsEnsuredCache) return;
  await ensureSheetExists(sheets, BATCHES_SHEET, BATCHES_HEADER);
  const participantsIsNew = await ensureSheetExists(sheets, PARTICIPANTS_SHEET, PARTICIPANTS_HEADER);
  await ensureSheetExists(sheets, SUB_PAYERS_SHEET, SUB_PAYERS_HEADER);
  await ensureSheetExists(sheets, QUEUE_SHEET, QUEUE_HEADER);
  await ensureSheetExists(sheets, HISTORY_SHEET, HISTORY_HEADER);
  await ensureSheetExists(sheets, HISTORY_PAYMENTS_SHEET, HISTORY_PAYMENTS_HEADER);
  await ensureSheetExists(sheets, CURRENT_PAYMENTS_SHEET, CURRENT_PAYMENTS_HEADER);
  const configIsNew = await ensureSheetExists(sheets, CONFIG_SHEET, ["key", "value"]);
  if (participantsIsNew || configIsNew) {
    // Brand new spreadsheet — nothing to migrate, and ensurePlainTextColumns
    // below will format everything correctly for these fresh sheets anyway.
  }
  await ensurePlainTextColumns(sheets);
  sheetsEnsuredCache = true;
}

// Several columns hold digit-only or date-shaped text ("08012345678",
// "0013943449", "2026-06", "June 2026") that Google Sheets will silently
// reinterpret as a Number or a Date the moment it's written into a
// General-formatted cell — dropping leading zeros, or turning "June 2026"
// into an actual date. Forcing these columns to Plain Text stops it from
// happening on every future write. Tracked with a Config flag so it's a
// one-time cost, not a repeated API call on every request.
async function ensurePlainTextColumns(sheets: sheets_v4.Sheets): Promise<void> {
  if ((await getConfig(sheets, "plainTextFmtV2")) === "done") return;
  await setPlainTextFormat(sheets, PARTICIPANTS_SHEET, 3); // D: phone
  await setPlainTextFormat(sheets, SUB_PAYERS_SHEET, 4); // E: phone
  await setPlainTextFormat(sheets, CONFIG_SHEET, 1); // B: value
  await setPlainTextFormat(sheets, BATCHES_SHEET, 4); // E: startMonth
  await setPlainTextFormat(sheets, HISTORY_SHEET, 4); // E: monthLabel
  await setConfig(sheets, "plainTextFmtV2", "done");
}

// A "YYYY-MM"/"Month Year" cell can still be holding a real Sheets date
// serial (a number, once the sheet API's UNFORMATTED_VALUE mode is used) if
// it was written before ensurePlainTextColumns ran, or by a spreadsheet-side
// edit. Recover the intended text from that serial's own calendar value
// instead of showing raw garbage.
function serialToDate(serial: number): Date {
  // Google Sheets date serials are days since 1899-12-30.
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86400000);
}
function readStartMonthCell(val: unknown): string {
  if (typeof val === "number") {
    const d = serialToDate(val);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    return y + "-" + (m < 10 ? "0" + m : m);
  }
  return String(val ?? "");
}
function readMonthLabelCell(val: unknown): string {
  if (typeof val === "number") {
    const d = serialToDate(val);
    return MONTH_NAMES[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  return String(val ?? "");
}

async function getConfig(sheets: sheets_v4.Sheets, key: string): Promise<string | null> {
  const rows = await readRange(sheets, CONFIG_SHEET);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) return String(rows[i][1] ?? "");
  }
  return null;
}

async function setConfig(sheets: sheets_v4.Sheets, key: string, value: string): Promise<void> {
  const rows = await readRange(sheets, CONFIG_SHEET);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: getSpreadsheetId(),
        range: `${CONFIG_SHEET}!B${i + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] },
      });
      invalidateStateCache();
      return;
    }
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: CONFIG_SHEET,
    valueInputOption: "RAW",
    requestBody: { values: [[key, value]] },
  });
  invalidateStateCache();
}

export function hashPin(pin: string): string {
  return crypto.createHash("sha256").update("ajoo-ledger:" + String(pin)).digest("hex");
}

export interface PinCheckResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function checkPin(pin: string | null | undefined): Promise<PinCheckResult> {
  const sheets = getClient();
  await ensureSheets(sheets);
  const stored = await getConfig(sheets, "pinHash");
  if (!stored) return { ok: false, error: "pin_not_set", message: "No admin PIN has been set yet." };
  if (!pin || hashPin(pin) !== stored) return { ok: false, error: "wrong_pin", message: "Incorrect PIN." };
  return { ok: true };
}

export async function setPin(pin: string): Promise<PinCheckResult> {
  const sheets = getClient();
  await ensureSheets(sheets);
  const existing = await getConfig(sheets, "pinHash");
  if (existing) return { ok: false, error: "pin_already_set", message: "An admin PIN is already set for this ledger." };
  if (!pin || String(pin).length < 4) return { ok: false, error: "pin_too_short", message: "Use at least 4 digits." };
  await setConfig(sheets, "pinHash", hashPin(pin));
  return { ok: true };
}

export async function changePin(oldPin: string, newPin: string): Promise<PinCheckResult> {
  const check = await checkPin(oldPin);
  if (!check.ok) return check;
  if (!newPin || String(newPin).length < 4) return { ok: false, error: "pin_too_short", message: "Use at least 4 digits." };
  const sheets = getClient();
  await setConfig(sheets, "pinHash", hashPin(newPin));
  return { ok: true };
}

export async function setPaymentDetails(pd: PaymentDetails): Promise<void> {
  const sheets = getClient();
  await ensureSheets(sheets);
  await setConfig(sheets, "payAccountNumber", String(pd.accountNumber || "").trim());
  await setConfig(sheets, "payAccountName", String(pd.accountName || "").trim());
  await setConfig(sheets, "payBankName", String(pd.bankName || "").trim());
}

export interface RawRows {
  batchRows: Row[];
  pRows: Row[];
  spRows: Row[];
  qRows: Row[];
  hRows: Row[];
  hpRows: Row[];
  cpRows: Row[];
}

// The uncached read: always hits the Sheets API for a fresh snapshot, and
// hands back the raw rows alongside the parsed state so a mutation can later
// diff against exactly what it started from (see saveStateDiff).
async function getStateAndRaw(): Promise<{ state: LedgerState; raw: RawRows }> {
  const sheets = getClient();
  await ensureSheets(sheets);

  const [batchRows, pRows, spRows, qRows, hRows, hpRows, cpRows, configRows] = await batchReadRanges(sheets, [
    BATCHES_SHEET,
    PARTICIPANTS_SHEET,
    SUB_PAYERS_SHEET,
    QUEUE_SHEET,
    HISTORY_SHEET,
    HISTORY_PAYMENTS_SHEET,
    CURRENT_PAYMENTS_SHEET,
    CONFIG_SHEET,
  ]);

  const batchesById: Record<string, Batch> = {};
  const order: string[] = [];
  for (let i = 1; i < batchRows.length; i++) {
    const r = batchRows[i];
    if (!r[0]) continue;
    const id = String(r[0]);
    batchesById[id] = {
      id,
      name: String(r[1] || ""),
      amount: Number(r[2]) || 0,
      currency: String(r[3] || "NGN"),
      startMonth: readStartMonthCell(r[4]),
      createdAt: String(r[5] || ""),
      archived: r[6] === true || r[6] === "TRUE",
      participants: [],
      queue: [],
      history: [],
      currentPayments: {},
    };
    order.push(id);
  }

  const participantsByBatch: Record<string, { order: number; p: Participant }[]> = {};
  for (let i = 1; i < pRows.length; i++) {
    const r = pRows[i];
    if (!r[0] || !batchesById[String(r[0])]) continue;
    const bid = String(r[0]);
    (participantsByBatch[bid] = participantsByBatch[bid] || []).push({
      order: Number(r[4]) || 0,
      p: { id: String(r[1]), name: String(r[2] || ""), phone: String(r[3] || "") },
    });
  }
  Object.keys(participantsByBatch).forEach((bid) => {
    const arr = participantsByBatch[bid].sort((a, b) => a.order - b.order);
    batchesById[bid].participants = arr.map((x) => x.p);
  });

  const participantIndexByBatch: Record<string, Record<string, Participant>> = {};
  Object.keys(batchesById).forEach((bid) => {
    const idx: Record<string, Participant> = {};
    batchesById[bid].participants.forEach((p) => (idx[p.id] = p));
    participantIndexByBatch[bid] = idx;
  });

  const subPayersByBatchParticipant: Record<string, { order: number; sp: SubPayer }[]> = {};
  for (let i = 1; i < spRows.length; i++) {
    const r = spRows[i];
    if (!r[0] || !batchesById[String(r[0])]) continue;
    const bid = String(r[0]);
    const key = bid + "|" + String(r[1]);
    (subPayersByBatchParticipant[key] = subPayersByBatchParticipant[key] || []).push({
      order: Number(r[6]) || 0,
      sp: { id: String(r[2]), name: String(r[3] || ""), phone: String(r[4] || ""), amount: Number(r[5]) || 0 },
    });
  }
  Object.keys(subPayersByBatchParticipant).forEach((key) => {
    const [bid, pid] = key.split("|");
    const participant = participantIndexByBatch[bid]?.[pid];
    if (!participant) return;
    const arr = subPayersByBatchParticipant[key].sort((a, b) => a.order - b.order);
    participant.subPayers = arr.map((x) => x.sp);
  });

  const queueByBatch: Record<string, { pos: number; id: string }[]> = {};
  for (let i = 1; i < qRows.length; i++) {
    const r = qRows[i];
    if (!r[0] || !batchesById[String(r[0])]) continue;
    const bid = String(r[0]);
    (queueByBatch[bid] = queueByBatch[bid] || []).push({ pos: Number(r[2]) || 0, id: String(r[1]) });
  }
  Object.keys(queueByBatch).forEach((bid) => {
    const arr = queueByBatch[bid].sort((a, b) => a.pos - b.pos);
    batchesById[bid].queue = arr.map((x) => x.id);
  });

  const historyByBatch: Record<string, { round: number; collectorId: string; monthLabel: string; collectedAt: string }[]> = {};
  for (let i = 1; i < hRows.length; i++) {
    const r = hRows[i];
    if (r[0] === "" || r[0] == null || !batchesById[String(r[0])]) continue;
    const bid = String(r[0]);
    (historyByBatch[bid] = historyByBatch[bid] || []).push({
      round: Number(r[1]) || 0,
      collectorId: String(r[2]),
      monthLabel: readMonthLabelCell(r[4]),
      collectedAt: String(r[5] || ""),
    });
  }

  const paymentsByBatchRound: Record<string, Record<string, string>> = {};
  for (let i = 1; i < hpRows.length; i++) {
    const r = hpRows[i];
    if (r[0] === "" || r[0] == null) continue;
    const key = String(r[0]) + "|" + (Number(r[1]) || 0);
    (paymentsByBatchRound[key] = paymentsByBatchRound[key] || {})[String(r[2])] = String(r[3] || "pending");
  }

  Object.keys(historyByBatch).forEach((bid) => {
    const arr = historyByBatch[bid].sort((a, b) => a.round - b.round);
    batchesById[bid].history = arr.map((x): HistoryEntry => ({
      collectorId: x.collectorId,
      monthLabel: x.monthLabel,
      collectedAt: x.collectedAt,
      payments: paymentsByBatchRound[bid + "|" + x.round] || {},
    }));
  });

  const curByBatch: Record<string, Record<string, PaymentStatus | string>> = {};
  for (let i = 1; i < cpRows.length; i++) {
    const r = cpRows[i];
    if (r[0] === "" || r[0] == null || !batchesById[String(r[0])]) continue;
    const bid = String(r[0]);
    (curByBatch[bid] = curByBatch[bid] || {})[String(r[1])] = String(r[2] || "pending");
  }
  order.forEach((bid) => (batchesById[bid].currentPayments = curByBatch[bid] || {}));

  const batches = order.map((id) => batchesById[id]);
  batches.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const configMap: Record<string, string> = {};
  for (let i = 1; i < configRows.length; i++) {
    const r = configRows[i];
    if (r[0] != null && r[0] !== "") configMap[String(r[0])] = String(r[1] ?? "");
  }

  const raw: RawRows = { batchRows, pRows, spRows, qRows, hRows, hpRows, cpRows };

  const state: LedgerState = {
    batches,
    pinSet: !!configMap["pinHash"],
    paymentDetails: {
      accountNumber: configMap["payAccountNumber"] || "",
      accountName: configMap["payAccountName"] || "",
      bankName: configMap["payBankName"] || "",
    },
  };

  return { state, raw };
}

// Cached read for plain page loads and the client's poll — served instantly
// when nothing has changed since the last read in this warm instance, since
// invalidateStateCache() clears it the moment any write actually happens.
export async function getState(): Promise<LedgerState> {
  if (stateCache && Date.now() - stateCache.ts < STATE_CACHE_MS) return stateCache.data;
  const { state } = await getStateAndRaw();
  stateCache = { data: state, ts: Date.now() };
  return state;
}

// Used by the mutate route: needs a guaranteed-fresh snapshot to mutate
// (never the cache) plus the raw rows to diff the save against.
export async function getFreshStateForMutation(): Promise<{ state: LedgerState; raw: RawRows }> {
  return getStateAndRaw();
}

function buildRowsFromState(state: LedgerState) {
  const batchRows: Row[] = [BATCHES_HEADER];
  const participantRows: Row[] = [PARTICIPANTS_HEADER];
  const subPayerRows: Row[] = [SUB_PAYERS_HEADER];
  const queueRows: Row[] = [QUEUE_HEADER];
  const historyRows: Row[] = [HISTORY_HEADER];
  const historyPaymentRows: Row[] = [HISTORY_PAYMENTS_HEADER];
  const currentPaymentRows: Row[] = [CURRENT_PAYMENTS_HEADER];

  state.batches.forEach((b) => {
    batchRows.push([b.id, b.name, b.amount, b.currency, b.startMonth, b.createdAt, !!b.archived]);
    const nameById: Record<string, string> = {};
    b.participants.forEach((p, idx) => {
      nameById[p.id] = p.name;
      participantRows.push([b.id, p.id, p.name || "", p.phone || "", idx]);
      (p.subPayers || []).forEach((sp, spIdx) => {
        subPayerRows.push([b.id, p.id, sp.id, sp.name || "", sp.phone || "", Number(sp.amount) || 0, spIdx]);
      });
    });
    b.queue.forEach((pid, idx) => queueRows.push([b.id, pid, idx]));
    b.history.forEach((hEntry, round) => {
      historyRows.push([b.id, round, hEntry.collectorId, nameById[hEntry.collectorId] || "", hEntry.monthLabel || "", hEntry.collectedAt || ""]);
      const payments = hEntry.payments || {};
      Object.keys(payments).forEach((pid) => historyPaymentRows.push([b.id, round, pid, payments[pid]]));
    });
    Object.keys(b.currentPayments || {}).forEach((pid) => currentPaymentRows.push([b.id, pid, b.currentPayments[pid]]));
  });

  return { batchRows, participantRows, subPayerRows, queueRows, historyRows, historyPaymentRows, currentPaymentRows };
}

export async function saveState(state: LedgerState): Promise<void> {
  const sheets = getClient();
  await ensureSheets(sheets);
  const { batchRows, participantRows, subPayerRows, queueRows, historyRows, historyPaymentRows, currentPaymentRows } = buildRowsFromState(state);

  await Promise.all([
    writeAllRows(sheets, BATCHES_SHEET, batchRows),
    writeAllRows(sheets, PARTICIPANTS_SHEET, participantRows),
    writeAllRows(sheets, SUB_PAYERS_SHEET, subPayerRows),
    writeAllRows(sheets, QUEUE_SHEET, queueRows),
    writeAllRows(sheets, HISTORY_SHEET, historyRows),
    writeAllRows(sheets, HISTORY_PAYMENTS_SHEET, historyPaymentRows),
    writeAllRows(sheets, CURRENT_PAYMENTS_SHEET, currentPaymentRows),
  ]);
}

// Fast path for every mutation except togglePayment (which has its own
// single-cell patch below): only the sheets whose rows actually changed get
// cleared and rewritten, instead of all seven every time. Editing a batch
// name, for instance, used to rewrite Participants, SubPayers, Queue,
// History, HistoryPayments and CurrentPayments even though none of them
// changed — this is what was making ordinary actions slow enough to
// occasionally hit the serverless function's timeout ("Server error").
export async function saveStateDiff(state: LedgerState, raw: RawRows): Promise<void> {
  const sheets = getClient();
  await ensureSheets(sheets);
  const { batchRows, participantRows, subPayerRows, queueRows, historyRows, historyPaymentRows, currentPaymentRows } = buildRowsFromState(state);

  await Promise.all([
    writeRowsIfChanged(sheets, BATCHES_SHEET, batchRows, raw.batchRows, BATCHES_HEADER.length),
    writeRowsIfChanged(sheets, PARTICIPANTS_SHEET, participantRows, raw.pRows, PARTICIPANTS_HEADER.length),
    writeRowsIfChanged(sheets, SUB_PAYERS_SHEET, subPayerRows, raw.spRows, SUB_PAYERS_HEADER.length),
    writeRowsIfChanged(sheets, QUEUE_SHEET, queueRows, raw.qRows, QUEUE_HEADER.length),
    writeRowsIfChanged(sheets, HISTORY_SHEET, historyRows, raw.hRows, HISTORY_HEADER.length),
    writeRowsIfChanged(sheets, HISTORY_PAYMENTS_SHEET, historyPaymentRows, raw.hpRows, HISTORY_PAYMENTS_HEADER.length),
    writeRowsIfChanged(sheets, CURRENT_PAYMENTS_SHEET, currentPaymentRows, raw.cpRows, CURRENT_PAYMENTS_HEADER.length),
  ]);
}

// Fast path for togglePayment: patch just the one changed cell instead of
// the full clear-and-rewrite saveState() does for every sheet.
export async function patchCurrentPayment(batchId: string, payerId: string, status: string): Promise<void> {
  const sheets = getClient();
  const rows = await readRange(sheets, CURRENT_PAYMENTS_SHEET);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(batchId) && String(rows[i][1]) === String(payerId)) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: getSpreadsheetId(),
        range: `${CURRENT_PAYMENTS_SHEET}!C${i + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[status]] },
      });
      invalidateStateCache();
      return;
    }
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: CURRENT_PAYMENTS_SHEET,
    valueInputOption: "RAW",
    requestBody: { values: [[batchId, payerId, status]] },
  });
  invalidateStateCache();
}

export { findBatchInState as findBatch };
