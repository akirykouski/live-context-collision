import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryFact, RawUtterance } from "@/lib/types";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ generateContent }));

const FACTS: MemoryFact[] = [
  {
    id: "eng-sso-auth",
    type: "engineering_blocker",
    entity: "SSO",
    related: ["Auth Refactor"],
    status: "active",
    source: "Eng Sync",
    statement: "SSO depends on the Auth Refactor.",
  },
];
vi.mock("@/lib/memory", () => ({ allFacts: () => FACTS }));

import { normalizeWindow } from "@/lib/transcript/window-normalizer";

const WINDOW: RawUtterance[] = [
  {
    id: "w1",
    meetingId: "m1",
    speakerId: "s1",
    startMs: 0,
    endMs: 1000,
    text: "We talked about the SSO work earlier.",
  },
  {
    id: "w2",
    meetingId: "m1",
    speakerId: "s2",
    startMs: 1000,
    endMs: 2000,
    text: "Can we ship that this week?",
  },
];

function reply(payload: unknown) {
  generateContent.mockResolvedValueOnce({
    response: { text: JSON.stringify(payload) },
    servedBy: "TEST",
  });
}

beforeEach(() => generateContent.mockReset());

describe("Layer 3 window-normalizer", () => {
  it("resolves a cross-reference and returns the documented shape", async () => {
    reply({
      referenceResolutions: [
        {
          rawUtteranceId: "w2",
          referenceText: "that",
          canonicalEntityId: "eng-sso-auth",
          canonicalLabel: "SSO",
          confidence: 0.91,
        },
      ],
      topicAnchors: [{ label: "SSO launch", rawUtteranceIds: ["w1", "w2"] }],
    });

    const out = await normalizeWindow({ utterances: WINDOW });
    expect(out.windowStartId).toBe("w1");
    expect(out.windowEndId).toBe("w2");
    expect(out.referenceResolutions).toHaveLength(1);
    expect(out.referenceResolutions[0]).toMatchObject({
      rawUtteranceId: "w2",
      canonicalEntityId: "eng-sso-auth",
      confidence: 0.91,
    });
    expect(out.topicAnchors[0].rawUtteranceIds).toEqual(["w1", "w2"]);
  });

  it("drops sub-threshold and invalid resolutions", async () => {
    reply({
      referenceResolutions: [
        {
          rawUtteranceId: "w2",
          referenceText: "that",
          canonicalEntityId: "eng-sso-auth",
          canonicalLabel: "SSO",
          confidence: 0.5, // below 0.8 gate
        },
        {
          rawUtteranceId: "w2",
          referenceText: "it",
          canonicalEntityId: "ghost-entity", // not in the graph
          canonicalLabel: "Ghost",
          confidence: 0.99,
        },
      ],
      topicAnchors: [],
    });
    const out = await normalizeWindow({ utterances: WINDOW });
    expect(out.referenceResolutions).toHaveLength(0);
  });

  it("returns an empty overlay (no throw) when the gateway fails", async () => {
    generateContent.mockRejectedValueOnce(new Error("all keys down"));
    const out = await normalizeWindow({ utterances: WINDOW });
    expect(out).toEqual({
      windowStartId: "w1",
      windowEndId: "w2",
      referenceResolutions: [],
      topicAnchors: [],
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("returns an empty overlay for an empty window without calling the model", async () => {
    const out = await normalizeWindow({ utterances: [] });
    expect(out).toEqual({
      windowStartId: "",
      windowEndId: "",
      referenceResolutions: [],
      topicAnchors: [],
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("tolerates malformed model output", async () => {
    generateContent.mockResolvedValueOnce({
      response: { text: "{ not json" },
      servedBy: "T",
    });
    const out = await normalizeWindow({ utterances: WINDOW });
    expect(out.referenceResolutions).toEqual([]);
  });
});
