import { NextResponse } from "next/server";
import { checkPin, changePin, setPin } from "@/lib/sheets";

export const dynamic = "force-dynamic";

// One endpoint for the three PIN actions the old google.script.run API
// exposed as api_setPin / api_verifyPin / api_changePin.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === "set") {
      const res = await setPin(String(body?.pin || ""));
      return NextResponse.json(res);
    }
    if (action === "verify") {
      const res = await checkPin(String(body?.pin || ""));
      return NextResponse.json({ ok: res.ok, error: res.error, message: res.message });
    }
    if (action === "change") {
      const res = await changePin(String(body?.oldPin || ""), String(body?.newPin || ""));
      return NextResponse.json(res);
    }
    return NextResponse.json({ error: "unknown_action", message: "Unknown PIN action: " + action }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: "server_error", message: String(err) }, { status: 500 });
  }
}
