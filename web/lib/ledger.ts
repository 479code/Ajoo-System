// Pure ledger logic shared between the API routes (server) and the UI
// (client). This is a direct port of the payer-units / percentage / share-
// text logic that used to live inline in Index.html and Code.gs — kept in
// one place here so the server and the UI can never drift out of sync with
// each other the way two separate copies could.

import type { Batch, HistoryEntry, Participant, PaymentDetails, PaymentStatus } from "./types";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const AVATAR_COLORS = [
  "#0B6E82", "#B8791C", "#7A6FD1", "#C4548C", "#2E7D46", "#B3372A", "#3E7CB1", "#8A6D3B",
];

// Emoji are built from their numeric code points instead of embedded as
// literal glyphs anywhere in the source — including comments. Google Apps
// Script's editor has a known bug where 4-byte ("astral") Unicode
// characters, which is what most emoji are, get mangled into replacement
// boxes when pasted in. That code is gone in this app (there's no paste-into-
// an-editor step for a deployed web app), but we keep the same safe pattern
// since it costs nothing and this file's logic is a direct port of code that
// depended on it.
export const SYM = {
  crown: String.fromCodePoint(0x1f478),
  dancer: String.fromCodePoint(0x1f483),
  skinLight: String.fromCodePoint(0x1f3fb),
  party: String.fromCodePoint(0x1f389),
  person: String.fromCodePoint(0x1f464),
  people: String.fromCodePoint(0x1f465),
  chart: String.fromCodePoint(0x1f4ca),
  locked: String.fromCodePoint(0x1f512),
  unlocked: String.fromCodePoint(0x1f513),
  check: String.fromCodePoint(0x2705),
};
export const DANCER_TAG = SYM.crown + SYM.dancer + SYM.skinLight;

export function money(n: number): string {
  const v = Math.round(Number(n) || 0);
  return "₦" + v.toLocaleString();
}

export function shortAmount(n: number): string {
  n = Math.round(Number(n) || 0);
  if (n >= 1000 && n % 1000 === 0) return n / 1000 + "k";
  return n.toLocaleString();
}

// A "YYYY-MM" string offset by `offset` months -> a real month name, e.g.
// monthLabel("2026-01", 2) === "March 2026". Falls back to a generic
// "Month N" label when startMonth isn't set/valid yet.
export function monthLabel(startMonth: string | null | undefined, offset: number): string {
  const parts = (startMonth || "").split("-");
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  if (isNaN(y) || isNaN(m)) return "Month " + (offset + 1);
  const total = m + offset;
  const yy = y + Math.floor(total / 12);
  const mi = ((total % 12) + 12) % 12;
  return MONTH_NAMES[mi] + " " + yy;
}

export function defaultNextMonth(): string {
  const d = new Date();
  // Pure integer month arithmetic — avoids the day-overflow bug where
  // Date#setMonth() rolls forward an extra month on the 29th-31st.
  const totalMonths = d.getFullYear() * 12 + d.getMonth() + 1;
  const y = Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  return y + "-" + (m < 10 ? "0" + m : String(m));
}

export function initials(name: string): string {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((w) => w.charAt(0).toUpperCase()).join("") || "?";
}

export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function findBatch(state: { batches: Batch[] }, id: string | null | undefined): Batch | undefined {
  return state.batches.find((b) => b.id === id);
}

export function participantById(batch: Batch, id: string | null | undefined): Participant {
  return batch.participants.find((p) => p.id === id) || { id: id || "", name: "(removed)", phone: "" };
}

export function isComplete(b: Batch): boolean {
  return b.queue.length === 0;
}

export function currentCollectorId(b: Batch): string | null {
  return b.queue.length ? b.queue[0] : null;
}

export function confirmedCount(b: Batch): number {
  return Object.values(b.currentPayments || {}).filter((v) => v === "confirmed").length;
}

export function currentTotalUnits(b: Batch): number {
  return Object.keys(b.currentPayments || {}).length;
}

