import { resetServiceActions } from "@/lib/work-context";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const actions = await resetServiceActions();
    return NextResponse.json({ ok: true, actions });
  } catch (err) {
    console.error("work-context reset failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reset failed" },
      { status: 500 },
    );
  }
}
