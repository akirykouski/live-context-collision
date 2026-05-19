import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * One mock GoogleGenAI client per API key. Each instance forwards
 * `models.generateContent` to a per-test handler keyed by apiKey, so we can
 * script success/failure independently for every key in the pool.
 */
vi.mock("@google/genai", () => {
  class GoogleGenAI {
    apiKey: string;
    models: { generateContent: (params: unknown) => Promise<unknown> };
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
      this.models = {
        generateContent: (params: unknown) =>
          (globalThis as Record<string, unknown> as {
            __genai: (key: string, p: unknown) => Promise<unknown>;
          }).__genai(this.apiKey, params),
      };
    }
  }
  return {
    GoogleGenAI,
    Type: {
      OBJECT: "OBJECT",
      ARRAY: "ARRAY",
      STRING: "STRING",
      BOOLEAN: "BOOLEAN",
    },
  };
});

const KEY_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
  "GEMINI_API_KEYS",
];

function clearKeyEnv() {
  for (const k of KEY_ENV) delete process.env[k];
}

async function loadGateway() {
  vi.resetModules();
  return import("@/lib/ai-gateway");
}

let calls: { key: string }[] = [];

/** Program per-key behaviour; default = success echoing the key label. */
function program(handlers: Record<string, () => unknown>) {
  (globalThis as Record<string, unknown>).__genai = async (key: string) => {
    calls.push({ key });
    const h = handlers[key];
    if (!h) return { text: `ok:${key}` };
    const out = h();
    if (out instanceof Error) throw out;
    return out;
  };
}

beforeEach(() => {
  clearKeyEnv();
  calls = [];
});

afterEach(() => {
  clearKeyEnv();
});

