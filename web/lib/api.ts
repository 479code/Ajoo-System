// Thin client-side fetch wrappers around the API routes. These replace the
// old google.script.run calls (callServer() in Index.html) with plain
// fetch() calls against our own Next.js API routes, which do the actual
// Google Sheets I/O server-side.

import type { ApiError, LedgerState, PaymentDetails } from "./types";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as T;
}

export async function getState(): Promise<LedgerState> {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    throw new Error(err.message || "Could not load the sheet.");
  }
  return (await res.json()) as LedgerState;
}

export interface MutateResult extends Partial<LedgerState> {
  error?: string;
  message?: string;
}

export function mutate(action: string, pin: string | null, payload: Record<string, unknown>): Promise<MutateResult> {
  return postJson<MutateResult>("/api/mutate", { action, pin, payload });
}

export interface PinResult {
  ok?: boolean;
  error?: string;
  message?: string;
}

export function setPin(pin: string): Promise<PinResult> {
  return postJson<PinResult>("/api/pin", { action: "set", pin });
}

export function verifyPin(pin: string): Promise<PinResult> {
  return postJson<PinResult>("/api/pin", { action: "verify", pin });
}

export function changePin(oldPin: string, newPin: string): Promise<PinResult> {
  return postJson<PinResult>("/api/pin", { action: "change", oldPin, newPin });
}

export interface PaymentDetailsResult {
  ok?: boolean;
  error?: string;
  message?: string;
}

export function savePaymentDetails(pin: string, pd: PaymentDetails): Promise<PaymentDetailsResult> {
  return postJson<PaymentDetailsResult>("/api/payment-details", { pin, ...pd });
}
