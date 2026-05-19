import { describe, it, expect, vi, beforeEach } from "vitest";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ generateContent }));

import { analyzeUtterance } from "@/lib/gemini";

function reply(payload: unknown) {
  generateContent.mockResolvedValueOnce({
    response: { text: JSON.stringify(payload) },
    servedBy: "TEST",
  });
}

beforeEach(() => generateContent.mockReset());

describe("gemini.analyzeUtterance", () => {
  it("retrieves relevant memory facts into the prompt", async () => {
    reply({ collisionDetected: false, cards: [] });
    await analyzeUtterance({
      speaker: "Speaker 1",
      text: "Let's promise Acme a Friday launch for Feature X.",
    });
    const prompt = generateContent.mock.calls[0][0].contents as string;
    expect(prompt).toContain("legal-featurex");
    expect(prompt).toContain("Speaker 1");
  });

  it("returns no collision when the model returns empty text", async () => {
    generateContent.mockResolvedValueOnce({
      response: { text: "" },
      servedBy: "T",
    });
    const res = await analyzeUtterance({ speaker: "S", text: "hello" });
    expect(res).toEqual({ collisionDetected: false, cards: [] });
  });

  it("swallows malformed JSON", async () => {
    generateContent.mockResolvedValueOnce({
      response: { text: "{ broken" },
      servedBy: "T",
    });
    const res = await analyzeUtterance({ speaker: "S", text: "hello" });
    expect(res).toEqual({ collisionDetected: false, cards: [] });
  });

  it("hydrates cards with an id, trigger and safe defaults", async () => {
    reply({
      collisionDetected: true,
      cards: [
        {
          collisionType: "legal_compliance",
          title: "Already blocked",
          headline: "Feature X is blocked by Legal.",
          severity: "high",
          // evidence + factIds intentionally omitted to test defaults
        },
      ],
    });
    const res = await analyzeUtterance({
      speaker: "Speaker 2",
      text: "Ship Feature X now.",
    });
    expect(res.collisionDetected).toBe(true);
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].id).toBeTruthy();
    expect(res.cards[0].evidence).toEqual([]);
    expect(res.cards[0].factIds).toEqual([]);
    expect(res.cards[0].triggeredBy).toEqual({
      speaker: "Speaker 2",
      text: "Ship Feature X now.",
    });
  });

  it("does not report a collision when the model flags one but emits no cards", async () => {
    reply({ collisionDetected: true, cards: [] });
    const res = await analyzeUtterance({ speaker: "S", text: "anything" });
    expect(res.collisionDetected).toBe(false);
  });

  it("does not report a collision when cards exist but the flag is false", async () => {
    reply({
      collisionDetected: false,
      cards: [
        {
          collisionType: "previous_decision",
          title: "x",
          headline: "y",
          severity: "low",
        },
      ],
    });
    const res = await analyzeUtterance({ speaker: "S", text: "anything" });
    expect(res.collisionDetected).toBe(false);
  });
});
