import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryFact, RawUtterance } from "@/lib/types";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ generateContent }));

const FACTS: MemoryFact[] = [
  {
    id: "decision-acme-export",
    type: "decision",
    entity: "custom export for Acme",
    related: ["Acme", "export"],
    status: "active",
    source: "Product Sync",
    statement: "Decision: do not build custom export for Acme.",
  },
  {
    id: "eng-sso-auth",
    type: "engineering_blocker",
    entity: "SSO",
    related: ["Auth Refactor", "Acme"],
    status: "active",
    source: "Eng Sync",
    statement: "SSO depends on the Auth Refactor.",
  },
];
vi.mock("@/lib/memory", () => ({ allFacts: () => FACTS }));

import {
  resolveUtterance,
  RESOLUTION_CONFIDENCE_THRESHOLD,
  __test__,
} from "@/lib/transcript/entity-resolver";

function raw(text: string): RawUtterance {
  return {
    id: "u1",
    meetingId: "m1",
    speakerId: "s1",
    startMs: 0,
    endMs: 1000,
    text,
  };
}

function llmReply(payload: unknown) {
  generateContent.mockResolvedValueOnce({
    response: { text: JSON.stringify(payload) },
    servedBy: "TEST",
  });
}

beforeEach(() => generateContent.mockReset());

describe("Layer 2 entity-resolver", () => {
  it("exports the documented confidence threshold", () => {
    expect(RESOLUTION_CONFIDENCE_THRESHOLD).toBe(0.8);
  });

  it("accepts a strong fuzzy match without an LLM call (method=fuzzy)", async () => {
    const r = await resolveUtterance({ raw: raw("Lets talk about SSO today.") });
    expect(generateContent).not.toHaveBeenCalled();
    const sso = r.resolutions.find((x) => x.canonicalEntityId === "eng-sso-auth");
    expect(sso).toBeDefined();
    expect(sso!.method).toBe("fuzzy");
    expect(sso!.confidence).toBeGreaterThanOrEqual(
      RESOLUTION_CONFIDENCE_THRESHOLD,
    );
    // Overlay only — no rewritten text field on the enhanced utterance.
    expect("text" in r).toBe(false);
    // Span points back into the raw text verbatim.
    const [s, e] = sso!.span;
    expect("Lets talk about SSO today.".slice(s, e).toLowerCase()).toBe("sso");
  });

  it("does NOT emit a resolution when LLM confidence is 0.79 (below gate)", async () => {
    llmReply({ canonicalEntityId: "decision-acme-export", confidence: 0.79 });
    const r = await resolveUtterance({
      raw: raw("What about the akme exprt thing we discussed?"),
    });
    expect(
      r.resolutions.find((x) => x.method === "llm"),
    ).toBeUndefined();
  });

  it("emits the LLM resolution exactly at confidence 0.8 (gate inclusive)", async () => {
    // Repeated replies so however many ambiguous spans exist, each gets 0.8.
    generateContent.mockResolvedValue({
      response: {
        text: JSON.stringify({
          canonicalEntityId: "decision-acme-export",
          confidence: 0.8,
        }),
      },
      servedBy: "TEST",
    });
    const r = await resolveUtterance({
      raw: raw("What about the akme exprt thing we discussed?"),
    });
    const llm = r.resolutions.find((x) => x.method === "llm");
    expect(llm).toBeDefined();
    expect(llm!.canonicalEntityId).toBe("decision-acme-export");
    expect(llm!.canonicalLabel).toBe("custom export for Acme");
    expect(llm!.confidence).toBe(0.8);
  });

  it("returns a raw passthrough when the 500ms budget is exceeded", async () => {
    // The LLM call resolves only LONG after the budget — the budget timer must
    // win the race and yield the raw passthrough. The late resolution still
    // settles (no leaked promise) so the suite stays clean.
    generateContent.mockImplementation(
      () =>
        new Promise((res) =>
          setTimeout(
            () =>
              res({
                response: {
                  text: JSON.stringify({
                    canonicalEntityId: "decision-acme-export",
                    confidence: 0.99,
                  }),
                },
                servedBy: "TEST",
              }),
            200,
          ),
        ),
    );
    const r = await resolveUtterance(
      { raw: raw("the akme exprt thing") },
      20, // tiny budget — far below the 200ms mock latency
    );
    expect(r).toEqual({
      rawUtteranceId: "u1",
      resolutions: [],
      numericNormalizations: [],
    });
    // Let the late LLM resolution settle so nothing leaks into the next test.
    await new Promise((res) => setTimeout(res, 220));
  });

  it("does not throw when the gateway fails; yields no LLM resolution", async () => {
    // Repo-standard pattern (see tests/lib/memory-curator.test.ts): a single
    // rejected gateway call that the engine swallows. disambiguate's try/catch
    // absorbs it; resolveUtterance still resolves with no LLM resolution.
    generateContent.mockRejectedValueOnce(new Error("all keys down"));
    const r = await resolveUtterance({
      raw: raw("the akme exprt thing we discussed"),
    });
    expect(r.rawUtteranceId).toBe("u1");
    expect(r.resolutions.find((x) => x.method === "llm")).toBeUndefined();
  });

  it("never mutates the raw text (overlay only)", async () => {
    const original = raw("Ship SSO by next Friday.");
    const snapshot = original.text;
    await resolveUtterance({ raw: original });
    expect(original.text).toBe(snapshot);
  });

  describe("deterministic relative-date normalization", () => {
    it("normalizes today/tomorrow with high confidence", async () => {
      const now = new Date("2026-05-19T12:00:00Z"); // a Tuesday
      const matches = __test__.normalizeDates(
        "We ship today, demo tomorrow.",
        now,
      );
      const today = matches.find((m) => m.rawText.toLowerCase() === "today");
      const tom = matches.find((m) => m.rawText.toLowerCase() === "tomorrow");
      expect(today!.normalized).toBe("2026-05-19");
      expect(tom!.normalized).toBe("2026-05-20");
      expect(today!.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("resolves 'next Friday' relative to the given date", async () => {
      const now = new Date("2026-05-19T12:00:00Z"); // Tuesday
      const m = __test__.normalizeDates("Promise it by next Friday.", now);
      const nf = m.find((x) => /next friday/i.test(x.rawText));
      // This Friday is 2026-05-22; "next Friday" → +7 → 2026-05-29.
      expect(nf!.normalized).toBe("2026-05-29");
    });

    it("emits normalizations through resolveUtterance, gated", async () => {
      const r = await resolveUtterance({ raw: raw("We ship tomorrow.") });
      const n = r.numericNormalizations.find(
        (x) => x.rawText.toLowerCase() === "tomorrow",
      );
      expect(n).toBeDefined();
      expect(n!.confidence).toBeGreaterThanOrEqual(
        RESOLUTION_CONFIDENCE_THRESHOLD,
      );
    });
  });
});
