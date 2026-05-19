import { createSpeechmaticsJWT } from "@speechmatics/auth";
import { NextResponse } from "next/server";
import { buildAdditionalVocab } from "@/lib/transcript/dictionary-builder";
import type { AdditionalVocabEntry } from "@/lib/types";

// The browser connects directly to Speechmatics' real-time endpoint, but it
// must never see the long-lived API key. This route exchanges the server-side
// API key for a short-lived JWT scoped to real-time transcription. It now also
// returns Layer 1's `additional_vocab` payload so the browser can seed
// transcription_config.additional_vocab before recognition starts.
export const dynamic = "force-dynamic";

export async function GET(req?: Request) {
  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "SPEECHMATICS_API_KEY is not set" },
      { status: 500 },
    );
  }

  try {
    const jwt = await createSpeechmaticsJWT({
      type: "rt",
      apiKey,
      ttl: 60, // seconds — just long enough to open the socket
    });

    // Layer 1: build the custom dictionary. This is strictly additive and
    // must never fail the token mint — the builder never throws, but we still
    // guard so a vocab problem degrades to an empty list, not a 502.
    let additionalVocab: AdditionalVocabEntry[] = [];
    try {
      const meetingId =
        (req ? new URL(req.url).searchParams.get("meetingId") : null) ??
        undefined;
      additionalVocab = await buildAdditionalVocab({ meetingId });
    } catch (vocabErr) {
      console.warn(
        "[speechmatics-token] vocab build failed, continuing without it:",
        vocabErr instanceof Error ? vocabErr.message : vocabErr,
      );
      additionalVocab = [];
    }

    return NextResponse.json({ jwt, additionalVocab });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "token mint failed" },
      { status: 502 },
    );
  }
}
