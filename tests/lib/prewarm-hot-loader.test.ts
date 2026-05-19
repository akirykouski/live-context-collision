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
  };
  return { store, ttls, valkeyState, fakeValkey };
});

vi.mock("@/lib/valkey", () => ({
  hasValkey: () => valkeyState.available,
  getValkey: () => fakeValkey,
}));

import { hotLoad, computeTtlSec, toMemoryFact, toVocab } from "@/lib/prewarm/hot-loader";
import { prewarmKeys } from "@/lib/types";
import type { MemoryFact } from "@/lib/types";
import type { RankedFact, UpcomingMeeting } from "@/lib/prewarm/types";

const NOW = 1_700_000_000_000;

const meeting: UpcomingMeeting = {
  id: "m1",
  title: "Acme launch",
  startMs: NOW + 8 * 60_000,
  endMs: NOW + 38 * 60_000, // ends 38min out
  organizer: "diego",
  attendees: [{ id: "diego" }, { id: "alex" }],
  agenda: "Acme",
};

const graphFact: MemoryFact = {
  id: "commitment-acme",
  type: "commitment",
  entity: "Acme",
  status: "active",
  source: "Account context, Sales",
  statement: "Acme is a high-value customer.",
  severity: "medium",
};

function ranked(): RankedFact[] {
  return [
    {
      id: "commitment-acme",
      source: "graph",
      entityIds: ["Acme", "customer"],
      text: graphFact.statement,
      timestamp: NOW,
      raw: graphFact,
      memoryFact: graphFact,
      score: 9.1,
    },
    {
      id: "github:org/app#1",
      source: "github",
      entityIds: ["org/app", "SSO wiring"],
      text: "PR org/app#1: SSO wiring",
      timestamp: NOW,
      raw: {},
      score: 4.2,
    },
  ];
}

beforeEach(() => {
  store.clear();
  ttls.clear();
  valkeyState.available = true;
  delete process.env.WORKGRAPH_DATA_ZONE;
  delete process.env.WORKGRAPH_RESIDENCY_STRICT;
});

describe("computeTtlSec", () => {
  it("= (endMs-now)/1000 + 3600, min 300", () => {
    expect(computeTtlSec(meeting, NOW)).toBe(38 * 60 + 3600);
    // Ended just now: still padded by 1h.
    const justEnded: UpcomingMeeting = { ...meeting, endMs: NOW };
    expect(computeTtlSec(justEnded, NOW)).toBe(3600);
    // Ended well over an hour ago → clamped to the 300s floor.
    const longPast: UpcomingMeeting = {
      ...meeting,
      endMs: NOW - 2 * 60 * 60_000,
    };
    expect(computeTtlSec(longPast, NOW)).toBe(300);
  });
});

describe("toMemoryFact / toVocab", () => {
  it("passes graph facts through, synthesizes others, never carries score", () => {
    const [g, gh] = ranked();
    const mg = toMemoryFact(g);
    expect(mg).toEqual(graphFact);
    expect("score" in mg).toBe(false);
    const mGh = toMemoryFact(gh);
    expect(mGh.statement).toBe("PR org/app#1: SSO wiring");
    expect(mGh.entity).toBe("org/app");
    expect(mGh.status).toBe("active");
    expect("score" in mGh).toBe(false);
  });

  it("vocab is deduped entity surface forms", () => {
    const v = toVocab(ranked());
    expect(v.map((e) => e.content)).toEqual([
      "Acme",
      "customer",
      "org/app",
      "SSO wiring",
    ]);
  });
});

describe("hotLoad", () => {
  it("writes hot=MemoryFact[] JSON, vocab=AdditionalVocabEntry[] JSON, manifest, correct TTL", async () => {
    const res = await hotLoad({
      meeting,
      ranked: ranked(),
      sources: [{ name: "graph", latencyMs: 3, count: 2 }],
      rankerInputCount: 5,
      now: NOW,
    });
    expect(res.written).toBe(true);

    const hot = JSON.parse(store.get(prewarmKeys.hot("m1"))!);
    expect(Array.isArray(hot)).toBe(true);
    expect(hot[0]).toEqual(graphFact);
    expect(hot.some((f: MemoryFact) => "score" in f)).toBe(false);

    const vocab = JSON.parse(store.get(prewarmKeys.vocab("m1"))!);
    expect(vocab).toEqual([
      { content: "Acme" },
      { content: "customer" },
      { content: "org/app" },
      { content: "SSO wiring" },
    ]);

    const manifest = JSON.parse(store.get(prewarmKeys.manifest("m1"))!);
    expect(manifest.meetingId).toBe("m1");
    expect(manifest.organizer).toBe("diego");
    expect(manifest.ranker).toEqual({
      inputCount: 5,
      outputCount: 2,
      scoreMin: 4.2,
      scoreMax: 9.1,
    });
    expect(manifest.hot.ok).toBe(true);

    const ttl = 38 * 60 + 3600;
    expect(ttls.get(prewarmKeys.hot("m1"))).toBe(ttl);
    expect(ttls.get(prewarmKeys.vocab("m1"))).toBe(ttl);
    expect(ttls.get(prewarmKeys.manifest("m1"))).toBe(ttl);
  });

  it("is a no-op (written:false) when Valkey is unavailable", async () => {
    valkeyState.available = false;
    const res = await hotLoad({
      meeting,
      ranked: ranked(),
      sources: [],
      rankerInputCount: 0,
      now: NOW,
    });
    expect(res.written).toBe(false);
    expect(store.size).toBe(0);
  });

  it("refuses (throws) when residency is strict + inconsistent", async () => {
    process.env.WORKGRAPH_DATA_ZONE = "us"; // active defaults to eu
    process.env.WORKGRAPH_RESIDENCY_STRICT = "true";
    await expect(
      hotLoad({
        meeting,
        ranked: ranked(),
        sources: [],
        rankerInputCount: 0,
        now: NOW,
      }),
    ).rejects.toThrow(/cross-border/i);
    expect(store.size).toBe(0);
  });
});
