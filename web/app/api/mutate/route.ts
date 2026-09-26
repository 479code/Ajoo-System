import { NextResponse } from "next/server";
import { checkPin, getFreshStateForMutation, saveStateDiff, patchCurrentPayment, findBatch, type RawRows } from "@/lib/sheets";
import {
  doCreateBatch,
  doEditBatch,
  doTogglePayment,
  doMarkCollected,
  doAddParticipant,
  doRemoveParticipant,
  doMoveParticipant,
  doToggleArchive,
  doDeleteBatch,
} from "@/lib/ledger";
import type { LedgerState } from "@/lib/types";

export const dynamic = "force-dynamic";
// Extra headroom above Vercel's 10s default: a clear-and-rewrite of several
// sheets can occasionally run long, and a killed function returns a
// non-JSON timeout page that the client can't parse — surfacing as a
// generic "Server error" toast even though the mutation may have partly
// gone through. More time to finish cleanly is cheaper than that ambiguity.
export const maxDuration = 30;

// NOTE on concurrency: the Apps Script version serialized every write with
// LockService so two admins tapping at once couldn't clobber each other.
// Vercel serverless functions are stateless across invocations, so there is
// no equivalent process-wide lock here. For this app's actual usage (a
// handful of family members, rarely acting at the exact same second) a
// last-write-wins race is an acceptable tradeoff rather than adding
// distributed-lock infrastructure for a low-stakes personal ledger — but if
// concurrent edits ever become a real problem, that's the thing to revisit.

export async function POST(req: Request) {
  let body: { action?: string; pin?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON body." }, { status: 400 });
  }

  const action = body.action;
  const pin = body.pin;
  const payload = body.payload || {};

  const pinCheck = await checkPin(pin);
  if (!pinCheck.ok) {
    return NextResponse.json({ error: pinCheck.error, message: pinCheck.message }, { status: 401 });
  }

  try {
    const { state, raw }: { state: LedgerState; raw: RawRows } = await getFreshStateForMutation();

    switch (action) {
      case "createBatch":
        doCreateBatch(state, payload.draft as never);
        break;
      case "editBatch":
        doEditBatch(state, payload.batchId as string, (payload.name as string) ?? null, (payload.amount as number) ?? null, (payload.startMonth as string) ?? null);
        break;
      case "togglePayment":
        doTogglePayment(state, payload.batchId as string, (payload.payerId as string) || (payload.participantId as string));
        break;
      case "markCollected":
        doMarkCollected(state, payload.batchId as string);
        break;
      case "addParticipant":
        doAddParticipant(state, payload.batchId as string, payload.name as string, (payload.phone as string) || "", payload.subNames as string[]);
        break;
      case "removeParticipant":
        doRemoveParticipant(state, payload.batchId as string, payload.participantId as string);
        break;
      case "moveParticipant":
        doMoveParticipant(state, payload.batchId as string, payload.participantId as string, Number(payload.dir));
        break;
      case "toggleArchive":
        doToggleArchive(state, payload.batchId as string);
        break;
      case "deleteBatch":
        doDeleteBatch(state, payload.batchId as string);
        break;
      default:
        return NextResponse.json({ error: "unknown_action", message: "Unknown action: " + action }, { status: 400 });
    }

    if (action === "togglePayment") {
      // Hot path: confirming a payment happens dozens of times per round and
      // only ever changes one cell — patch it directly instead of the full
      // clear-and-rewrite saveState() does for every sheet.
      const batchId = payload.batchId as string;
      const payerId = (payload.payerId as string) || (payload.participantId as string);
      const tb = findBatch(state, batchId);
      await patchCurrentPayment(batchId, payerId, tb ? (tb.currentPayments[payerId] as string) || "pending" : "pending");
    } else {
      await saveStateDiff(state, raw);
    }

    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json({ error: "server_error", message: String(err) }, { status: 500 });
  }
}
