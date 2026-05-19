// GET /api/prewarm/status?meetingId=...
//
// Returns the prewarm status + manifest for a meeting so the Action Center can
// show post-meeting review (sources touched, facts + scores, hot-key health).

import { NextResponse } from "next/server";
import { aiErrorResponse } from "@/lib/api-error";
import { getValkey, hasValkey } from "@/lib/valkey";
import { prewarmKeys } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const meetingId = new URL(req.url).searchParams.get("meetingId")?.trim();
  if (!meetingId) {
    return NextResponse.json(
      { error: "meetingId is required" },
      { status: 400 },
    );
  }

  if (!hasValkey()) {
    return NextResponse.json({
      meetingId,
      prewarmed: false,
      valkey: false,
      manifest: null,
    });
  }

  try {
    const v = getValkey();
    const [marker, manifestRaw, hotLen] = await Promise.all([
      v.exists(prewarmKeys.marker(meetingId)),
      v.get(prewarmKeys.manifest(meetingId)),
      v.exists(prewarmKeys.hot(meetingId)),
    ]);

    let manifest: unknown = null;
    if (manifestRaw) {
      try {
        manifest = JSON.parse(manifestRaw);
      } catch {
        manifest = null;
      }
    }

    return NextResponse.json({
      meetingId,
      prewarmed: marker === 1,
      hotKeyPresent: hotLen === 1,
      valkey: true,
      manifest,
    });
  } catch (err) {
    return aiErrorResponse(err, "prewarm:status");
  }
}
