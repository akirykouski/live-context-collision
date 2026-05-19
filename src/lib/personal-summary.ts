import { Type } from "@google/genai";
import { generateContent } from "./ai-gateway";
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

function isEmptySummary(s: Omit<PersonalSummary, "person">): boolean {
  return (
    s.bottomLine.trim().length === 0 &&
    s.actionItems.length === 0 &&
    s.decisionsAffectingYou.length === 0 &&
    s.flagsRaised.length === 0 &&
    s.openQuestions.length === 0
  );
}

/**
 * Last-resort summary built only from data we already hold for certain — the
 * person's owned memory facts and the collision cards that cite them. No model
 * call, no invention: every line is traceable to a fact id or a fired card.
 * A short grounded note beats a blank panel for the person this meeting hit.
 */
function deterministicSummary(
  args: SummarizeArgs,
  relevantFacts: MemoryFact[],
): Omit<PersonalSummary, "person"> {
  const owned = new Set(args.person.ownedFactIds);
  const yourCards = args.cards.filter((c) =>
    (c.factIds ?? []).some((id) => owned.has(id)),
  );

  const flagsRaised = yourCards.map((c) => ({
    collisionType: c.collisionType,
    headline: c.headline,
    severity: c.severity,
    relevance: "You own the memory fact this collision is grounded in.",
  }));

  let bottomLine: string;
  if (yourCards.length > 0) {
    bottomLine = `${yourCards[0].headline} You own the fact behind this — follow up before it ships.`;
  } else if (relevantFacts.length > 0) {
    bottomLine = `This meeting touched ${relevantFacts.length} memory fact(s) you own. Most relevant: ${relevantFacts[0].statement}`;
  } else {
    bottomLine =
      "Nothing in this meeting was specific to you based on the facts you own.";
  }

  return {
    bottomLine,
    actionItems: [],
    decisionsAffectingYou: [],
    flagsRaised,
    openQuestions: [],
  };
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

  const person = {
    id: args.person.id,
    name: args.person.name,
    role: args.person.role,
  };

  const attempt = async (): Promise<Omit<PersonalSummary, "person"> | null> => {
    const { response: res } = await generateContent({
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
    if (!raw) return null;
    let parsed: Omit<PersonalSummary, "person">;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const normalized: Omit<PersonalSummary, "person"> = {
      bottomLine: parsed.bottomLine ?? "",
      actionItems: parsed.actionItems ?? [],
      decisionsAffectingYou: parsed.decisionsAffectingYou ?? [],
      flagsRaised: parsed.flagsRaised ?? [],
      openQuestions: parsed.openQuestions ?? [],
    };
    // A structurally-valid but entirely empty draft is the observed failure
    // mode: the model returns nothing for the person the meeting most
    // affects. Treat that as "no usable output" so we retry / ground it.
    return isEmptySummary(normalized) ? null : normalized;
  };

  // The model is non-deterministic; an empty draft for a clearly-affected
  // person is often non-empty on a second draw. Retry once, then fall back
  // to a deterministic, strictly-grounded summary so the person who needed
  // this most never gets a blank panel.
  const draft = (await attempt()) ?? (await attempt());
  const body = draft ?? deterministicSummary(args, relevantFacts);

  return { summary: { person, ...body } };
}
