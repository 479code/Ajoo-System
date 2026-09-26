"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import {
  AdminModal,
  ChangePinModal,
  EditBatchModal,
  NewBatchModal,
  PaymentDetailsModal,
  ShareModal,
} from "@/components/Modals";
import { getState, mutate as mutateApi, changePin as changePinApi, setPin as setPinApi, verifyPin as verifyPinApi, savePaymentDetails as savePaymentDetailsApi } from "@/lib/api";
import {
  SYM,
  buildShareText,
  confirmedCount,
  currentCollectorId,
  currentTotalUnits,
  cyclePct,
  defaultNextMonth,
  findBatch,
  isComplete,
  money,
  monthLabel,
  participantById,
  payerUnits,
  roundMoneyStats,
  totalPayerUnits,
  unitAmount,
  type ShareStyle,
} from "@/lib/ledger";
import type {
  AddParticipantDraft,
  Batch,
  ChangePinDraft,
  EditBatchDraft,
  LedgerState,
  NewBatchDraft,
  PaymentDetails,
} from "@/lib/types";

const PIN_STORAGE_KEY = "ajooAdminPin";
// Each poll now costs one Sheets API read request (batched server-side), but
// several people/tabs polling at once still adds up against the per-minute
// quota, so this stays comfortably spaced out.
const REFRESH_MS = 45000;

type Filter = "all" | "active" | "completed" | "archived";

interface PendingAction {
  action: string;
  payload: Record<string, unknown>;
  successMsg?: string;
}

interface UIState {
  view: "home" | "batch";
  batchId: string | null;
  search: string;
  filter: Filter;
  showNewBatch: boolean;
  newBatchDraft: NewBatchDraft | null;
  addParticipantOpenFor: string | null;
  addParticipantDraft: AddParticipantDraft;
  confirmCollectFor: string | null;
  confirmDeleteFor: string | null;
  showAdminModal: boolean;
  adminPinInput: string;
  pendingAction: PendingAction | null;
  pendingCustomAction: ((pin: string) => void) | null;
  showEditBatch: boolean;
  editBatchDraft: EditBatchDraft | null;
  showChangePin: boolean;
  changePinDraft: ChangePinDraft;
  showPaymentDetails: boolean;
  paymentDetailsDraft: PaymentDetails;
  showShareFor: string | null;
  shareStyle: ShareStyle;
}

const initialUi: UIState = {
  view: "home",
  batchId: null,
  search: "",
  filter: "all",
  showNewBatch: false,
  newBatchDraft: null,
  addParticipantOpenFor: null,
  addParticipantDraft: { name: "", phone: "", subNames: [], copayerOpen: false },
  confirmCollectFor: null,
  confirmDeleteFor: null,
  showAdminModal: false,
  adminPinInput: "",
  pendingAction: null,
  pendingCustomAction: null,
  showEditBatch: false,
  editBatchDraft: null,
  showChangePin: false,
  changePinDraft: { newPin: "", confirmPin: "" },
  showPaymentDetails: false,
  paymentDetailsDraft: { accountNumber: "", accountName: "", bankName: "" },
  showShareFor: null,
  shareStyle: "decorative",
};

