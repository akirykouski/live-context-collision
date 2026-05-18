import { getWorkContext } from "@/lib/work-context";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const context = await getWorkContext();
    return NextResponse.json(context);
  } catch (err) {
    console.error("work-context failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "work context error" },
      { status: 500 },
    );
  }
}
