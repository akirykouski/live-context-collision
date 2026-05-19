import { summarizeForPerson } from "@/lib/personal-summary";
import type { CollisionCard, Person, Utterance } from "@/lib/types";
import people from "@/data/people.json";
import { aiErrorResponse } from "@/lib/api-error";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface SummaryRequestBody {
  personId?: string;
  utterances?: Utterance[];
  cards?: CollisionCard[];
}

export async function POST(req: Request) {
  let body: SummaryRequestBody;
  try {
    body = (await req.json()) as SummaryRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const personId = body.personId;
  if (!personId) {
    return NextResponse.json({ error: "personId required" }, { status: 400 });
  }

  const person = (people.people as Person[]).find((p) => p.id === personId);
  if (!person) {
    return NextResponse.json({ error: "unknown person" }, { status: 404 });
  }

  const utterances = body.utterances ?? [];
  const cards = body.cards ?? [];

  // Hard floor — an empty meeting cannot be summarised meaningfully. Return
  // an explicit "nothing to report" instead of paying for a useless LLM call.
  if (utterances.length === 0) {
    return NextResponse.json({
      summary: {
        person: { id: person.id, name: person.name, role: person.role },
        bottomLine: "Nothing to summarise — the meeting recorded no speech.",
        actionItems: [],
        decisionsAffectingYou: [],
        flagsRaised: [],
        openQuestions: [],
      },
    });
  }

  try {
    const result = await summarizeForPerson({ person, utterances, cards });
    return NextResponse.json(result);
  } catch (err) {
    return aiErrorResponse(err, "personal-summary");
  }
}
