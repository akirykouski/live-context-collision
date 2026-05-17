import { analyzeUtterance } from "@/lib/gemini";
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
    return NextResponse.json(result);
  } catch (err) {
    console.error("collision analyze failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "engine error" },
      { status: 500 },
    );
  }
}
