import { normalizeWindow } from "@/lib/transcript/window-normalizer";
import { aiErrorResponse } from "@/lib/api-error";
import type { RawUtterance } from "@/lib/types";
import { NextResponse } from "next/server";

// Layer 3 endpoint — called by the per-session scheduler every ~75s. Off the
// collision hot path. Mirrors /api/collision: force-dynamic, POST JSON, empty
// window → 200 empty overlay, engine failure → sanitized aiErrorResponse.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: { utterances?: Partial<RawUtterance>[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const incoming = Array.isArray(body.utterances) ? body.utterances : [];
  const utterances: RawUtterance[] = incoming
    .filter((u) => u && typeof u.text === "string" && u.text.trim().length > 0)
    .map((u) => ({
      id: u.id ?? "",
      meetingId: u.meetingId ?? "",
      speakerId: u.speakerId ?? "",
      startMs: u.startMs ?? 0,
      endMs: u.endMs ?? 0,
      text: u.text ?? "",
    }));

  if (utterances.length === 0) {
    return NextResponse.json(
      {
        windowStartId: "",
        windowEndId: "",
        referenceResolutions: [],
        topicAnchors: [],
      },
      { status: 200 },
    );
  }

  try {
    const result = await normalizeWindow({ utterances });
    return NextResponse.json(result);
  } catch (err) {
    return aiErrorResponse(err, "transcript-normalize");
  }
}
