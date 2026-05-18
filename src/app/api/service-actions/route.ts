import { analyzeServiceActions } from "@/lib/service-actions";
import type { ServiceActionResult } from "@/lib/types";
import { appendServiceActions, getWorkContext } from "@/lib/work-context";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface ServiceActionRequestBody {
  speaker?: string;
  text?: string;
  recentTranscript?: { speaker: string; text: string }[];
}

export async function POST(req: Request) {
  let body: ServiceActionRequestBody;
  try {
    body = (await req.json()) as ServiceActionRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const text = body.text?.trim();
  if (!text) {
    return NextResponse.json(
      { actionDetected: false, actions: [] } satisfies ServiceActionResult,
      { status: 200 },
    );
  }

  try {
    const context = await getWorkContext();
    const result = await analyzeServiceActions({
      speaker: body.speaker || "Speaker",
      text,
      recentTranscript: body.recentTranscript?.slice(-6),
      artifacts: context.artifacts,
      existingActions: context.actions,
    });

    if (result.actions.length > 0) {
      await appendServiceActions(result.actions);
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("service-actions failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "service action error" },
      { status: 500 },
    );
  }
}
