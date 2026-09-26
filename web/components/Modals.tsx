"use client";

import { useRef } from "react";
import type { Batch, ChangePinDraft, EditBatchDraft, NewBatchDraft, PaymentDetails } from "@/lib/types";
import { SYM, buildShareText, type ShareStyle } from "@/lib/ledger";

/* A modal's own content stops the overlay's click-to-close handler from
   firing — mirrors the original's data-stop attribute. */
export function Overlay({ onDismiss, children }: { onDismiss: () => void; children: React.ReactNode }) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>
  );
}

export function NewBatchModal({
  draft,
  busy,
  onChange,
  onAddParticipant,
  onRemoveParticipant,
  onMoveParticipant,
  onCopayerOpen,
  onCopayerCancel,
  onCopayerAdd,
  onCopayerRemove,
  onCancel,
  onSubmit,
}: {
  draft: NewBatchDraft;
  busy: boolean;
  onChange: (field: "name" | "amount" | "startMonth", value: string) => void;
  onAddParticipant: (name: string) => void;
  onRemoveParticipant: (idx: number) => void;
  onMoveParticipant: (idx: number, dir: number) => void;
  onCopayerOpen: (idx: number) => void;
  onCopayerCancel: () => void;
  onCopayerAdd: (idx: number, name: string) => void;
  onCopayerRemove: (idx: number, subIdx: number) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const newNameRef = useRef<HTMLInputElement>(null);
  const copayerRef = useRef<HTMLInputElement>(null);

  function submitNewName() {
    const name = (newNameRef.current?.value || "").trim();
    if (!name) return;
    onAddParticipant(name);
    if (newNameRef.current) newNameRef.current.value = "";
    newNameRef.current?.focus();
  }

  function submitCopayer(idx: number) {
    const name = (copayerRef.current?.value || "").trim();
    if (!name) return;
    onCopayerAdd(idx, name);
    if (copayerRef.current) copayerRef.current.value = "";
    copayerRef.current?.focus();
  }

  return (
    <Overlay onDismiss={onCancel}>
      <div className="modal">
        <h2>New contribution batch</h2>
        <div className="sub">Add members in the order they’ll collect. The cycle runs one round per member.</div>
        <div className="modal-fields">
          <div className="row2">
            <div className="field">
              <label>Batch name</label>
              <input
                id="nb-name"
                type="text"
                placeholder="e.g. August Circle"
                value={draft.name}
                onChange={(e) => onChange("name", e.target.value)}
              />
            </div>
            <div className="field">
              <label>Amount per month</label>
              <input
                type="number"
                min={0}
                placeholder="20000"
                value={draft.amount}
                onChange={(e) => onChange("amount", e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label>First collection month</label>
            <input type="month" value={draft.startMonth} onChange={(e) => onChange("startMonth", e.target.value)} />
          </div>
          <div className="field">
            <label>Members (collection order)</label>
            <div className="participant-draft">
              {draft.participants.map((p, i) => (
                <div className="participant-row-wrap" key={i}>
                  <div className="participant-row">
                    <span className="n">{i + 1}</span>
                    <span className="name">
                      {p.name}
                      {p.subNames && p.subNames.length ? (
                        <span className="joint-badge">{SYM.people} Joint</span>
                      ) : null}
                    </span>
                    <button
                      className="iconbtn"
                      disabled={i === 0}
                      aria-label="Move up"
                      onClick={() => onMoveParticipant(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="iconbtn"
                      disabled={i === draft.participants.length - 1}
                      aria-label="Move down"
                      onClick={() => onMoveParticipant(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="iconbtn"
                      aria-label="Add co-payer"
                      title="Share this slot with a co-payer"
                      onClick={() => onCopayerOpen(i)}
                    >
                      +{SYM.person}
                    </button>
                    <button className="iconbtn" aria-label="Remove" onClick={() => onRemoveParticipant(i)}>
                      ×
                    </button>
                  </div>
                  {p.subNames && p.subNames.length ? (
                    <div className="copayer-list">
                      {p.subNames.map((n, si) => (
                        <span className="copayer-chip" key={si}>
                          {n}
                          <button aria-label="Remove co-payer" onClick={() => onCopayerRemove(i, si)}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {draft.copayerFor === i ? (
                    <div className="add-row">
                      <input
                        ref={copayerRef}
                        type="text"
                        placeholder="Co-payer name and press Enter"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            submitCopayer(i);
                          }
                        }}
                      />
                      <button className="btn btn-ghost btn-sm" onClick={() => submitCopayer(i)}>
                        Add
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={onCopayerCancel}>
                        Done
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="add-row">
              <input
                ref={newNameRef}
                id="nb-newname"
                type="text"
                placeholder="Add a member name and press Enter"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitNewName();
                  }
                }}
              />
              <button className="btn btn-ghost btn-sm" onClick={submitNewName}>
                Add
              </button>
            </div>
            <div className="hint">
              {draft.participants.length} member{draft.participants.length === 1 ? "" : "s"} · {draft.participants.length}-month
              cycle · use +{SYM.person} to share a slot between two or more people
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onSubmit}>
            Create batch
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function AdminModal({
  pinSet,
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  pinSet: boolean;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Overlay onDismiss={onCancel}>
      <div className="modal modal-sm">
        <h2>{pinSet ? "Admin access" : "Set an admin PIN"}</h2>
        <div className="sub">
          {pinSet
            ? "Enter the admin PIN to make changes."
            : "Anyone with this PIN can confirm payments and manage batches. Choose at least 4 digits — changing it later means editing the Config tab in the sheet directly."}
        </div>
        <div className="modal-fields">
          <div className="field">
            <input
              id="admin-pin-input"
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
              }}
              autoFocus
            />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onSubmit}>
            {pinSet ? "Unlock" : "Set PIN"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function EditBatchModal({
  draft,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: EditBatchDraft;
  busy: boolean;
  onChange: (field: "name" | "amount" | "startMonth", value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Overlay onDismiss={onCancel}>
      <div className="modal modal-sm">
        <h2>Edit batch</h2>
        <div className="sub">Update the name, monthly amount, or first collection month. Members and schedule order are unaffected.</div>
        <div className="modal-fields">
          <div className="field">
            <label>Batch name</label>
            <input id="eb-name" type="text" value={draft.name} onChange={(e) => onChange("name", e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Amount per month</label>
            <input type="number" min={0} value={draft.amount} onChange={(e) => onChange("amount", e.target.value)} />
          </div>
          <div className="field">
            <label>First collection month</label>
            <input type="month" value={draft.startMonth} onChange={(e) => onChange("startMonth", e.target.value)} />
          </div>
          <div className="hint">
            Fixes the schedule showing &quot;Month 1, Month 2…&quot; instead of real month names — set this to when the first
            round actually started. This also relabels rounds already marked collected, so the whole schedule updates at once.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onSubmit}>
            Save
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function ChangePinModal({
  draft,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ChangePinDraft;
  busy: boolean;
  onChange: (field: "newPin" | "confirmPin", value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Overlay onDismiss={onCancel}>
      <div className="modal modal-sm">
        <h2>Change admin PIN</h2>
        <div className="sub">Choose a new PIN of at least 4 digits. Anyone who still has the old one will need this new one.</div>
        <div className="modal-fields">
          <div className="field">
            <label>New PIN</label>
            <input
              id="cp-new"
              type="password"
              inputMode="numeric"
              value={draft.newPin}
              onChange={(e) => onChange("newPin", e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label>Confirm new PIN</label>
            <input
              id="cp-confirm"
              type="password"
              inputMode="numeric"
              value={draft.confirmPin}
              onChange={(e) => onChange("confirmPin", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onSubmit}>
            Save PIN
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function PaymentDetailsModal({
  draft,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: PaymentDetails;
  busy: boolean;
  onChange: (field: keyof PaymentDetails, value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Overlay onDismiss={onCancel}>
      <div className="modal modal-sm">
        <h2>Payment details</h2>
        <div className="sub">Shown at the bottom of every batch&apos;s shared WhatsApp update.</div>
        <div className="modal-fields">
          <div className="field">
            <label>Account number</label>
            <input
              id="pd-number"
              type="text"
              value={draft.accountNumber}
              onChange={(e) => onChange("accountNumber", e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label>Account name</label>
            <input type="text" value={draft.accountName} onChange={(e) => onChange("accountName", e.target.value)} />
          </div>
          <div className="field">
            <label>Bank name</label>
            <input type="text" value={draft.bankName} onChange={(e) => onChange("bankName", e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onSubmit}>
            Save
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function ShareModal({
  batch,
  shareStyle,
  paymentDetails,
  onStyleChange,
  onCancel,
  onCopy,
  onWhatsApp,
}: {
  batch: Batch;
  shareStyle: ShareStyle;
  paymentDetails: PaymentDetails | null | undefined;
  onStyleChange: (style: ShareStyle) => void;
  onCancel: () => void;
  onCopy: () => void;
  onWhatsApp: () => void;
}) {
  const text = buildShareText(batch, shareStyle, paymentDetails);
  const hasDetails = !!(paymentDetails && (paymentDetails.accountNumber || paymentDetails.accountName || paymentDetails.bankName));
  return (
    <Overlay onDismiss={onCancel}>
      <div className="modal">
        <h2>Share on WhatsApp</h2>
        <div className="sub">Preview the update, then send it straight to WhatsApp or copy it to paste yourself.</div>
        <div className="chips" style={{ margin: "4px 0 14px" }}>
          <button className={"chip" + (shareStyle === "decorative" ? " active" : "")} onClick={() => onStyleChange("decorative")}>
            Decorative (emoji)
          </button>
          <button className={"chip" + (shareStyle === "clean" ? " active" : "")} onClick={() => onStyleChange("clean")}>
            Clean / formal
          </button>
        </div>
        <textarea
          readOnly
          rows={12}
          value={text}
          style={{
            width: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: "12.5px",
            lineHeight: 1.5,
            border: "1px solid var(--border)",
            borderRadius: "9px",
            padding: "12px",
            background: "var(--surface-2)",
            color: "var(--ink)",
            resize: "vertical",
          }}
        />
        {!hasDetails ? (
          <div className="hint">
            No payment account set yet — add one from the bank icon next to Admin so it&apos;s included automatically.
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Close
          </button>
          <button className="btn btn-ghost" onClick={onCopy}>
            Copy text
          </button>
          <button className="btn btn-primary" onClick={onWhatsApp}>
            Share on WhatsApp
          </button>
        </div>
      </div>
    </Overlay>
  );
}
