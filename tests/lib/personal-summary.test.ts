import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CollisionCard, Person } from "@/lib/types";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ generateContent }));

import { summarizeForPerson } from "@/lib/personal-summary";

const person: Person = {
  id: "valya",
  name: "Valya",
  role: "Engineering IC",
  team: "Platform",
  ownedFactIds: ["capacity-valya"],
  perspective: "You own engineering execution on your assigned P0s.",
};

const utterances = [
  { id: "u1", speaker: "Speaker 1", text: "Valya, take the new P0.", at: 1 },
];

const card: CollisionCard = {
  id: "c1",
  collisionType: "legal_compliance",
  title: "Blocked",
  headline: "Feature X is blocked by Legal.",
  evidence: [],
  severity: "high",
  factIds: ["legal-featurex"],
  triggeredBy: { speaker: "Speaker 2", text: "Ship Feature X." },
};

function reply(payload: unknown) {
  generateContent.mockResolvedValueOnce({
    response: { text: JSON.stringify(payload) },
    servedBy: "TEST",
  });
}

beforeEach(() => generateContent.mockReset());

describe("personal-summary.summarizeForPerson", () => {
  it("scopes memory facts to the person's owned + card-referenced facts", async () => {
    reply({
      bottomLine: "You picked up a 4th P0.",
      actionItems: [],
      decisionsAffectingYou: [],
      flagsRaised: [],
      openQuestions: [],
    });
    await summarizeForPerson({ person, utterances, cards: [card] });
    const prompt = generateContent.mock.calls[0][0].contents as string;
    expect(prompt).toContain("capacity-valya"); // owned
    expect(prompt).toContain("legal-featurex"); // referenced by a card
    expect(prompt).not.toContain("decision-acme-export"); // unrelated
  });

  it("retries once when the model yields no text", async () => {
    generateContent
      .mockResolvedValueOnce({ response: { text: "" }, servedBy: "T" })
      .mockResolvedValueOnce({
        response: {
          text: JSON.stringify({
            bottomLine: "Second draw worked.",
            actionItems: [],
            decisionsAffectingYou: [],
            flagsRaised: [],
            openQuestions: [],
          }),
        },
        servedBy: "T",
      });
    const { summary } = await summarizeForPerson({
      person,
      utterances,
      cards: [],
    });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(summary.bottomLine).toBe("Second draw worked.");
  });

  it("never returns a blank summary for an affected person — deterministic grounded fallback", async () => {
    // Both attempts produce nothing usable (the observed Valya failure mode).
    generateContent.mockResolvedValue({
      response: { text: "" },
      servedBy: "T",
    });
    const valyaCard = { ...card, factIds: ["capacity-valya"] };
    const { summary } = await summarizeForPerson({
      person,
      utterances,
      cards: [valyaCard],
    });
    expect(generateContent).toHaveBeenCalledTimes(2); // tried, then grounded
    expect(summary.person).toEqual({
      id: "valya",
      name: "Valya",
      role: "Engineering IC",
    });
    // Not blank: grounded strictly in the card that cites a fact she owns.
    expect(summary.bottomLine.length).toBeGreaterThan(0);
    expect(summary.flagsRaised).toHaveLength(1);
    expect(summary.flagsRaised[0].headline).toBe(card.headline);
    expect(summary.flagsRaised[0].relevance).toMatch(/own the memory fact/i);
    // Nothing invented for sections we cannot ground without the model.
    expect(summary.actionItems).toEqual([]);
    expect(summary.decisionsAffectingYou).toEqual([]);
  });

  it("grounds the fallback in owned facts when no card cites them", async () => {
    generateContent.mockResolvedValue({
      response: { text: "}{ not json" },
      servedBy: "T",
    });
    const { summary } = await summarizeForPerson({
      person,
      utterances,
      cards: [],
    });
    expect(summary.flagsRaised).toEqual([]);
    // Falls to the owned-fact statement, never an empty bottom line.
    expect(summary.bottomLine).toMatch(/memory fact\(s\) you own/i);
  });

  it("maps a well-formed summary and stamps the person", async () => {
    reply({
      bottomLine: "You now own a 4th P0 — flag your capacity.",
      actionItems: [{ item: "Push back on the new P0.", basedOn: "take the new P0" }],
      decisionsAffectingYou: [
        { decision: "Auth refactor stays P0", whyItMattersToYou: "You own it." },
      ],
      flagsRaised: [
        {
          collisionType: "priority_capacity",
          headline: "Capacity overload",
          severity: "high",
          relevance: "You already own 3 P0s.",
        },
      ],
      openQuestions: [{ question: "Which P0 gets downgraded?", whyYou: "It is yours." }],
    });
    const { summary } = await summarizeForPerson({
      person,
      utterances,
      cards: [card],
    });
    expect(summary.person.name).toBe("Valya");
    expect(summary.bottomLine).toMatch(/4th P0/);
    expect(summary.actionItems[0].item).toBe("Push back on the new P0.");
    expect(summary.flagsRaised[0].severity).toBe("high");
    expect(summary.openQuestions).toHaveLength(1);
  });

  it("tolerates partial payloads by defaulting missing sections", async () => {
    reply({ bottomLine: "Just this." });
    const { summary } = await summarizeForPerson({
      person,
      utterances,
      cards: [],
    });
    expect(summary.bottomLine).toBe("Just this.");
    expect(summary.actionItems).toEqual([]);
    expect(summary.decisionsAffectingYou).toEqual([]);
    expect(summary.flagsRaised).toEqual([]);
    expect(summary.openQuestions).toEqual([]);
  });
});
