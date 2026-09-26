import { NextResponse } from "next/server";
import { getState } from "@/lib/sheets";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const state = await getState();
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json({ error: "server_error", message: String(err) }, { status: 500 });
  }
}
