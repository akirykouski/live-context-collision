import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MemoryFact } from "@/lib/types";

const files = new Map<string, string>();

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return files.get(p) as string;
  }),
  writeFile: vi.fn(async (p: string, body: string) => {
    files.set(p, body);
  }),
}));

import {
  appendLearnedFacts,
  getLearnedFacts,
  hydrateLearnedFacts,
  learnedFactsCache,
  resetLearnedFacts,
} from "@/lib/learned-facts";

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: `learned-${Math.random().toString(36).slice(2)}`,
    type: "decision",
    entity: "Acme",
    status: "active",
    source: "Live meeting · Speaker 1",
    statement: "Decision: ship Feature X on Friday.",
    severity: "medium",
    ...over,
  };
}

beforeEach(async () => {
  files.clear();
  delete process.env.VALKEY_URL;
  await resetLearnedFacts();
});

describe("learned-facts store (file fallback)", () => {
  it("starts empty when no runtime file exists", async () => {
    expect(await getLearnedFacts()).toEqual([]);
    expect(learnedFactsCache()).toEqual([]);
  });

  it("appends facts and exposes them via the sync cache", async () => {
    const f = fact({ id: "learned-1" });
    await appendLearnedFacts([f]);
    expect(learnedFactsCache().map((x) => x.id)).toEqual(["learned-1"]);
    expect((await getLearnedFacts()).length).toBe(1);
  });

  it("dedupes by id and by normalized statement", async () => {
    await appendLearnedFacts([fact({ id: "a", statement: "Ship it Friday." })]);
    await appendLearnedFacts([fact({ id: "a", statement: "different" })]); // same id
    await appendLearnedFacts([
      fact({ id: "b", statement: "  ship   it friday.  " }), // same statement
    ]);
    const all = await getLearnedFacts();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe("a");
  });

  it("reset wipes the store and the cache", async () => {
    await appendLearnedFacts([fact()]);
    await resetLearnedFacts();
    expect(learnedFactsCache()).toEqual([]);
    expect(await getLearnedFacts()).toEqual([]);
  });

  it("hydrate never throws and keeps the cache usable", async () => {
    await appendLearnedFacts([fact({ id: "h1" })]);
    await expect(hydrateLearnedFacts()).resolves.toBeUndefined();
    expect(learnedFactsCache().some((x) => x.id === "h1")).toBe(true);
  });
});
