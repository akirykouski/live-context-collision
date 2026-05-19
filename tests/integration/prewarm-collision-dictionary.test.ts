/**
 * End-to-end integration of the two features through their shared seam.
 *
 * Proves the real wiring, not mocks-of-mocks:
 *   Pre-Warmer.hotLoad()  ──writes──▶  prewarmKeys.hot / prewarmKeys.vocab
 *        │                                     │
 *        ▼                                     ▼
 *   gemini.analyzeUtterance({meetingId})   transcript Layer 1
 *   consumes the HOT facts (not the          buildAdditionalVocab()
 *   cold graph)                              consumes the SAME vocab key
 *
 * A single in-memory Valkey is shared by all three modules so a write by the
 * prewarmer is observed by the collision orchestrator and the dictionary
 * builder exactly as it would be in production.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { store, ttls, valkeyState, fakeValkey } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const valkeyState = { available: true };
  const fakeValkey = {
    async set(k: string, v: string) {
      store.set(k, v);
      return "OK";
    },
    async expire(k: string, s: number) {
      ttls.set(k, s);
      return 1;
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    // learned-facts uses these on the hot path; keep it empty + harmless.
    async lrange() {
      return [] as string[];
    },
    async rpush() {
      return 1;
    },
    async del() {
      return 1;
    },
  };
  return { store, ttls, valkeyState, fakeValkey };
});

vi.mock("@/lib/valkey", () => ({
  hasValkey: () => valkeyState.available,
  getValkey: () => fakeValkey,
  getValkeyUrl: () => "redis://fake",
  closeValkey: async () => {},
}));

// Each specialist call echoes a grounded card built from the FIRST memory fact
// it was given — so the card's factIds reveal exactly which candidate pool
// (hot vs cold) actually fed the judges.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@/lib/ai-gateway", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai-gateway")>(
      "@/lib/ai-gateway",
    );
  return { ...actual, generateContent };
});

import { analyzeUtterance } from "@/lib/gemini";
import { prewarmHitStats } from "@/lib/collision/specialists";
import { hotLoad } from "@/lib/prewarm/hot-loader";
import { buildAdditionalVocab } from "@/lib/transcript/dictionary-builder";
import { prewarmKeys } from "@/lib/types";
import type { MemoryFact } from "@/lib/types";
import type { RankedFact, UpcomingMeeting } from "@/lib/prewarm/types";

const NOW = 1_700_000_000_000;
const MEETING_ID = "perf-mtg";

// A fact that exists ONLY in the prewarmed hot set — its entity/terms are
// chosen so the cold lexical retriever would never surface it for our
// utterance. If a card cites it, the hot key (not the graph) fed the judge.
const PREWARM_ONLY: MemoryFact = {
  id: "prewarm-only-zentron",
  type: "decision",
  entity: "Zentron Protocol",
  related: ["Zentron", "migration freeze"],
  status: "active",
  source: "Prewarm: Architecture Council, last sprint",
  statement:
    "Decision: freeze the Zentron Protocol migration until Q4 capacity opens.",
  reason: "No owner has bandwidth before the Zentron freeze lifts.",
  severity: "high",
};

const meeting: UpcomingMeeting = {
  id: MEETING_ID,
  title: "Zentron sync",
  startMs: NOW + 8 * 60_000,
  endMs: NOW + 38 * 60_000,
  organizer: "diego",
  attendees: [{ id: "diego" }, { id: "alex" }],
  agenda: "Zentron Protocol migration",
};

function rankedHot(): RankedFact[] {
  return [
    {
      id: PREWARM_ONLY.id,
      source: "graph",
      entityIds: ["Zentron Protocol", "Zentron"],
      text: PREWARM_ONLY.statement,
      timestamp: NOW,
      raw: PREWARM_ONLY,
      memoryFact: PREWARM_ONLY,
      score: 9.9,
    },
  ];
}

// Build a grounded, verifier-passing card from memoryFacts[0] in the prompt.
function echoFirstFactAsCard(params: { contents: unknown }) {
  const prompt = JSON.parse(String(params.contents)) as {
    memoryFacts: { id: string; source: string; statement: string }[];
  };
  const f = prompt.memoryFacts[0];
  return {
    servedBy: "mock",
    response: {
      text: JSON.stringify({
        collisionDetected: true,
        cards: [
          {
            title: "Context collision detected",
            headline: "Conflicts with a prior decision.",
            evidence: [{ source: f.source, quote: f.statement }],
            severity: "high",
            factIds: [f.id],
          },
        ],
      }),
    },
  };
}

beforeEach(() => {
  store.clear();
  ttls.clear();
  valkeyState.available = true;
  prewarmHitStats.hits = 0;
  prewarmHitStats.misses = 0;
  generateContent.mockReset();
  generateContent.mockImplementation(async (p: { contents: unknown }) =>
    echoFirstFactAsCard(p),
  );
});

describe("Pre-Warmer → collision → dictionary, through one shared Valkey", () => {
  it("collision consumes the HOT facts when the meeting was prewarmed", async () => {
    const res = await hotLoad({
      meeting,
      ranked: rankedHot(),
      sources: [{ name: "graph", latencyMs: 2, count: 1 }],
      rankerInputCount: 1,
      now: NOW,
    });
    expect(res.written).toBe(true);

    const result = await analyzeUtterance({
      speaker: "Diego",
      text: "Let's just kick off the Zentron Protocol migration this week.",
      meetingId: MEETING_ID,
    });

    expect(result.collisionDetected).toBe(true);
    // The card is grounded in the prewarm-only fact → the hot key, not the
    // cold graph, fed the specialists.
    expect(result.cards.flatMap((c) => c.factIds)).toContain(PREWARM_ONLY.id);
    expect(prewarmHitStats.hits).toBe(1);
    expect(prewarmHitStats.misses).toBe(0);
  });

  it("falls back to the cold graph (no regression) when not prewarmed", async () => {
    // No hotLoad → hot key absent.
    const result = await analyzeUtterance({
      speaker: "Diego",
      text: "Let's just kick off the Zentron Protocol migration this week.",
      meetingId: MEETING_ID,
    });

    // A miss was recorded and the prewarm-only fact never reached the judges.
    expect(prewarmHitStats.hits).toBe(0);
    expect(prewarmHitStats.misses).toBe(1);
    expect(result.cards.flatMap((c) => c.factIds)).not.toContain(
      PREWARM_ONLY.id,
    );
  });

  it("no meetingId is a pure no-op (no hit, no miss recorded)", async () => {
    await analyzeUtterance({ speaker: "Diego", text: "Ship Feature X today." });
    expect(prewarmHitStats.hits).toBe(0);
    expect(prewarmHitStats.misses).toBe(0);
  });

  it("Layer 1 dictionary reads the SAME vocab key the prewarmer wrote", async () => {
    await hotLoad({
      meeting,
      ranked: rankedHot(),
      sources: [{ name: "graph", latencyMs: 2, count: 1 }],
      rankerInputCount: 1,
      now: NOW,
    });

    const vocab = await buildAdditionalVocab({ meetingId: MEETING_ID });
    const contents = vocab.map((v) => v.content);
    expect(contents).toContain("Zentron Protocol");
    // Local sources (people/memory) are still merged in.
    expect(vocab.length).toBeGreaterThan(1);
  });
});