// A "slot" (participant) is normally paid by one person, but can be shared
// by two or more sub-payers who together count as that one rotation
// position. payerUnits returns whoever actually owes/pays money for a
// slot: either its list of sub-payers, or (for a normal solo slot) the slot
// itself.
export interface PayerUnit {
  id: string;
  name: string;
  phone: string;
  amount?: number;
}
export function payerUnits(p: Participant): PayerUnit[] {
  if (p.subPayers && p.subPayers.length) return p.subPayers;
  return [{ id: p.id, name: p.name, phone: p.phone, amount: undefined }];
}

export function unitAmount(b: Batch, u: PayerUnit): number {
  return u.amount === undefined || u.amount === null ? b.amount : Number(u.amount) || 0;
}

export function totalPayerUnits(b: Batch): number {
  let n = 0;
  b.participants.forEach((p) => (n += payerUnits(p).length));
  return n;
}

export function roundMoneyStats(b: Batch): { expected: number; confirmed: number; pct: number } {
  let expected = 0;
  let confirmedAmt = 0;
  const cp = b.currentPayments || {};
  b.participants.forEach((p) => {
    payerUnits(p).forEach((u) => {
      if (!(u.id in cp)) return;
      const amt = unitAmount(b, u);
      expected += amt;
      if (cp[u.id] === "confirmed") confirmedAmt += amt;
    });
  });
  return { expected, confirmed: confirmedAmt, pct: expected ? Math.round((confirmedAmt / expected) * 100) : 0 };
}

export function cyclePct(b: Batch): number {
  return b.participants.length ? Math.round((b.history.length / b.participants.length) * 100) : 0;
}

export function newId(prefix: string): string {
  const rand = () => Math.floor(Math.random() * 16).toString(16);
  let s = "";
  for (let i = 0; i < 12; i++) s += rand();
  return prefix + "_" + s;
}

export function buildSlot(name: string, phone: string, subNames: string[] | undefined, totalAmount: number): Participant {
  const mainName = String(name || "").trim();
  const subs = (subNames || []).map((n) => String(n || "").trim()).filter(Boolean);
  const slot: Participant = { id: newId("p"), name: mainName, phone: String(phone || "").trim() };
  if (subs.length) {
    const allNames = [mainName, ...subs];
    const share = allNames.length ? (Number(totalAmount) || 0) / allNames.length : 0;
    slot.subPayers = allNames.map((n) => ({ id: newId("sp"), name: n, phone: "", amount: share }));
    slot.name = allNames.join(" & ");
  }
  return slot;
}

export interface ScheduleRow {
  label: string;
  collectorId: string;
  done: boolean;
  payments: Record<string, PaymentStatus | string> | null;
}

export function buildScheduleRows(b: Batch): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  b.history.forEach((hEntry: HistoryEntry) => {
    rows.push({ label: hEntry.monthLabel, collectorId: hEntry.collectorId, done: true, payments: hEntry.payments || {} });
  });
  if (b.queue.length) {
    rows.push({ label: monthLabel(b.startMonth, b.history.length), collectorId: b.queue[0], done: false, payments: b.currentPayments || {} });
    b.queue.slice(1).forEach((pid, i) => {
      rows.push({ label: monthLabel(b.startMonth, b.history.length + 1 + i), collectorId: pid, done: false, payments: null });
    });
  }
  return rows;
}

export type ShareStyle = "decorative" | "clean";