describe("ai-gateway.collectKeys", () => {
  it("collects numbered keys in priority order", async () => {
    process.env.GEMINI_API_KEY = "a";
    process.env.GEMINI_API_KEY_2 = "b";
    const { __test__ } = await loadGateway();
    expect(__test__.collectKeys().map((k) => k.label)).toEqual([
      "GEMINI_API_KEY",
      "GEMINI_API_KEY_2",
    ]);
  });

  it("de-dupes by key value and keeps priority order", async () => {
    process.env.GEMINI_API_KEY = "same";
    process.env.GEMINI_API_KEY_2 = "same";
    process.env.GEMINI_API_KEY_3 = "other";
    const { __test__ } = await loadGateway();
    const keys = __test__.collectKeys();
    expect(keys.map((k) => k.key)).toEqual(["same", "other"]);
  });

  it("parses the comma-separated GEMINI_API_KEYS and caps the pool at 4", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEYS = "k2, k3 , k4 ,k5,k6";
    const { __test__ } = await loadGateway();
    const keys = __test__.collectKeys();
    expect(keys.length).toBe(4);
    expect(keys.map((k) => k.key)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("ignores blank/whitespace-only values", async () => {
    process.env.GEMINI_API_KEY = "   ";
    process.env.GEMINI_API_KEY_2 = "real";
    const { __test__ } = await loadGateway();
    expect(__test__.collectKeys().map((k) => k.key)).toEqual(["real"]);
  });
});

describe("ai-gateway.isRetryable", () => {
  it("treats key/quota/network signals as retryable regardless of status", async () => {
    const { __test__ } = await loadGateway();
    const r = __test__.isRetryable;
    expect(r(new Error("API_KEY_INVALID"))).toBe(true);
    expect(r(new Error("API key not valid"))).toBe(true);
    expect(r(new Error("quota exceeded for this project"))).toBe(true);
    expect(r(new Error("rate limit reached"))).toBe(true);
    expect(r(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(r(new Error("model is overloaded, try again"))).toBe(true);
  });

  it("treats a bare HTTP 400 (our bad request) as non-retryable", async () => {
    const { __test__ } = await loadGateway();
    expect(__test__.isRetryable({ status: 400, message: "bad request" })).toBe(
      false,
    );
    expect(__test__.isRetryable({ status: 404 })).toBe(false);
    expect(__test__.isRetryable({ status: 422 })).toBe(false);
  });

  it("treats 401/403/429/5xx as retryable", async () => {
    const { __test__ } = await loadGateway();
    for (const status of [401, 403, 429, 500, 503]) {
      expect(__test__.isRetryable({ status })).toBe(true);
    }
  });

  it("classifies API_KEY_INVALID even when wrapped in an HTTP 400", async () => {
    const { __test__ } = await loadGateway();
    expect(
      __test__.isRetryable({ status: 400, message: "API_KEY_INVALID" }),
    ).toBe(true);
  });

  it("defaults to non-retryable for unknown errors", async () => {
    const { __test__ } = await loadGateway();
    expect(__test__.isRetryable(new Error("something weird"))).toBe(false);
    expect(__test__.isRetryable("plain string")).toBe(false);
  });
});

describe("ai-gateway.generateContent failover", () => {
  it("throws a clear error when no keys are configured", async () => {
    const { generateContent } = await loadGateway();
    await expect(generateContent({} as never)).rejects.toThrow(
      /No Gemini API keys configured/,
    );
  });

  it("serves from the first healthy key and reports who served it", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY_2 = "k2";
    const { generateContent } = await loadGateway();
    program({});
    const res = await generateContent({} as never);
    expect(res.servedBy).toBe("GEMINI_API_KEY");
    expect(calls.map((c) => c.key)).toEqual(["k1"]);
  });

  it("fails over to the next key on a retryable error", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY_2 = "k2";
    const { generateContent, gatewayStatus } = await loadGateway();
    program({ k1: () => new Error("quota exceeded") });
    const res = await generateContent({} as never);
    expect(res.servedBy).toBe("GEMINI_API_KEY_2");
    expect(calls.map((c) => c.key)).toEqual(["k1", "k2"]);
    const s = gatewayStatus();
    expect(s.find((x) => x.label === "GEMINI_API_KEY")?.healthy).toBe(false);
    expect(s.find((x) => x.label === "GEMINI_API_KEY")?.failures).toBe(1);
  });

  it("throws immediately on a non-retryable error without burning other keys", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY_2 = "k2";
    const { generateContent } = await loadGateway();
    program({ k1: () => ({ status: 400, message: "bad request" }) });
    // The mock throws the returned Error-like; emulate a thrown object.
    (globalThis as Record<string, unknown>).__genai = async (key: string) => {
      calls.push({ key });
      if (key === "k1") throw { status: 400, message: "bad request" };
      return { text: "ok" };
    };
    await expect(generateContent({} as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(calls.map((c) => c.key)).toEqual(["k1"]);
  });

  it("benches a failed key so the next call skips it", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY_2 = "k2";
    const { generateContent } = await loadGateway();
    program({ k1: () => new Error("rate limit") });
    await generateContent({} as never); // k1 fails, k2 serves
    calls = [];
    await generateContent({} as never); // k1 is benched -> straight to k2
    expect(calls.map((c) => c.key)).toEqual(["k2"]);
  });

  it("throws an aggregate error when every key fails retryably", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY_2 = "k2";
    const { generateContent } = await loadGateway();
    program({
      k1: () => new Error("quota exceeded"),
      k2: () => new Error("rate limit"),
    });
    await expect(generateContent({} as never)).rejects.toThrow(
      /All 2 Gemini key\(s\) failed/,
    );
  });

  it("clears the cooldown and failure count after a key recovers", async () => {
    process.env.GEMINI_API_KEY = "k1";
    const { generateContent, gatewayStatus } = await loadGateway();
    let fail = true;
    (globalThis as Record<string, unknown>).__genai = async (key: string) => {
      calls.push({ key });
      if (fail) throw new Error("rate limit");
      return { text: "recovered" };
    };
    await expect(generateContent({} as never)).rejects.toThrow();
    expect(gatewayStatus()[0].healthy).toBe(false);
    fail = false;
    const res = await generateContent({} as never);
    expect((res.response as { text: string }).text).toBe("recovered");
    expect(gatewayStatus()[0]).toMatchObject({ healthy: true, failures: 0 });
  });
});

describe("ai-gateway.gatewayStatus", () => {
  it("reports labels and health without leaking key values", async () => {
    process.env.GEMINI_API_KEY = "secret-1";
    process.env.GEMINI_API_KEY_2 = "secret-2";
    const { gatewayStatus } = await loadGateway();
    const status = gatewayStatus();
    expect(status.map((s) => s.label)).toEqual([
      "GEMINI_API_KEY",
      "GEMINI_API_KEY_2",
    ]);
    expect(JSON.stringify(status)).not.toContain("secret-");
    expect(status.every((s) => s.healthy)).toBe(true);
  });
});
