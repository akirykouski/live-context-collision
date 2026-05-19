import { resolveUtterance } from "@/lib/transcript/entity-resolver";
import { aiErrorResponse } from "@/lib/api-error";
import type { RawUtterance } from "@/lib/types";
import { NextResponse } from "next/server";

// Layer 2 endpoint — called per Speechmatics final, in parallel with the
// collision hot path. Mirrors /api/collision: force-dynamic, POST JSON,
// blank input → 200 empty, engine failure → sanitized aiErrorResponse.
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: Request) {
  let body: {
    raw?: Partial<RawUtterance>;
    recent?: { speakerId?: string; text?: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const raw = body.raw;
  const text = raw?.text?.trim();
  if (!raw || !text) {
    // Nothing to resolve — return an empty passthrough overlay.
    return NextResponse.json(
      {
        rawUtteranceId: raw?.id ?? "",
        resolutions: [],
        numericNormalizations: [],
      },
      { status: 200 },
    );
  }

  const rawUtterance: RawUtterance = {
    id: raw.id ?? "",
    meetingId: raw.meetingId ?? "",
    speakerId: raw.speakerId ?? "",
    startMs: raw.startMs ?? 0,
    endMs: raw.endMs ?? 0,
    text: raw.text ?? "",
  };

  try {
    const result = await resolveUtterance({
      raw: rawUtterance,
      recent: body.recent
        ?.slice(-3)
        .map((u) => ({ speakerId: u.speakerId || "", text: u.text || "" })),
    });
    return NextResponse.json(result);
  } catch (err) {
    return aiErrorResponse(err, "transcript-resolve");
  }
}
