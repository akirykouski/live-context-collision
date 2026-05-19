import { describe, it, expect, vi, beforeEach } from "vitest";

const { getValkey, hasValkey } = vi.hoisted(() => ({
  getValkey: vi.fn(),
  hasValkey: vi.fn(() => false),
}));
vi.mock("@/lib/valkey", () => ({ getValkey, hasValkey }));

import {
  buildAdditionalVocab,
  VOCAB_CAP,
  __test__,
} from "@/lib/transcript/dictionary-builder";
import { prewarmKeys } from "@/lib/types";

beforeEach(() => {
  getValkey.mockReset();
  hasValkey.mockReset();
  hasValkey.mockReturnValue(false);
});

describe("Layer 1 dictionary-builder", () => {
  it("includes attendee display names and memory entities", async () => {
    const vocab = await buildAdditionalVocab();
    const contents = vocab.map((v) => v.content.toLowerCase());
    // People from people.json fixture.
    expect(contents).toContain("valya");
    expect(contents).toContain("mira");
    expect(contents).toContain("diego");
    // Memory-graph entities / related terms from memory.json.
    expect(contents).toContain("feature x");
    expect(contents).toContain("sso");
    expect(contents.some((c) => c.includes("acme"))).toBe(true);
  });

  it("dedupes by lowercased content", async () => {
    const vocab = await buildAdditionalVocab();
    const lowered = vocab.map((v) => v.content.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it("caps the vocabulary and warns on overflow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vocab = await buildAdditionalVocab({ cap: 3 });
    expect(vocab.length).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("vocab overflow"),
    );
    expect(VOCAB_CAP).toBe(1000);
    warn.mockRestore();
  });

  it("merges the prewarm vocab key when a meetingId is given and Valkey is up", async () => {
    hasValkey.mockReturnValue(true);
    const prewarm = [
      { content: "Zephyr Codename", sounds_like: ["zeffer"] },
      { content: "Valya" }, // duplicate of a person — must dedupe
    ];
    const get = vi.fn(async (key: string) => {
      expect(key).toBe(prewarmKeys.vocab("mtg-1"));
      return JSON.stringify(prewarm);
    });
    getValkey.mockReturnValue({ get });

    const vocab = await buildAdditionalVocab({ meetingId: "mtg-1" });
    const contents = vocab.map((v) => v.content.toLowerCase());

    expect(get).toHaveBeenCalledTimes(1);
    expect(contents).toContain("zephyr codename");
    // Prewarm is highest-ranked → appears before low-rank memory terms.
    expect(contents.indexOf("zephyr codename")).toBeLessThan(
      contents.indexOf("feature x"),
    );
    // "Valya" still appears exactly once despite being in both sources.
    expect(contents.filter((c) => c === "valya")).toHaveLength(1);
  });

  it("never throws and skips prewarm when Valkey is absent", async () => {
    hasValkey.mockReturnValue(false);
    const vocab = await buildAdditionalVocab({ meetingId: "mtg-x" });
    expect(getValkey).not.toHaveBeenCalled();
    expect(vocab.length).toBeGreaterThan(0);
  });

  it("survives a Valkey read failure (graceful, no throw)", async () => {
    hasValkey.mockReturnValue(true);
    getValkey.mockReturnValue({
      get: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const vocab = await buildAdditionalVocab({ meetingId: "mtg-2" });
    // Falls back to local sources only.
    expect(vocab.map((v) => v.content.toLowerCase())).toContain("feature x");
  });

  it("adds an ASCII sounds_like only for non-ASCII names", () => {
    expect(__test__.soundsLikeFor("Valya")).toBeUndefined();
    expect(__test__.soundsLikeFor("Łukasz")).toEqual(["ukasz"]);
    expect(__test__.soundsLikeFor("José")).toEqual(["Jose"]);
    expect(__test__.needsSoundsLike("Müller")).toBe(true);
    expect(__test__.needsSoundsLike("Smith")).toBe(false);
  });
});
