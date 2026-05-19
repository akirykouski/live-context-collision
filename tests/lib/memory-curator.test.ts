import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryFact } from "@/lib/types";

const { generateContent } = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));
const { appendLearnedFacts } = vi.hoisted(() => ({
  appendLearnedFacts: vi.fn(async (f: MemoryFact[]) => f),
}));

vi.mock("@/lib/ai-gateway", () => ({ generateContent }));
vi.mock("@/lib/learned-facts", () => ({ appendLearnedFacts }));
vi.mock("@/lib/memory", () => ({ allFacts: () => [] }));

import { curateMemory } from "@/lib/memory-curator";

function reply(payload: unknown) {
  generateContent.mockResolvedValueOnce({
    response: { text: JSON.stringify(payload) },
    servedBy: "TEST",
  });
}

beforeEach(() => {
  generateContent.mockReset();
  appendLearnedFacts.mockClear();
});

describe("curateMemory", () => {
  it("persists a well-formed durable fact from an utterance", async () => {
    reply({
      facts: [
        {
          type: "decision",
          entity: "Acme export",
          related: ["Acme", "export"],
          statement: "Decided to build a custom export for Acme after all.",
          reason: "Renewal at risk.",
          severity: "high",
        },
      ],
    });
    await curateMemory({ speaker: "Speaker 1", text: "Let's build the Acme export." });

    expect(appendLearnedFacts).toHaveBeenCalledTimes(1);
    const persisted = appendLearnedFacts.mock.calls[0][0] as MemoryFact[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      type: "decision",
      entity: "Acme export",
      status: "active",
      severity: "high",
      source: "Live meeting · Speaker 1",
    });
    expect(persisted[0].id).toMatch(/^learned-/);
  });

  it("skips empty text without calling the model", async () => {
    const out = await curateMemory({ speaker: "S", text: "   " });
    expect(out).toEqual([]);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("records nothing when Gemini is unavailable", async () => {
    generateContent.mockRejectedValueOnce(new Error("all keys down"));
    const out = await curateMemory({ speaker: "S", text: "We decided X." });
    expect(out).toEqual([]);
    expect(appendLearnedFacts).not.toHaveBeenCalled();
  });

  it("ignores malformed model output and invalid fact types", async () => {
    generateContent.mockResolvedValueOnce({
      response: { text: "{ not json" },
      servedBy: "T",
    });
    await curateMemory({ speaker: "S", text: "anything" });

    reply({ facts: [{ type: "gossip", entity: "x", statement: "y", severity: "low" }] });
    await curateMemory({ speaker: "S", text: "anything else" });

    expect(appendLearnedFacts).not.toHaveBeenCalled();
  });
});
