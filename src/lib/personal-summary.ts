import { GoogleGenAI, Type } from "@google/genai";
import { allFacts } from "./memory";
import type {
  CollisionCard,
  MemoryFact,
  Person,
  PersonalSummary,
  PersonalSummaryResult,
  Utterance,
} from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let client: GoogleGenAI | null = null;
function genai(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/**
 * The post-meeting personal summary engine.
 *
 * The Collision engine watches a meeting live and pushes alerts in the moment.
 * This engine looks back at the whole meeting after it ends and rewrites it
 * from one specific person's point of view: what *you* now own, what was
 * decided that affects *you*, which collisions mention *you*, and what
 * questions *you* should pick up.
 *
 * The point isn't a generic recap — it's the one paragraph this person should
 * read on their walk back from the meeting room.
 */
const SYSTEM_INSTRUCTION = `You are the post-meeting Personal Summary engine.

You are given:
1. A named team member (the "you" of this summary) — their name, role, team,
   and what they personally care about.
2. The full transcript of a meeting they were in.
3. The collision cards that fired during the meeting.
4. The company memory facts that pertain to this person.

Write a tight, second-person summary that this person can read in 30 seconds
on their walk back from the meeting room. Address them as "you".

Be ruthless about relevance. Only include things that:
- this person personally committed to or was assigned,
- this person personally owns the consequences of,
- or directly contradict / depend on facts this person owns.

Do NOT include generic meeting recap, unrelated topics, or things any
participant could have written down themselves. The value is the
*personalization* — what they would have missed if they hadn't read this.

Sections to produce:
- bottomLine: ONE sentence. The single most important thing for this person.
  If they read only one line, this is it.
- actionItems: things they now own. Phrase in second person, imperative
  ("Confirm with Legal that the DPA update has shipped before promising any
  Feature X timeline."). Include a dueHint if the meeting mentioned one,
  otherwise leave empty. basedOn is a short verbatim excerpt from the
  transcript that established the item.
- decisionsAffectingYou: meeting decisions that touch their scope. whyItMattersToYou
  must reference the person's role or owned facts.
- flagsRaised: collision cards from the meeting where this person is
  named, where they own the conflicting fact, or where they are the natural
  next responder. relevance explains the personal angle in one short line.
- openQuestions: things the meeting raised and never resolved that this
  person should pick up. whyYou says why it's their question.

If a section has nothing genuinely relevant, return an empty array. Do not
pad. Better to send one item that lands than five that don't.

Tone: direct, kind, low-drama. Like a sharp chief of staff briefing this
person. No corporate filler. No "the team should..." — always "you".`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    bottomLine: { type: Type.STRING },
    actionItems: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING },
          dueHint: { type: Type.STRING },
          basedOn: { type: Type.STRING },
        },
        required: ["item", "basedOn"],
      },
    },
    decisionsAffectingYou: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          decision: { type: Type.STRING },
          whyItMattersToYou: { type: Type.STRING },
          driver: { type: Type.STRING },
        },
        required: ["decision", "whyItMattersToYou"],
      },
    },
    flagsRaised: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          collisionType: {
            type: Type.STRING,
            enum: [
              "legal_compliance",
              "previous_decision",
              "priority_capacity",
              "dependency_blocker",
              "customer_promise",
            ],
          },
          headline: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
          relevance: { type: Type.STRING },
        },
        required: ["collisionType", "headline", "severity", "relevance"],
      },
    },
    openQuestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          whyYou: { type: Type.STRING },
        },
        required: ["question", "whyYou"],
      },
    },
  },
  required: [
    "bottomLine",
    "actionItems",
    "decisionsAffectingYou",
    "flagsRaised",
    "openQuestions",
  ],
};

function factForPrompt(f: MemoryFact) {
  return {
    id: f.id,
    type: f.type,
    entity: f.entity,
    source: f.source,
    statement: f.statement,
    reason: f.reason,
    activeP0s: f.activeP0s,
    rule: f.rule,
  };
}

function cardForPrompt(c: CollisionCard) {
  return {
    collisionType: c.collisionType,
    title: c.title,
    headline: c.headline,
    severity: c.severity,
    reason: c.reason,
    suggestedNextStep: c.suggestedNextStep,
    factIds: c.factIds,
    triggeredBy: c.triggeredBy,
    evidence: c.evidence,
  };
}

export interface SummarizeArgs {
  person: Person;
  utterances: Utterance[];
  cards: CollisionCard[];
}

export async function summarizeForPerson(
  args: SummarizeArgs,
): Promise<PersonalSummaryResult> {
  // Pull in the person's owned facts plus any fact referenced by a card —
  // the collision evidence is part of what the LLM should reason over.
  const facts = allFacts();
  const referencedFactIds = new Set<string>([
    ...args.person.ownedFactIds,
    ...args.cards.flatMap((c) => c.factIds ?? []),
  ]);
  const relevantFacts = facts.filter((f) => referencedFactIds.has(f.id));

  const prompt = JSON.stringify(
    {
      you: {
        name: args.person.name,
        role: args.person.role,
        team: args.person.team,
        perspective: args.person.perspective,
        ownedFactIds: args.person.ownedFactIds,
      },
      transcript: args.utterances.map((u) => ({
        speaker: u.speaker,
        text: u.text,
      })),
      collisionCards: args.cards.map(cardForPrompt),
      memoryFactsForYou: relevantFacts.map(factForPrompt),
    },
    null,
    2,
  );

  const res = await genai().models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.3,
      // Slightly larger budget than the live collision call — this is a
      // structured summary, not a single card.
      maxOutputTokens: 2000,
    },
  });

  const raw = res.text;
  const empty: PersonalSummary = {
    person: {
      id: args.person.id,
      name: args.person.name,
      role: args.person.role,
    },
    bottomLine: "",
    actionItems: [],
    decisionsAffectingYou: [],
    flagsRaised: [],
    openQuestions: [],
  };
  if (!raw) return { summary: empty };

  let parsed: Omit<PersonalSummary, "person">;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { summary: empty };
  }

  return {
    summary: {
      person: {
        id: args.person.id,
        name: args.person.name,
        role: args.person.role,
      },
      bottomLine: parsed.bottomLine ?? "",
      actionItems: parsed.actionItems ?? [],
      decisionsAffectingYou: parsed.decisionsAffectingYou ?? [],
      flagsRaised: parsed.flagsRaised ?? [],
      openQuestions: parsed.openQuestions ?? [],
    },
  };
}