export default function AjooApp() {
  const [ledger, setLedger] = useState<LedgerState | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adminPin, setAdminPin] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(PIN_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [adminUnlocked, setAdminUnlocked] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return !!localStorage.getItem(PIN_STORAGE_KEY);
    } catch {
      return false;
    }
  });
  const [ui, setUi] = useState<UIState>(initialUi);
  const [toastMsg, setToastMsg] = useState("");
  const [toastVisible, setToastVisible] = useState(false);

  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  }, [ui]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastVisible(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 3000);
  }, []);

  function patchUi(partial: Partial<UIState>) {
    setUi((prev) => ({ ...prev, ...partial }));
  }

  function clearAdmin() {
    setAdminUnlocked(false);
    setAdminPin(null);
    try {
      localStorage.removeItem(PIN_STORAGE_KEY);
    } catch {}
  }

  const refreshLedger = useCallback(async () => {
    try {
      const data = await getState();
      setLedger(data);
      setLoadedOnce(true);
    } catch (err) {
      toast("Could not load the sheet" + (err instanceof Error ? ": " + err.message : "."));
    }
  }, [toast]);

  useEffect(() => {
    const kickOff = () => {
      refreshLedger();
    };
    kickOff();
    const interval = setInterval(() => {
      const active = document.activeElement;
      const typing = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (!typing && !uiRef.current.showNewBatch && !uiRef.current.showAdminModal) {
        refreshLedger();
      }
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [refreshLedger]);

  /* ---------- admin PIN gate ---------- */
  function openAdminModal() {
    patchUi({ showAdminModal: true, adminPinInput: "" });
  }
  function closeAdminModal() {
    patchUi({ showAdminModal: false, pendingAction: null, pendingCustomAction: null });
  }
  async function submitAdminPin() {
    const pin = ui.adminPinInput.trim();
    if (!pin) {
      toast("Enter a PIN.");
      return;
    }
    if (busy) return;
    const pinWasSet = !!ledger?.pinSet;
    setBusy(true);
    try {
      const res = pinWasSet ? await verifyPinApi(pin) : await setPinApi(pin);
      setBusy(false);
      if (res.error) {
        toast(res.message || "That didn't work — try again.");
        return;
      }
      setAdminUnlocked(true);
      setAdminPin(pin);
      setLedger((prev) => (prev ? { ...prev, pinSet: true } : prev));
      try {
        localStorage.setItem(PIN_STORAGE_KEY, pin);
      } catch {}
      const pending = ui.pendingAction;
      const pendingCustom = ui.pendingCustomAction;
      patchUi({ showAdminModal: false, pendingAction: null, pendingCustomAction: null });
      toast(pinWasSet ? "Admin unlocked." : "Admin PIN set.");
      if (pending) performMutate(pending.action, pending.payload, pending.successMsg, pin);
      else if (pendingCustom) pendingCustom(pin);
    } catch {
      setBusy(false);
      toast("Server error — try again.");
    }
  }
  function exitAdminMode() {
    clearAdmin();
    toast("Exited admin mode.");
  }

  async function submitChangePin() {
    const newPin = (ui.changePinDraft.newPin || "").trim();
    const confirmPin = (ui.changePinDraft.confirmPin || "").trim();
    if (!newPin || newPin.length < 4) {
      toast("Use at least 4 digits.");
      return;
    }
    if (newPin !== confirmPin) {
      toast("PINs don't match.");
      return;
    }
    if (busy || !adminPin) return;
    setBusy(true);
    try {
      const res = await changePinApi(adminPin, newPin);
      setBusy(false);
      if (res.error) {
        if (res.error === "wrong_pin") {
          clearAdmin();
          toast("Your admin PIN didn't work — enter it again.");
        } else {
          toast(res.message || "Could not change PIN.");
        }
        patchUi({ showChangePin: false });
        return;
      }
      setAdminPin(newPin);
      try {
        localStorage.setItem(PIN_STORAGE_KEY, newPin);
      } catch {}
      patchUi({ showChangePin: false });
      toast("Admin PIN changed.");
    } catch {
      setBusy(false);
      toast("Server error — try again.");
    }
  }

  /* ---------- ledger mutations ---------- */
  function mutateGated(action: string, payload: Record<string, unknown>, successMsg?: string) {
    if (busy) return;
    if (!adminUnlocked || !adminPin) {
      patchUi({ pendingAction: { action, payload, successMsg }, adminPinInput: "" });
      openAdminModal();
      return;
    }
    performMutate(action, payload, successMsg, adminPin);
  }

  async function performMutate(action: string, payload: Record<string, unknown>, successMsg: string | undefined, pin: string) {
    setBusy(true);
    try {
      const res = await mutateApi(action, pin, payload);
      setBusy(false);
      if (res.error) {
        if (res.error === "wrong_pin" || res.error === "pin_not_set") {
          clearAdmin();
          toast("Your admin PIN didn't work — enter it again.");
          patchUi({ pendingAction: { action, payload, successMsg }, adminPinInput: "" });
          openAdminModal();
        } else {
          toast(res.message || "Something went wrong.");
        }
        return;
      }
      setLedger(res as LedgerState);
      if (successMsg) toast(successMsg);
    } catch {
      setBusy(false);
      toast("Server error — please try again.");
    }
  }

  function togglePaymentOptimistic(batchId: string, payerId: string) {
    if (!adminUnlocked || !adminPin) {
      mutateGated("togglePayment", { batchId, payerId });
      return;
    }
    if (busy) return;
    const b = ledger && findBatch(ledger, batchId);
    if (!b || !b.currentPayments || !(payerId in b.currentPayments)) {
      mutateGated("togglePayment", { batchId, payerId });
      return;
    }
    const prevStatus = b.currentPayments[payerId];
    const nextStatus = prevStatus === "confirmed" ? "pending" : "confirmed";
    setLedger((prev) =>
      prev
        ? {
            ...prev,
            batches: prev.batches.map((batch) =>
              batch.id === batchId ? { ...batch, currentPayments: { ...batch.currentPayments, [payerId]: nextStatus } } : batch
            ),
          }
        : prev
    );
    setBusy(true);
    mutateApi("togglePayment", adminPin, { batchId, payerId })
      .then((res) => {
        setBusy(false);
        if (res.error) {
          setLedger((prev) =>
            prev
              ? {
                  ...prev,
                  batches: prev.batches.map((batch) =>
                    batch.id === batchId ? { ...batch, currentPayments: { ...batch.currentPayments, [payerId]: prevStatus } } : batch
                  ),
                }
              : prev
          );
          if (res.error === "wrong_pin" || res.error === "pin_not_set") {
            clearAdmin();
            toast("Your admin PIN didn't work — enter it again.");
            patchUi({ pendingAction: { action: "togglePayment", payload: { batchId, payerId } }, adminPinInput: "" });
            openAdminModal();
          } else {
            toast(res.message || "Could not update — try again.");
          }
          return;
        }
        setLedger(res as LedgerState);
      })
      .catch(() => {
        setBusy(false);
        setLedger((prev) =>
          prev
            ? {
                ...prev,
                batches: prev.batches.map((batch) =>
                  batch.id === batchId ? { ...batch, currentPayments: { ...batch.currentPayments, [payerId]: prevStatus } } : batch
                ),
              }
            : prev
        );
        toast("Server error — please try again.");
      });
  }

  function guardedAdminAction(fn: (pin: string) => void) {
    if (busy) return;
    if (!adminUnlocked || !adminPin) {
      patchUi({ pendingCustomAction: fn, adminPinInput: "" });
      openAdminModal();
      return;
    }
    fn(adminPin);
  }

  async function performSavePaymentDetails(pd: PaymentDetails, pin: string) {
    setBusy(true);
    try {
      const res = await savePaymentDetailsApi(pin, pd);
      setBusy(false);
      if (res.error) {
        if (res.error === "wrong_pin" || res.error === "pin_not_set") {
          clearAdmin();
          toast("Your admin PIN didn't work — enter it again.");
          patchUi({ pendingCustomAction: (p: string) => performSavePaymentDetails(pd, p), adminPinInput: "" });
          openAdminModal();
        } else {
          toast(res.message || "Could not save payment details.");
        }
        return;
      }
      setLedger((prev) => (prev ? { ...prev, paymentDetails: pd } : prev));
      toast("Payment details saved.");
    } catch {
      setBusy(false);
      toast("Server error — try again.");
    }
  }

  function copyToClipboard(text: string) {
    function fallback() {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {}
        document.body.removeChild(ta);
        toast(ok ? "Copied to clipboard." : "Couldn't copy — select the text above and copy it manually.");
      } catch {
        toast("Couldn't copy — select the text above and copy it manually.");
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard."), fallback);
    } else {
      fallback();
    }
  }

  /* ---------- escape key closes whichever modal is open ---------- */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const u = uiRef.current;
      if (u.showNewBatch) patchUi({ showNewBatch: false });
      if (u.showAdminModal) closeAdminModal();
      if (u.showEditBatch) patchUi({ showEditBatch: false });
      if (u.showChangePin) patchUi({ showChangePin: false });
      if (u.showPaymentDetails) patchUi({ showPaymentDetails: false });
      if (u.showShareFor) patchUi({ showShareFor: null });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- new-batch draft helpers ---------- */
  function openNewBatch() {
    patchUi({
      newBatchDraft: { name: "", amount: "", startMonth: defaultNextMonth(), participants: [], copayerFor: null },
      showNewBatch: true,
    });
  }
  function updateNewBatchField(field: "name" | "amount" | "startMonth", value: string) {
    setUi((prev) => (prev.newBatchDraft ? { ...prev, newBatchDraft: { ...prev.newBatchDraft, [field]: value } } : prev));
  }
  function addDraftParticipant(name: string) {
    setUi((prev) =>
      prev.newBatchDraft
        ? { ...prev, newBatchDraft: { ...prev.newBatchDraft, participants: [...prev.newBatchDraft.participants, { name, subNames: [] }] } }
        : prev
    );
  }
  function removeDraftParticipant(idx: number) {
    setUi((prev) =>
      prev.newBatchDraft
        ? { ...prev, newBatchDraft: { ...prev.newBatchDraft, participants: prev.newBatchDraft.participants.filter((_, i) => i !== idx) } }
        : prev
    );
  }
  function moveDraftParticipant(idx: number, dir: number) {
    setUi((prev) => {
      if (!prev.newBatchDraft) return prev;
      const arr = [...prev.newBatchDraft.participants];
      const swap = idx + dir;
      if (swap < 0 || swap >= arr.length) return prev;
      [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
      return { ...prev, newBatchDraft: { ...prev.newBatchDraft, participants: arr } };
    });
  }
  function draftCopayerOpen(idx: number) {
    setUi((prev) => (prev.newBatchDraft ? { ...prev, newBatchDraft: { ...prev.newBatchDraft, copayerFor: idx } } : prev));
  }
  function draftCopayerCancel() {
    setUi((prev) => (prev.newBatchDraft ? { ...prev, newBatchDraft: { ...prev.newBatchDraft, copayerFor: null } } : prev));
  }
  function draftCopayerAdd(idx: number, name: string) {
    setUi((prev) => {
      if (!prev.newBatchDraft) return prev;
      const arr = prev.newBatchDraft.participants.map((p, i) => (i === idx ? { ...p, subNames: [...p.subNames, name] } : p));
      return { ...prev, newBatchDraft: { ...prev.newBatchDraft, participants: arr } };
    });
  }
  function draftCopayerRemove(idx: number, subIdx: number) {
    setUi((prev) => {
      if (!prev.newBatchDraft) return prev;
      const arr = prev.newBatchDraft.participants.map((p, i) =>
        i === idx ? { ...p, subNames: p.subNames.filter((_, si) => si !== subIdx) } : p
      );
      return { ...prev, newBatchDraft: { ...prev.newBatchDraft, participants: arr } };
    });
  }
  function submitNewBatch() {
    const d = ui.newBatchDraft;
    if (!d) return;
    if (!d.name.trim()) {
      toast("Give the batch a name.");
      return;
    }
    if (!d.amount || Number(d.amount) <= 0) {
      toast("Enter a contribution amount.");
      return;
    }
    if (d.participants.length < 2) {
      toast("Add at least 2 members.");
      return;
    }
    patchUi({ showNewBatch: false });
    mutateGated("createBatch", { draft: d }, "Batch created.");
  }

  /* ---------- edit batch ---------- */
  function openEditBatch(b: Batch) {
    patchUi({
      editBatchDraft: { batchId: b.id, name: b.name, amount: b.amount, startMonth: b.startMonth || defaultNextMonth() },
      showEditBatch: true,
    });
  }
  function updateEditBatchField(field: "name" | "amount" | "startMonth", value: string) {
    setUi((prev) => (prev.editBatchDraft ? { ...prev, editBatchDraft: { ...prev.editBatchDraft, [field]: value } } : prev));
  }
  function submitEditBatch() {
    const ed = ui.editBatchDraft;
    if (!ed) return;
    if (!ed.name.trim()) {
      toast("Give the batch a name.");
      return;
    }
    if (!ed.amount || Number(ed.amount) <= 0) {
      toast("Enter a contribution amount.");
      return;
    }
    if (!ed.startMonth) {
      toast("Choose a first collection month.");
      return;
    }
    patchUi({ showEditBatch: false });
    mutateGated("editBatch", { batchId: ed.batchId, name: ed.name, amount: ed.amount, startMonth: ed.startMonth }, "Batch updated.");
  }

  /* ---------- add participant ---------- */
  function openAddParticipant(batchId: string) {
    patchUi({ addParticipantOpenFor: batchId, addParticipantDraft: { name: "", phone: "", subNames: [], copayerOpen: false } });
  }
  function updateAddParticipantField(field: "name" | "phone", value: string) {
    setUi((prev) => ({ ...prev, addParticipantDraft: { ...prev.addParticipantDraft, [field]: value } }));
  }
  function addParticipantCopayerOpen() {
    setUi((prev) => ({ ...prev, addParticipantDraft: { ...prev.addParticipantDraft, copayerOpen: true } }));
  }
  function addParticipantCopayerCancel() {
    setUi((prev) => ({ ...prev, addParticipantDraft: { ...prev.addParticipantDraft, copayerOpen: false } }));
  }
  function addParticipantCopayerAdd(name: string) {
    setUi((prev) => ({ ...prev, addParticipantDraft: { ...prev.addParticipantDraft, subNames: [...prev.addParticipantDraft.subNames, name] } }));
  }
  function addParticipantCopayerRemove(subIdx: number) {
    setUi((prev) => ({
      ...prev,
      addParticipantDraft: { ...prev.addParticipantDraft, subNames: prev.addParticipantDraft.subNames.filter((_, i) => i !== subIdx) },
    }));
  }
  function submitAddParticipant(batchId: string) {
    const name = ui.addParticipantDraft.name.trim();
    if (!name) {
      toast("Enter a name.");
      return;
    }
    const { phone, subNames } = ui.addParticipantDraft;
    patchUi({ addParticipantOpenFor: null });
    mutateGated("addParticipant", { batchId, name, phone, subNames }, subNames.length ? "Shared slot added." : "Member added.");
  }

  /* ---------- share ---------- */
  function shareCopy() {
    const b = ledger && ui.showShareFor ? findBatch(ledger, ui.showShareFor) : undefined;
    if (!b) return;
    copyToClipboard(buildShareTextFor(b));
  }
  function buildShareTextFor(b: Batch) {
    return buildShareText(b, ui.shareStyle, ledger?.paymentDetails);
  }
  function shareWhatsApp() {
    const b = ledger && ui.showShareFor ? findBatch(ledger, ui.showShareFor) : undefined;
    if (!b) return;
    window.open("https://wa.me/?text=" + encodeURIComponent(buildShareTextFor(b)), "_blank");
  }

  /* ---------- render ---------- */
  if (!loadedOnce) {
    return (
      <>
        <div className="boot-loading">Loading your ledger…</div>
        <Toast msg={toastMsg} visible={toastVisible} />
      </>
    );
  }

  const activeBatch = ui.view === "batch" && ui.batchId && ledger ? findBatch(ledger, ui.batchId) : undefined;

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>Ajoo Ledger</h1>
            <span>rotating contributions</span>
          </div>
          {ui.view === "home" ? (
            <div className="search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                type="text"
                placeholder="Search batches or names"
                value={ui.search}
                onChange={(e) => patchUi({ search: e.target.value })}
              />
            </div>
          ) : null}
          <div className="topbar-actions">
            <button className="btn-icon" aria-label="Refresh" title="Refresh" onClick={() => refreshLedger().then(() => toast("Refreshed."))}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
            {ui.view === "home" ? (
              <button className="btn btn-primary" onClick={openNewBatch}>
                + New batch
              </button>
            ) : null}
            {adminUnlocked ? (
              <>
                <button
                  className="btn-icon"
                  aria-label="Payment details"
                  title="Payment details"
                  onClick={() =>
                    patchUi({
                      paymentDetailsDraft: {
                        accountNumber: ledger?.paymentDetails?.accountNumber || "",
                        accountName: ledger?.paymentDetails?.accountName || "",
                        bankName: ledger?.paymentDetails?.bankName || "",
                      },
                      showPaymentDetails: true,
                    })
                  }
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M3 10l9-6 9 6"></path>
                    <path d="M4 10v9M9 10v9M15 10v9M20 10v9"></path>
                    <path d="M2 21h20"></path>
                  </svg>
                </button>
                <button
                  className="btn-icon"
                  aria-label="Change admin PIN"
                  title="Change admin PIN"
                  onClick={() => patchUi({ changePinDraft: { newPin: "", confirmPin: "" }, showChangePin: true })}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="7.5" cy="15.5" r="5.5"></circle>
                    <path d="M21 2l-9.6 9.6M15.5 7.5L18 5M18 5l2.5-2.5M18 5l2 2"></path>
                  </svg>
                </button>
              </>
            ) : null}
            <button
              className={"pill-admin" + (adminUnlocked ? " unlocked" : "")}
              onClick={() => (adminUnlocked ? exitAdminMode() : openAdminModal())}
            >
              {adminUnlocked ? SYM.unlocked + " Admin" : SYM.locked + " Admin"}
            </button>
          </div>
        </div>
      </div>

      <div className="wrap">
        {activeBatch ? (
          <BatchDetailView
            b={activeBatch}
            ui={ui}
            busy={busy}
            onBack={() => patchUi({ view: "home" })}
            onShare={() => patchUi({ showShareFor: activeBatch.id })}
            onEdit={() => openEditBatch(activeBatch)}
            onToggleArchive={() => mutateGated("toggleArchive", { batchId: activeBatch.id })}
            onRequestDelete={() => patchUi({ confirmDeleteFor: activeBatch.id })}
            onCancelDelete={() => patchUi({ confirmDeleteFor: null })}
            onConfirmDelete={() => {
              patchUi({ view: "home", confirmDeleteFor: null });
              mutateGated("deleteBatch", { batchId: activeBatch.id }, "Batch deleted.");
            }}
            onTogglePayment={(payerId) => togglePaymentOptimistic(activeBatch.id, payerId)}
            onRequestMarkCollected={() => {
              if (confirmedCount(activeBatch) === currentTotalUnits(activeBatch)) {
                mutateGated("markCollected", { batchId: activeBatch.id }, "Marked as collected — next round started.");
              } else {
                patchUi({ confirmCollectFor: activeBatch.id });
              }
            }}
            onConfirmMarkCollected={() => {
              patchUi({ confirmCollectFor: null });
              mutateGated("markCollected", { batchId: activeBatch.id }, "Marked as collected — next round started.");
            }}
            onCancelMarkCollected={() => patchUi({ confirmCollectFor: null })}
            onMoveParticipant={(participantId, dir) => mutateGated("moveParticipant", { batchId: activeBatch.id, participantId, dir })}
            onRemoveParticipant={(participantId) => mutateGated("removeParticipant", { batchId: activeBatch.id, participantId }, "Member removed.")}
            onOpenAddParticipant={() => openAddParticipant(activeBatch.id)}
            onCancelAddParticipant={() => patchUi({ addParticipantOpenFor: null })}
            onAddParticipantField={updateAddParticipantField}
            onAddParticipantCopayerOpen={addParticipantCopayerOpen}
            onAddParticipantCopayerCancel={addParticipantCopayerCancel}
            onAddParticipantCopayerAdd={addParticipantCopayerAdd}
            onAddParticipantCopayerRemove={addParticipantCopayerRemove}
            onSubmitAddParticipant={() => submitAddParticipant(activeBatch.id)}
          />
        ) : ledger ? (
          <HomeView
            ledger={ledger}
            ui={ui}
            onFilter={(f) => patchUi({ filter: f })}
            onOpenBatch={(id) => {
              patchUi({ view: "batch", batchId: id, confirmCollectFor: null, confirmDeleteFor: null, addParticipantOpenFor: null });
              window.scrollTo(0, 0);
            }}
            onOpenNewBatch={openNewBatch}
          />
        ) : null}
      </div>

      {ui.showAdminModal ? (
        <AdminModal
          pinSet={!!ledger?.pinSet}
          value={ui.adminPinInput}
          busy={busy}
          onChange={(value) => patchUi({ adminPinInput: value })}
          onCancel={closeAdminModal}
          onSubmit={submitAdminPin}
        />
      ) : ui.showNewBatch && ui.newBatchDraft ? (
        <NewBatchModal
          draft={ui.newBatchDraft}
          busy={busy}
          onChange={updateNewBatchField}
          onAddParticipant={addDraftParticipant}
          onRemoveParticipant={removeDraftParticipant}
          onMoveParticipant={moveDraftParticipant}
          onCopayerOpen={draftCopayerOpen}
          onCopayerCancel={draftCopayerCancel}
          onCopayerAdd={draftCopayerAdd}
          onCopayerRemove={draftCopayerRemove}
          onCancel={() => patchUi({ showNewBatch: false })}
          onSubmit={submitNewBatch}
        />
      ) : ui.showEditBatch && ui.editBatchDraft ? (
        <EditBatchModal
          draft={ui.editBatchDraft}
          busy={busy}
          onChange={updateEditBatchField}
          onCancel={() => patchUi({ showEditBatch: false })}
          onSubmit={submitEditBatch}
        />
      ) : ui.showChangePin ? (
        <ChangePinModal
          draft={ui.changePinDraft}
          busy={busy}
          onChange={(field, value) => setUi((prev) => ({ ...prev, changePinDraft: { ...prev.changePinDraft, [field]: value } }))}
          onCancel={() => patchUi({ showChangePin: false })}
          onSubmit={submitChangePin}
        />
      ) : ui.showPaymentDetails ? (
        <PaymentDetailsModal
          draft={ui.paymentDetailsDraft}
          busy={busy}
          onChange={(field, value) => setUi((prev) => ({ ...prev, paymentDetailsDraft: { ...prev.paymentDetailsDraft, [field]: value } }))}
          onCancel={() => patchUi({ showPaymentDetails: false })}
          onSubmit={() => {
            const pd = ui.paymentDetailsDraft;
            patchUi({ showPaymentDetails: false });
            guardedAdminAction((pin) => performSavePaymentDetails(pd, pin));
          }}
        />
      ) : ui.showShareFor && ledger && findBatch(ledger, ui.showShareFor) ? (
        <ShareModal
          batch={findBatch(ledger, ui.showShareFor)!}
          shareStyle={ui.shareStyle}
          paymentDetails={ledger.paymentDetails}
          onStyleChange={(style) => patchUi({ shareStyle: style })}
          onCancel={() => patchUi({ showShareFor: null })}
          onCopy={shareCopy}
          onWhatsApp={shareWhatsApp}
        />
      ) : null}

      <Toast msg={toastMsg} visible={toastVisible} />
    </>
  );
}

function Toast({ msg, visible }: { msg: string; visible: boolean }) {
  return <div className={"toast" + (visible ? " show" : "")}>{msg}</div>;
}

/* ---------------- home view ---------------- */

function HomeView({
  ledger,
  ui,
  onFilter,
  onOpenBatch,
  onOpenNewBatch,
}: {
  ledger: LedgerState;
  ui: UIState;
  onFilter: (f: Filter) => void;
  onOpenBatch: (id: string) => void;
  onOpenNewBatch: () => void;
}) {
  const active = ledger.batches.filter((b) => !b.archived && !isComplete(b));
  let totalPeople = 0;
  let expected = 0;
  let confirmed = 0;
  let totalDue = 0;
  active.forEach((b) => {
    totalPeople += totalPayerUnits(b);
    expected += b.amount * b.participants.length;
    confirmed += confirmedCount(b);
    totalDue += currentTotalUnits(b);
  });

  let list = ledger.batches.filter((b) => {
    if (ui.filter === "active") return !b.archived && !isComplete(b);
    if (ui.filter === "completed") return !b.archived && isComplete(b);
    if (ui.filter === "archived") return b.archived;
    return !b.archived;
  });
  if (ui.search.trim()) {
    const q = ui.search.trim().toLowerCase();
    list = list.filter((b) => b.name.toLowerCase().includes(q) || b.participants.some((p) => p.name.toLowerCase().includes(q)));
  }

  const filters: [Filter, string][] = [
    ["all", "All"],
    ["active", "Active"],
    ["completed", "Completed"],
    ["archived", "Archived"],
  ];

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="num">{active.length}</div>
          <div className="label">Active batches</div>
        </div>
        <div className="stat">
          <div className="num">{totalPeople}</div>
          <div className="label">People contributing</div>
        </div>
        <div className="stat">
          <div className="num">{money(expected)}</div>
          <div className="label">Expected this cycle</div>
        </div>
        <div className="stat">
          <div className="num">
            {confirmed}/{totalDue}
          </div>
          <div className="label">Confirmed this month</div>
        </div>
      </div>

      <div className="chips">
        {filters.map(([value, label]) => (
          <button key={value} className={"chip" + (ui.filter === value ? " active" : "")} onClick={() => onFilter(value)}>
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        ledger.batches.length === 0 ? (
          <div className="empty">
            <h3>No batches yet</h3>
            <p>Create your first contribution batch — add the members in their collection order and Ajoo Ledger tracks the rest.</p>
            <button className="btn btn-primary" onClick={onOpenNewBatch}>
              + New batch
            </button>
          </div>
        ) : (
          <div className="empty">
            <h3>Nothing here</h3>
            <p>No batches match your search or filter.</p>
          </div>
        )
      ) : (
        <div className="grid">
          {list.map((b) => (
            <BatchCard key={b.id} b={b} onOpen={() => onOpenBatch(b.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function BatchCard({ b, onOpen }: { b: Batch; onOpen: () => void }) {
  const complete = isComplete(b);
  return (
    <div className="card" onClick={onOpen}>
      <div className="card-top">
        <div>
          <h3>{b.name}</h3>
          <div className="card-amount">
            {money(b.amount)} / month · {b.participants.length} members
          </div>
        </div>
        {b.archived ? (
          <span className="badge badge-archived">Archived</span>
        ) : complete ? (
          <span className="badge badge-done">Completed</span>
        ) : (
          <span className="badge badge-active">
            Round {b.history.length + 1} of {b.participants.length}
          </span>
        )}
      </div>
      <div className="progress">
        <i style={{ width: cyclePct(b) + "%" }}></i>
      </div>
      {complete ? (
        <div className="card-empty-now">
          Cycle complete — everyone has collected. <span className="pct-muted">100%</span>
        </div>
      ) : (
        (() => {
          const collector = participantById(b, currentCollectorId(b));
          const cc = confirmedCount(b);
          const total = currentTotalUnits(b);
          return (
            <div className="now-row">
              <Avatar id={collector.id} name={collector.name} />
              <div className="who">
                <div className="name">{collector.name}</div>
                <div className="month">
                  {monthLabel(b.startMonth, b.history.length)} · {cyclePct(b)}% of cycle
                </div>
              </div>
              <div className="ratio">
                {cc}/{total}
              </div>
            </div>
          );
        })()
      )}
    </div>
  );
}

/* ---------------- batch detail view ---------------- */

function BatchDetailView({
  b,
  ui,
  busy,
  onBack,
  onShare,
  onEdit,
  onToggleArchive,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onTogglePayment,
  onRequestMarkCollected,
  onConfirmMarkCollected,
  onCancelMarkCollected,
  onMoveParticipant,
  onRemoveParticipant,
  onOpenAddParticipant,
  onCancelAddParticipant,
  onAddParticipantField,
  onAddParticipantCopayerOpen,
  onAddParticipantCopayerCancel,
  onAddParticipantCopayerAdd,
  onAddParticipantCopayerRemove,
  onSubmitAddParticipant,
}: {
  b: Batch;
  ui: UIState;
  busy: boolean;
  onBack: () => void;
  onShare: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onTogglePayment: (payerId: string) => void;
  onRequestMarkCollected: () => void;
  onConfirmMarkCollected: () => void;
  onCancelMarkCollected: () => void;
  onMoveParticipant: (participantId: string, dir: number) => void;
  onRemoveParticipant: (participantId: string) => void;
  onOpenAddParticipant: () => void;
  onCancelAddParticipant: () => void;
  onAddParticipantField: (field: "name" | "phone", value: string) => void;
  onAddParticipantCopayerOpen: () => void;
  onAddParticipantCopayerCancel: () => void;
  onAddParticipantCopayerAdd: (name: string) => void;
  onAddParticipantCopayerRemove: (subIdx: number) => void;
  onSubmitAddParticipant: () => void;
}) {
  void busy;
  const complete = isComplete(b);
  return (
    <>
      <button className="back" onClick={onBack}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>{" "}
        All batches
      </button>
      <div className="detail-head">
        <div>
          <h2>{b.name}</h2>
          <div className="detail-sub">
            {money(b.amount)} per person, per month · {b.participants.length} members · started {monthLabel(b.startMonth, 0)}
          </div>
        </div>
        <div className="detail-actions">
          <button className="btn btn-ghost btn-sm" onClick={onShare}>
            Share
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>
            Edit
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onToggleArchive}>
            {b.archived ? "Unarchive" : "Archive"}
          </button>
          {b.history.length === 0 ? (
            ui.confirmDeleteFor === b.id ? (
              <>
                <button className="btn btn-danger btn-sm" onClick={onConfirmDelete}>
                  Confirm delete
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onCancelDelete}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn-danger btn-sm" onClick={onRequestDelete}>
                Delete
              </button>
            )
          ) : null}
        </div>
      </div>

      <Hero
        b={b}
        complete={complete}
        confirmCollectFor={ui.confirmCollectFor}
        onTogglePayment={onTogglePayment}
        onRequestMarkCollected={onRequestMarkCollected}
        onConfirmMarkCollected={onConfirmMarkCollected}
        onCancelMarkCollected={onCancelMarkCollected}
      />

      <div className="section-title">Full schedule</div>
      <ScheduleTable b={b} />

      <div className="section-title">Members ({b.participants.length})</div>
      <Roster
        b={b}
        ui={ui}
        onMoveParticipant={onMoveParticipant}
        onRemoveParticipant={onRemoveParticipant}
        onOpenAddParticipant={onOpenAddParticipant}
        onCancelAddParticipant={onCancelAddParticipant}
        onAddParticipantField={onAddParticipantField}
        onAddParticipantCopayerOpen={onAddParticipantCopayerOpen}
        onAddParticipantCopayerCancel={onAddParticipantCopayerCancel}
        onAddParticipantCopayerAdd={onAddParticipantCopayerAdd}
        onAddParticipantCopayerRemove={onAddParticipantCopayerRemove}
        onSubmitAddParticipant={onSubmitAddParticipant}
      />
    </>
  );
}

function Hero({
  b,
  complete,
  confirmCollectFor,
  onTogglePayment,
  onRequestMarkCollected,
  onConfirmMarkCollected,
  onCancelMarkCollected,
}: {
  b: Batch;
  complete: boolean;
  confirmCollectFor: string | null;
  onTogglePayment: (payerId: string) => void;
  onRequestMarkCollected: () => void;
  onConfirmMarkCollected: () => void;
  onCancelMarkCollected: () => void;
}) {
  if (complete) {
    return (
      <div className="hero">
        <div className="hero-eyebrow">Cycle complete</div>
        <div className="hero-complete">
          All {b.participants.length} members have collected their share. {SYM.party}
        </div>
      </div>
    );
  }
  const collector = participantById(b, currentCollectorId(b));
  const label = monthLabel(b.startMonth, b.history.length);
  const cc = confirmedCount(b);
  const total = currentTotalUnits(b);
  const moneyStats = roundMoneyStats(b);
  return (
    <div className="hero">
      <div className="hero-eyebrow">
        {label} · round {b.history.length + 1} of {b.participants.length} · {cyclePct(b)}% of cycle complete
      </div>
      <div className="hero-collector">
        <Avatar id={collector.id} name={collector.name} size={52} />
        <div>
          <h3>{collector.name} is collecting</h3>
          <div className="month">{money(moneyStats.expected)} expected this round</div>
        </div>
      </div>
      <div className="hero-money">
        <div className="progress">
          <i style={{ width: moneyStats.pct + "%" }}></i>
        </div>
        <div className="hero-money-label">
          <span>
            {money(moneyStats.confirmed)} confirmed of {money(moneyStats.expected)}
          </span>
          <span>{moneyStats.pct}%</span>
        </div>
      </div>
      <div className="paylist">
        {b.participants.map((p) => {
          const units = payerUnits(p);
          if (units.length > 1) {
            return (
              <div className="paygroup" key={p.id}>
                <div className="paygroup-label">
                  {SYM.people} {p.name} — shared slot
                </div>
                <div className="paygroup-chips">
                  {units.map((u) => {
                    const status = (b.currentPayments || {})[u.id] || "pending";
                    const confirmedFlag = status === "confirmed";
                    return (
                      <div
                        className="paychip"
                        key={u.id}
                        title={u.name + " · " + money(unitAmount(b, u))}
                        onClick={() => onTogglePayment(u.id)}
                      >
                        <Avatar id={u.id} name={u.name} size={24} />
                        <span className="pname">
                          {u.name} · {money(unitAmount(b, u))}
                        </span>
                        <span className={"pstatus pstatus-" + status}>{confirmedFlag ? "Confirmed" : "Pending"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }
          const u0 = units[0];
          const status0 = (b.currentPayments || {})[u0.id] || "pending";
          const confirmedFlag0 = status0 === "confirmed";
          return (
            <div className="paychip" key={p.id} onClick={() => onTogglePayment(u0.id)}>
              <Avatar id={p.id} name={p.name} size={24} />
              <span className="pname">{p.name}</span>
              <span className={"pstatus pstatus-" + status0}>{confirmedFlag0 ? "Confirmed" : "Pending"}</span>
            </div>
          );
        })}
      </div>
      <div className="hero-foot">
        <span style={{ fontSize: "13px", color: "var(--ink-soft)", fontWeight: 600 }}>
          {cc} of {total} payments confirmed
        </span>
        {confirmCollectFor === b.id ? (
          <div className="confirm-inline">
            <p>
              Only {cc} of {total} confirmed — mark as collected anyway?
            </p>
            <button className="btn btn-primary btn-sm" onClick={onConfirmMarkCollected}>
              Yes, mark collected
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onCancelMarkCollected}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onRequestMarkCollected}>
            Mark pot collected → move to next month
          </button>
        )}
      </div>
    </div>
  );
}

function ScheduleTable({ b }: { b: Batch }) {
  interface Row {
    index: number;
    status: "done" | "current" | "upcoming";
    collectorId: string;
    monthLabel: string;
    payments: Record<string, string> | null;
  }
  const rows: Row[] = [];
  b.history.forEach((hEntry, i) => {
    rows.push({ index: i, status: "done", collectorId: hEntry.collectorId, monthLabel: hEntry.monthLabel, payments: hEntry.payments });
  });
  if (b.queue.length) {
    rows.push({
      index: b.history.length,
      status: "current",
      collectorId: b.queue[0],
      monthLabel: monthLabel(b.startMonth, b.history.length),
      payments: b.currentPayments,
    });
    b.queue.slice(1).forEach((pid, i) => {
      rows.push({
        index: b.history.length + 1 + i,
        status: "upcoming",
        collectorId: pid,
        monthLabel: monthLabel(b.startMonth, b.history.length + 1 + i),
        payments: null,
      });
    });
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Collector</th>
            <th>Payments</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = participantById(b, r.collectorId);
            const rowCls = r.status === "current" ? "row-current" : r.status === "done" ? "row-done" : "";
            let paymentsCell: React.ReactNode = "—";
            if (r.payments) {
              const vals = Object.values(r.payments);
              const c = vals.filter((v) => v === "confirmed").length;
              const pct = vals.length ? Math.round((c / vals.length) * 100) : 0;
              paymentsCell = (
                <>
                  {c} / {vals.length} <span className="pct-muted">({pct}%)</span>
                </>
              );
            }
            const statusLabel = r.status === "done" ? "Done" : r.status === "current" ? "Current" : "Upcoming";
            return (
              <tr className={rowCls} key={r.index}>
                <td className="mono">{r.monthLabel}</td>
                <td>
                  <div className="row-who">
                    <Avatar id={p.id} name={p.name} size={22} />
                    {p.name}
                  </div>
                </td>
                <td className="tabular">{paymentsCell}</td>
                <td>
                  <span className={"row-status row-status-" + r.status}>{statusLabel}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Roster({
  b,
  ui,
  onMoveParticipant,
  onRemoveParticipant,
  onOpenAddParticipant,
  onCancelAddParticipant,
  onAddParticipantField,
  onAddParticipantCopayerOpen,
  onAddParticipantCopayerCancel,
  onAddParticipantCopayerAdd,
  onAddParticipantCopayerRemove,
  onSubmitAddParticipant,
}: {
  b: Batch;
  ui: UIState;
  onMoveParticipant: (participantId: string, dir: number) => void;
  onRemoveParticipant: (participantId: string) => void;
  onOpenAddParticipant: () => void;
  onCancelAddParticipant: () => void;
  onAddParticipantField: (field: "name" | "phone", value: string) => void;
  onAddParticipantCopayerOpen: () => void;
  onAddParticipantCopayerCancel: () => void;
  onAddParticipantCopayerAdd: (name: string) => void;
  onAddParticipantCopayerRemove: (subIdx: number) => void;
  onSubmitAddParticipant: () => void;
}) {
  const copayerRef = useRef<HTMLInputElement>(null);
  const upcoming = b.queue.slice(1);

  function submitCopayer() {
    const name = (copayerRef.current?.value || "").trim();
    if (!name) return;
    onAddParticipantCopayerAdd(name);
    if (copayerRef.current) copayerRef.current.value = "";
    copayerRef.current?.focus();
  }

  return (
    <>
      <div className="roster">
        {b.participants.map((p) => {
          const inHistory = b.history.some((hE) => hE.collectorId === p.id);
          const isCurrent = b.queue.length > 0 && b.queue[0] === p.id;
          const upIdx = upcoming.indexOf(p.id);
          const tag = inHistory ? "Collected" : isCurrent ? "Collecting now" : "Queue position " + (upIdx + 2);
          const units = payerUnits(p);
          return (
            <div className="roster-item" key={p.id}>
              <Avatar id={p.id} name={p.name} size={30} />
              <div className="name">
                {p.name}
                {p.subPayers && p.subPayers.length ? (
                  <span className="joint-badge">
                    {SYM.people} {units.length}
                  </span>
                ) : null}
              </div>
              <div className="tag">{tag}</div>
              {upIdx !== -1 ? (
                <div className="roster-actions">
                  <button className="iconbtn" disabled={upIdx === 0} aria-label="Move up" onClick={() => onMoveParticipant(p.id, -1)}>
                    ↑
                  </button>
                  <button
                    className="iconbtn"
                    disabled={upIdx === upcoming.length - 1}
                    aria-label="Move down"
                    onClick={() => onMoveParticipant(p.id, 1)}
                  >
                    ↓
                  </button>
                  <button className="iconbtn" aria-label="Remove" onClick={() => onRemoveParticipant(p.id)}>
                    ×
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {ui.addParticipantOpenFor === b.id ? (
        <>
          <div className="inline-form">
            <input
              type="text"
              placeholder="Full name"
              value={ui.addParticipantDraft.name}
              onChange={(e) => onAddParticipantField("name", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmitAddParticipant();
                }
              }}
            />
            <input
              type="tel"
              placeholder="Phone (optional)"
              value={ui.addParticipantDraft.phone}
              onChange={(e) => onAddParticipantField("phone", e.target.value)}
            />
            <button className="btn btn-primary btn-sm" onClick={onSubmitAddParticipant}>
              Add
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onCancelAddParticipant}>
              Cancel
            </button>
            {!ui.addParticipantDraft.copayerOpen ? (
              <button className="btn btn-ghost btn-sm" onClick={onAddParticipantCopayerOpen}>
                + Co-payer
              </button>
            ) : null}
          </div>
          {ui.addParticipantDraft.subNames.length ? (
            <div className="copayer-list">
              {ui.addParticipantDraft.subNames.map((n, si) => (
                <span className="copayer-chip" key={si}>
                  {n}
                  <button aria-label="Remove co-payer" onClick={() => onAddParticipantCopayerRemove(si)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {ui.addParticipantDraft.copayerOpen ? (
            <div className="add-row">
              <input
                ref={copayerRef}
                type="text"
                placeholder="Co-payer name and press Enter"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCopayer();
                  }
                }}
              />
              <button className="btn btn-ghost btn-sm" onClick={submitCopayer}>
                Add
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onAddParticipantCopayerCancel}>
                Done
              </button>
            </div>
          ) : null}
          {ui.addParticipantDraft.subNames.length || ui.addParticipantDraft.copayerOpen ? (
            <div className="hint">This will be one shared rotation position — each person confirms their own share.</div>
          ) : null}
        </>
      ) : (
        <div style={{ marginTop: "10px" }}>
          <button className="btn btn-ghost btn-sm" onClick={onOpenAddParticipant}>
            + Add member
          </button>
        </div>
      )}
    </>
  );
}
