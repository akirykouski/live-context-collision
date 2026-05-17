import { gatewayStatus } from "@/lib/ai-gateway";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Lightweight health view of the Gemini key pool (labels + cooldown only —
// never the key values).
export async function GET() {
  try {
    return NextResponse.json({ keys: gatewayStatus() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "gateway not configured" },
      { status: 500 },
    );
  }
}
