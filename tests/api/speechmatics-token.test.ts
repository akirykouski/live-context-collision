import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createSpeechmaticsJWT } = vi.hoisted(() => ({
  createSpeechmaticsJWT: vi.fn(),
}));
const { buildAdditionalVocab } = vi.hoisted(() => ({
  buildAdditionalVocab: vi.fn(async () => [{ content: "Acme" }]),
}));
vi.mock("@speechmatics/auth", () => ({ createSpeechmaticsJWT }));
vi.mock("@/lib/transcript/dictionary-builder", () => ({
  buildAdditionalVocab,
}));

import { GET } from "@/app/api/speechmatics-token/route";

// Next.js always passes a Request to a GET handler; default to one with no
// query so meetingId resolves to undefined.
const req = (url = "http://t/api/speechmatics-token") => new Request(url);

beforeEach(() => {
  createSpeechmaticsJWT.mockReset();
  buildAdditionalVocab.mockClear();
  buildAdditionalVocab.mockResolvedValue([{ content: "Acme" }]);
  delete process.env.SPEECHMATICS_API_KEY;
});
afterEach(() => {
  delete process.env.SPEECHMATICS_API_KEY;
});

describe("GET /api/speechmatics-token", () => {
  it("500s when the API key is not configured", async () => {
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "SPEECHMATICS_API_KEY is not set",
    });
    expect(createSpeechmaticsJWT).not.toHaveBeenCalled();
  });

  it("mints a JWT and returns the Layer 1 additional_vocab payload", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockResolvedValueOnce("jwt-token");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jwt: "jwt-token",
      additionalVocab: [{ content: "Acme" }],
    });
    expect(createSpeechmaticsJWT).toHaveBeenCalledWith({
      type: "rt",
      apiKey: "sm-secret",
      ttl: 60,
    });
  });

  it("passes an optional meetingId query param to the dictionary builder", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockResolvedValueOnce("jwt-token");
    const res = await GET(
      new Request("http://t/api/speechmatics-token?meetingId=mtg-9"),
    );
    expect(res.status).toBe(200);
    expect(buildAdditionalVocab).toHaveBeenCalledWith({ meetingId: "mtg-9" });
  });

  it("omits meetingId when it is absent from the query", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockResolvedValueOnce("jwt-token");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(buildAdditionalVocab).toHaveBeenCalledWith({ meetingId: undefined });
  });

  it("still mints the JWT if vocab building fails (vocab → [])", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockResolvedValueOnce("jwt-token");
    buildAdditionalVocab.mockRejectedValueOnce(new Error("vocab boom"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jwt: "jwt-token",
      additionalVocab: [],
    });
  });

  it("502s when token minting fails", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockRejectedValueOnce(new Error("auth refused"));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "auth refused" });
  });
});
