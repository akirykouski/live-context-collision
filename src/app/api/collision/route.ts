import { analyzeUtterance } from "@/lib/gemini";
import { curateMemory } from "@/lib/memory-curator";
import { aiErrorResponse } from "@/lib/api-error";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: {
    speaker?: string;
    text?: string;
    recentTranscript?: { speaker: string; text: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const text = body.text?.trim();
  if (!text) {
    return NextResponse.json(
      { collisionDetected: false, cards: [] },
      { status: 200 },
    );
  }

  try {
    const result = await analyzeUtterance({
      speaker: body.speaker || "Speaker",
      text,
      recentTranscript: body.recentTranscript?.slice(-6),
    });

    // Write-back loop: off the hot path. The card is already computed; the
    // curator learns durable facts from this utterance so a *later* statement
    // in the same meeting can collide against it. Fire-and-forget — the
    // long-lived server keeps this promise alive after the response is sent,
    // and a curation failure must never affect the collision response.
    void curateMemory({
      speaker: body.speaker || "Speaker",
      text,
      recentTranscript: body.recentTranscript?.slice(-6),
    }).catch((err) =>
      console.warn(
        "[collision] memory curation failed:",
        err instanceof Error ? err.message : err,
      ),
    );

    return NextResponse.json(result);
  } catch (err) {
    return aiErrorResponse(err, "collision");
  }
}
