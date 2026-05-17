import { createSpeechmaticsJWT } from "@speechmatics/auth";
import { NextResponse } from "next/server";

// The browser connects directly to Speechmatics' real-time endpoint, but it
// must never see the long-lived API key. This route exchanges the server-side
// API key for a short-lived JWT scoped to real-time transcription.
export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({ jwt });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "token mint failed" },
      { status: 502 },
    );
  }
}
