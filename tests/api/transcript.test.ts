import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveUtterance } = vi.hoisted(() => ({
  resolveUtterance: vi.fn(),
}));
const { normalizeWindow } = vi.hoisted(() => ({
  normalizeWindow: vi.fn(),
}));
vi.mock("@/lib/transcript/entity-resolver", () => ({ resolveUtterance }));
vi.mock("@/lib/transcript/window-normalizer", () => ({ normalizeWindow }));

import { POST as RESOLVE } from "@/app/api/transcript/resolve/route";
import { POST as NORMALIZE } from "@/app/api/transcript/normalize/route";

function post(url: string, body: string) {
  return new Request(url, { method: "POST", body });
}

beforeEach(() => {
  resolveUtterance.mockReset();
  normalizeWindow.mockReset();
});

function rawUtterance(text: string) {
  return {
    id: "u1",
    meetingId: "m1",
    speakerId: "s1",
    startMs: 0,
    endMs: 1,
    text,
  };
}

describe("POST /api/transcript/resolve", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await RESOLVE(post("http://t/api/transcript/resolve", "{ nope"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
  });

  it("returns an empty overlay for blank text without calling the engine", async () => {
    const res = await RESOLVE(
      post(
        "http://t/api/transcript/resolve",
        JSON.stringify({ raw: rawUtterance("   ") }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rawUtteranceId: "u1",
      resolutions: [],
      numericNormalizations: [],
    });
    expect(resolveUtterance).not.toHaveBeenCalled();
  });

  it("passes the utterance through and returns the resolver output", async () => {
    resolveUtterance.mockResolvedValueOnce({
      rawUtteranceId: "u1",
      resolutions: [{ canonicalEntityId: "eng-sso-auth" }],
      numericNormalizations: [],
    });
    const res = await RESOLVE(
      post(
        "http://t/api/transcript/resolve",
        JSON.stringify({
          raw: rawUtterance("Ship SSO today."),
          recent: [
            { speakerId: "s9", text: "a" },
            { speakerId: "s9", text: "b" },
            { speakerId: "s9", text: "c" },
            { speakerId: "s9", text: "d" },
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolutions[0].canonicalEntityId).toBe("eng-sso-auth");
    // Only the last 3 prior utterances are forwarded.
    expect(resolveUtterance.mock.calls[0][0].recent).toHaveLength(3);
  });

  it("maps an unexpected engine failure to a sanitized 500 (no leak)", async () => {
    resolveUtterance.mockRejectedValueOnce(new Error("verbatim upstream secret"));
    const res = await RESOLVE(
      post(
        "http://t/api/transcript/resolve",
        JSON.stringify({ raw: rawUtterance("boom") }),
      ),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal error processing the request." });
    expect(JSON.stringify(body)).not.toMatch(/verbatim upstream secret/);
  });

  it("maps a transient GatewayError to a 503 with Retry-After", async () => {
    const { GatewayError } = await import("@/lib/ai-gateway");
    resolveUtterance.mockRejectedValueOnce(
      new GatewayError({
        retryable: true,
        detail: "All 2 Gemini key(s) failed. quota SECRET",
      }),
    );
    const res = await RESOLVE(
      post(
        "http://t/api/transcript/resolve",
        JSON.stringify({ raw: rawUtterance("boom") }),
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|Gemini key/);
  });
});

describe("POST /api/transcript/normalize", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await NORMALIZE(
      post("http://t/api/transcript/normalize", "{ nope"),
    );
    expect(res.status).toBe(400);
  });

  it("returns an empty overlay for an empty window without calling the engine", async () => {
    const res = await NORMALIZE(
      post(
        "http://t/api/transcript/normalize",
        JSON.stringify({ utterances: [] }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      windowStartId: "",
      windowEndId: "",
      referenceResolutions: [],
      topicAnchors: [],
    });
    expect(normalizeWindow).not.toHaveBeenCalled();
  });

  it("returns the normalizer output on the happy path", async () => {
    normalizeWindow.mockResolvedValueOnce({
      windowStartId: "w1",
      windowEndId: "w2",
      referenceResolutions: [{ canonicalEntityId: "eng-sso-auth" }],
      topicAnchors: [],
    });
    const res = await NORMALIZE(
      post(
        "http://t/api/transcript/normalize",
        JSON.stringify({
          utterances: [rawUtterance("We discussed SSO."), rawUtterance("Ship it?")],
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).referenceResolutions[0].canonicalEntityId).toBe(
      "eng-sso-auth",
    );
  });

  it("maps an engine failure to a sanitized 500", async () => {
    normalizeWindow.mockRejectedValueOnce(new Error("verbatim secret"));
    const res = await NORMALIZE(
      post(
        "http://t/api/transcript/normalize",
        JSON.stringify({ utterances: [rawUtterance("x")] }),
      ),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/verbatim secret/);
  });

  it("maps a transient GatewayError to a 503 with Retry-After", async () => {
    const { GatewayError } = await import("@/lib/ai-gateway");
    normalizeWindow.mockRejectedValueOnce(
      new GatewayError({ retryable: true, detail: "quota SECRET" }),
    );
    const res = await NORMALIZE(
      post(
        "http://t/api/transcript/normalize",
        JSON.stringify({ utterances: [rawUtterance("x")] }),
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
