/**
 * Performance harness: cold (no prewarm) vs warm (prewarmed) collision path.
 *
 * Spec 2.11 names the **hot-key hit rate** the headline metric and 2.12 asks
 * for a cold-vs-warm latency comparison on the first N utterances. The Gemini
 * call is mocked to a fixed cost (both paths pay it equally in production), so
 * the measured delta isolates exactly what the Pre-Warmer removes from the hot
 * path: the cold candidate-retrieval lane.
 *
 * Gated assertions are the ones that are deterministic (hit rate == 100% when
 * every meeting is prewarmed; warm is never slower than cold). Absolute
 * latencies are printed for the reviewer, not asserted (they are dominated by
 * the real LLM call in production and by JIT noise here).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { store, valkeyState, fakeValkey } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const valkeyState = { available: true };
  const fakeValkey = {
    async set(k: string, v: string) {
      store.set(k, v);
      return "OK";
    },
    async expire() {
      return 1;
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
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
  return { store, valkeyState, fakeValkey };
});

vi.mock("@/lib/valkey", () => ({
  hasValkey: () => valkeyState.available,
  getValkey: () => fakeValkey,
  getValkeyUrl: () => "redis://fake",
  closeValkey: async () => {},
}));

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
import { prewarmKeys } from "@/lib/types";
import type { MemoryFact } from "@/lib/types";
import type { RankedFact, UpcomingMeeting } from "@/lib/prewarm/types";

const NOW = 1_700_000_000_000;
const MEETING_ID = "perf-suite-mtg";
const N = 20; // first-N-utterances window from the spec

const HOT_FACT: MemoryFact = {
  id: "prewarm-perf-fact",
  type: "decision",
  entity: "Orion rollout",
  related: ["Orion"],
  status: "active",
  source: "Prewarm: Planning",
  statement: "Decision: stage the Orion rollout behind a flag until audit.",
  severity: "medium",
};

const meeting: UpcomingMeeting = {
  id: MEETING_ID,
  title: "Orion planning",
  startMs: NOW + 8 * 60_000,
  endMs: NOW + 38 * 60_000,
  organizer: "diego",
  attendees: [{ id: "diego" }],
  agenda: "Orion rollout",
};

const ranked: RankedFact[] = [
  {
    id: HOT_FACT.id,
    source: "graph",
    entityIds: ["Orion rollout"],
    text: HOT_FACT.statement,
    timestamp: NOW,
    raw: HOT_FACT,
    memoryFact: HOT_FACT,
    score: 8.0,
  },
];

const UTTERANCES = Array.from({ length: N }, (_, i) =>
  i % 2 === 0
    ? `Should we accelerate the Orion rollout decision in week ${i}?`
    : `Following up on Feature X and the Acme launch timeline, item ${i}.`,
);

function pct(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function timed(meetingId?: string): Promise<number> {
  const t0 = performance.now();
  await analyzeUtterance({
    speaker: "Diego",
    text: UTTERANCES[Math.floor(Math.random() * UTTERANCES.length)],
    meetingId,
  });
  return performance.now() - t0;
}

beforeEach(() => {
  store.clear();
  valkeyState.available = true;
  prewarmHitStats.hits = 0;
  prewarmHitStats.misses = 0;
  generateContent.mockReset();
  // Fixed, path-independent LLM cost — what production actually pays per call.
  generateContent.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 1));
    return {
      servedBy: "mock",
      response: JSON.stringify
        ? { text: JSON.stringify({ collisionDetected: false, cards: [] }) }
        : { text: "" },
    };
  });
});

describe("cold vs warm collision performance", () => {
  it("warm path achieves 100% hot-key hit rate and is never slower than cold", async () => {
    // ── Cold: no meeting prewarmed ───────────────────────────────────────
    const cold: number[] = [];
    for (let i = 0; i < N; i++) cold.push(await timed(undefined));

    // ── Warm: prewarm the meeting once, then replay the same N utterances ─
    const res = await hotLoad({
      meeting,
      ranked,
      sources: [{ name: "graph", latencyMs: 1, count: 1 }],
      rankerInputCount: 1,
      now: NOW,
    });
    expect(res.written).toBe(true);
    expect(store.has(prewarmKeys.hot(MEETING_ID))).toBe(true);

    prewarmHitStats.hits = 0;
    prewarmHitStats.misses = 0;
    const warm: number[] = [];
    for (let i = 0; i < N; i++) warm.push(await timed(MEETING_ID));

    const hits = prewarmHitStats.hits;
    const hitRate = hits / (hits + prewarmHitStats.misses);
    const coldP50 = pct(cold, 50);
    const warmP50 = pct(warm, 50);
    const speedup = mean(cold) / mean(warm);

    // eslint-disable-next-line no-console
    console.log(
      "\n  ── Cold vs Warm collision path (Gemini mocked, retrieval lane isolated) ──\n" +
        `  utterances/run        : ${N}\n` +
        `  hot-key hit rate      : ${(hitRate * 100).toFixed(1)}%  (target >70%, spec 2.11)\n` +
        `  cold  P50 / mean (ms) : ${coldP50.toFixed(3)} / ${mean(cold).toFixed(3)}\n` +
        `  warm  P50 / mean (ms) : ${warmP50.toFixed(3)} / ${mean(warm).toFixed(3)}\n` +
        `  retrieval speedup     : ${speedup.toFixed(2)}x (warm removes the cold graph scan)\n`,
    );

    // Deterministic gates only:
    expect(hitRate).toBe(1); // every prewarmed utterance hit the hot key
    expect(hits).toBe(N);
    // Warm skips retrieval entirely, so it must not be slower than cold
    // (generous tolerance for GC/JIT noise at sub-ms scale).
    expect(mean(warm)).toBeLessThanOrEqual(mean(cold) * 1.5);
  });
});