export function buildShareText(b: Batch, style: ShareStyle, pd: PaymentDetails | null | undefined): string {
  const rows = buildScheduleRows(b);
  const startLabel = monthLabel(b.startMonth, 0);
  const endLabel = monthLabel(b.startMonth, Math.max(b.participants.length - 1, 0));
  const startYear = startLabel.split(" ").pop();
  const endYear = endLabel.split(" ").pop();
  const startPart = startYear === endYear ? startLabel.split(" ")[0] : startLabel;
  const dateRange = startPart + " to " + endLabel;
  const letters = "ABCDEFGH";
  const lines: string[] = [];
  lines.push("*" + b.name + "*");
  lines.push("*" + dateRange + "*");
  lines.push("");
  const cp = cyclePct(b);
  lines.push(
    style === "decorative"
      ? SYM.chart + " " + b.history.length + " of " + b.participants.length + " rounds complete (" + cp + "%)"
      : b.history.length + "/" + b.participants.length + " rounds complete (" + cp + "%)"
  );
  lines.push("");
  rows.forEach((r, i) => {
    const p = participantById(b, r.collectorId);
    const units = payerUnits(p);
    if (style === "decorative") {
      lines.push("(" + (i + 1) + ") " + r.label);
      if (units.length > 1) {
        units.forEach((u, ui) => {
          const amtU = shortAmount(unitAmount(b, u));
          const paidU = !!(r.payments && r.payments[u.id] === "confirmed");
          lines.push("(" + letters.charAt(ui) + ")" + u.name + " " + amtU + DANCER_TAG + (paidU ? SYM.check : ""));
        });
      } else {
        const amt = shortAmount(unitAmount(b, units[0]));
        const paid = r.payments ? r.payments[units[0].id] === "confirmed" : r.done;
        lines.push(p.name + " " + amt + DANCER_TAG + (paid ? SYM.check : ""));
      }
    } else {
      if (units.length > 1) {
        lines.push(i + 1 + ". " + r.label + " — " + p.name);
        units.forEach((u, ui) => {
          const amtU2 = shortAmount(unitAmount(b, u));
          const paidU2 = !!(r.payments && r.payments[u.id] === "confirmed");
          lines.push("   (" + letters.charAt(ui) + ") " + u.name + " — ₦" + amtU2 + " — " + (paidU2 ? "PAID" : "PENDING"));
        });
      } else {
        const amt2 = shortAmount(unitAmount(b, units[0]));
        const paid2 = r.payments ? r.payments[units[0].id] === "confirmed" : r.done;
        lines.push(i + 1 + ". " + r.label + " — " + p.name + " — ₦" + amt2 + " — " + (paid2 ? "PAID" : "PENDING"));
      }
    }
    lines.push("");
  });
  if (pd && (pd.accountNumber || pd.accountName || pd.bankName)) {
    if (style === "decorative") {
      if (pd.accountNumber) lines.push("*" + pd.accountNumber + "*");
      if (pd.accountName) lines.push("*" + pd.accountName + "*");
      if (pd.bankName) lines.push("*" + pd.bankName + "*");
    } else {
      if (pd.accountNumber) lines.push("Account: " + pd.accountNumber);
      if (pd.accountName) lines.push("Name: " + pd.accountName);
      if (pd.bankName) lines.push("Bank: " + pd.bankName);
    }
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/* ---------------- mutations (same semantics as Code.gs's doXxx_ functions) ---------------- */

export interface CreateBatchDraft {
  name: string;
  amount: number | string;
  startMonth: string;
  participants: { name: string; phone?: string; subNames?: string[] }[];
}

export function doCreateBatch(state: { batches: Batch[] }, draft: CreateBatchDraft): Batch {
  const totalAmount = Number(draft.amount) || 0;
  const participants = (draft.participants || []).map((p) => buildSlot(p.name, p.phone || "", p.subNames, totalAmount));
  const payments: Record<string, PaymentStatus> = {};
  participants.forEach((p) => payerUnits(p).forEach((u) => (payments[u.id] = "pending")));
  const batch: Batch = {
    id: newId("b"),
    name: String(draft.name || "").trim(),
    amount: totalAmount,
    currency: "NGN",
    startMonth: draft.startMonth || "",
    createdAt: new Date().toISOString(),
    participants,
    queue: participants.map((p) => p.id),
    history: [],
    currentPayments: payments,
    archived: false,
  };
  state.batches.unshift(batch);
  return batch;
}

export function doEditBatch(
  state: { batches: Batch[] },
  batchId: string,
  name: string | null | undefined,
  amount: number | string | null | undefined,
  startMonth: string | null | undefined
): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b) return undefined;
  if (name != null) {
    const n = String(name).trim();
    if (n) b.name = n;
  }
  if (amount != null) {
    const a = Number(amount);
    if (!isNaN(a) && a > 0) b.amount = a;
  }
  if (startMonth != null) {
    const sm = String(startMonth).trim();
    if (/^\d{4}-\d{2}$/.test(sm)) {
      b.startMonth = sm;
      // Retroactively relabel every already-collected round too — a round's
      // label was frozen at collection time using whatever startMonth
      // existed back then (often blank). Rounds always collect in order, so
      // round i's real month is simply monthLabel(startMonth, i).
      (b.history || []).forEach((h, idx) => {
        h.monthLabel = monthLabel(sm, idx);
      });
    }
  }
  return b;
}

