// POST /api/prewarm/trigger
//
// Manual debug trigger AND the Phase-3 webhook target. Body:
//   { meetingId?: string, force?: boolean }
// No meetingId → run a full scheduler tick (every eligible meeting).
// meetingId    → prewarm that one meeting (force skips the idempotency marker).

import { NextResponse } from "next/server";
import { aiErrorResponse } from "@/lib/api-error";
import { prewarmMeetingById, runScheduler } from "@/lib/prewarm/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { meetingId?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    if (body.meetingId) {
      const result = await prewarmMeetingById(body.meetingId, {
        force: body.force === true,
      });
      return NextResponse.json({ mode: "single", results: [result] });
    }
    const results = await runScheduler();
    return NextResponse.json({
      mode: "scheduler",
      eligible: results.length,
      results,
    });
  } catch (err) {
    return aiErrorResponse(err, "prewarm:trigger");
  }
}
