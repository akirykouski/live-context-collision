import { describe, it, expect, vi, beforeEach } from "vitest";

const { gatewayStatus } = vi.hoisted(() => ({ gatewayStatus: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ gatewayStatus }));

import { GET } from "@/app/api/ai-gateway/route";

beforeEach(() => gatewayStatus.mockReset());

describe("GET /api/ai-gateway", () => {
  it("returns the key pool health view", async () => {
    gatewayStatus.mockReturnValueOnce([
      { label: "GEMINI_API_KEY", healthy: true, cooldownMsRemaining: 0, failures: 0 },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys[0].label).toBe("GEMINI_API_KEY");
    expect(JSON.stringify(body)).not.toMatch(/secret|apiKey/i);
  });

  it("500s when the pool is not configured", async () => {
    gatewayStatus.mockImplementationOnce(() => {
      throw new Error("No Gemini API keys configured.");
    });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "No Gemini API keys configured.",
    });
  });
});