export function doTogglePayment(state: { batches: Batch[] }, batchId: string, payerId: string): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b) return undefined;
  const cur = b.currentPayments[payerId];
  b.currentPayments[payerId] = cur === "confirmed" ? "pending" : "confirmed";
  return b;
}

export function doMarkCollected(state: { batches: Batch[] }, batchId: string): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b || b.queue.length === 0) return b;
  const collectorId = b.queue[0];
  const idx = b.history.length;
  b.history.push({
    collectorId,
    monthLabel: monthLabel(b.startMonth, idx),
    collectedAt: new Date().toISOString(),
    payments: b.currentPayments,
  });
  b.queue = b.queue.slice(1);
  if (b.queue.length > 0) {
    const np: Record<string, PaymentStatus> = {};
    b.participants.forEach((p) => payerUnits(p).forEach((u) => (np[u.id] = "pending")));
    b.currentPayments = np;
  } else {
    b.currentPayments = {};
  }
  return b;
}

export function doAddParticipant(
  state: { batches: Batch[] },
  batchId: string,
  name: string,
  phone: string,
  subNames: string[] | undefined
): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b) return undefined;
  const p = buildSlot(name, phone, subNames, b.amount);
  b.participants.push(p);
  b.queue.push(p.id);
  if (b.currentPayments && Object.keys(b.currentPayments).length) {
    payerUnits(p).forEach((u) => (b.currentPayments[u.id] = "pending"));
  }
  return b;
}

export function doRemoveParticipant(state: { batches: Batch[] }, batchId: string, participantId: string): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b) return undefined;
  if (b.queue.indexOf(participantId) === -1) return b; // already collected — keep history intact
  const removed = b.participants.find((p) => p.id === participantId);
  b.queue = b.queue.filter((id) => id !== participantId);
  b.participants = b.participants.filter((p) => p.id !== participantId);
  if (removed) {
    payerUnits(removed).forEach((u) => {
      delete b.currentPayments[u.id];
    });
  }
  return b;
}

export function doMoveParticipant(state: { batches: Batch[] }, batchId: string, participantId: string, dir: number): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b) return undefined;
  const upcoming = b.queue.slice(1);
  const idx = upcoming.indexOf(participantId);
  if (idx === -1) return b;
  const swap = idx + Number(dir);
  if (swap < 0 || swap >= upcoming.length) return b;
  const tmp = upcoming[idx];
  upcoming[idx] = upcoming[swap];
  upcoming[swap] = tmp;
  b.queue = [b.queue[0], ...upcoming];
  return b;
}

export function doToggleArchive(state: { batches: Batch[] }, batchId: string): Batch | undefined {
  const b = findBatch(state, batchId);
  if (!b) return undefined;
  b.archived = !b.archived;
  return b;
}

// Returns { ok: true } or { ok: false, reason } — a batch with any collected
// history is never deleted outright, to protect real records.
export function doDeleteBatch(state: { batches: Batch[] }, batchId: string): { ok: boolean; reason?: string } {
  const b = findBatch(state, batchId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.history.length > 0) return { ok: false, reason: "has_history" };
  state.batches = state.batches.filter((x) => x.id !== batchId);
  return { ok: true };
}
