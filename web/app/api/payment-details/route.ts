import { NextResponse } from "next/server";
import { checkPin, setPaymentDetails } from "@/lib/sheets";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const pinCheck = await checkPin(String(body?.pin || ""));
    if (!pinCheck.ok) {
      return NextResponse.json({ error: pinCheck.error, message: pinCheck.message }, { status: 401 });
    }
    await setPaymentDetails({
      accountNumber: String(body?.accountNumber || ""),
      accountName: String(body?.accountName || ""),
      bankName: String(body?.bankName || ""),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "server_error", message: String(err) }, { status: 500 });
  }
}
