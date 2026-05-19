import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createSpeechmaticsJWT } = vi.hoisted(() => ({
  createSpeechmaticsJWT: vi.fn(),
}));
vi.mock("@speechmatics/auth", () => ({ createSpeechmaticsJWT }));

import { GET } from "@/app/api/speechmatics-token/route";

beforeEach(() => {
  createSpeechmaticsJWT.mockReset();
  delete process.env.SPEECHMATICS_API_KEY;
});
afterEach(() => {
  delete process.env.SPEECHMATICS_API_KEY;
});

describe("GET /api/speechmatics-token", () => {
  it("500s when the API key is not configured", async () => {
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "SPEECHMATICS_API_KEY is not set",
    });
    expect(createSpeechmaticsJWT).not.toHaveBeenCalled();
  });

  it("mints a short-lived JWT scoped to real-time transcription", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockResolvedValueOnce("jwt-token");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jwt: "jwt-token" });
    expect(createSpeechmaticsJWT).toHaveBeenCalledWith({
      type: "rt",
      apiKey: "sm-secret",
      ttl: 60,
    });
  });

  it("502s when token minting fails", async () => {
    process.env.SPEECHMATICS_API_KEY = "sm-secret";
    createSpeechmaticsJWT.mockRejectedValueOnce(new Error("auth refused"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "auth refused" });
  });
});
