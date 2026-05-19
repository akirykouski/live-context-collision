import { describe, it, expect, vi, beforeEach } from "vitest";

const { analyzeServiceActions, getWorkContext, appendServiceActions } =
  vi.hoisted(() => ({
    analyzeServiceActions: vi.fn(),
    getWorkContext: vi.fn(),
    appendServiceActions: vi.fn(),
  }));
vi.mock("@/lib/service-actions", () => ({ analyzeServiceActions }));
vi.mock("@/lib/work-context", () => ({ getWorkContext, appendServiceActions }));

import { POST } from "@/app/api/service-actions/route";

function post(body: string) {
  return new Request("http://t/api/service-actions", { method: "POST", body });
}

beforeEach(() => {
  analyzeServiceActions.mockReset();
  getWorkContext.mockReset();
  appendServiceActions.mockReset();
  getWorkContext.mockResolvedValue({ artifacts: [], actions: [] });
});

describe("POST /api/service-actions", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await POST(post("nope"));
    expect(res.status).toBe(400);
  });

  it("short-circuits blank text without touching the engine", async () => {
    const res = await POST(post(JSON.stringify({ text: "  " })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actionDetected: false, actions: [] });
    expect(analyzeServiceActions).not.toHaveBeenCalled();
  });

  it("persists detected actions and returns them", async () => {
    analyzeServiceActions.mockResolvedValueOnce({
      actionDetected: true,
      actions: [{ id: "svc-1" }],
    });
    const res = await POST(
      post(JSON.stringify({ speaker: "S1", text: "Reassign to Sam." })),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).actionDetected).toBe(true);
    expect(appendServiceActions).toHaveBeenCalledWith([{ id: "svc-1" }]);
  });

  it("does not persist when no actions are produced", async () => {
    analyzeServiceActions.mockResolvedValueOnce({
      actionDetected: false,
      actions: [],
    });
    await POST(post(JSON.stringify({ text: "just chatting" })));
    expect(appendServiceActions).not.toHaveBeenCalled();
  });

  it("maps an unexpected engine failure to a sanitized 500 (no leak)", async () => {
    analyzeServiceActions.mockRejectedValueOnce(
      new Error("verbatim upstream secret"),
    );
    const res = await POST(post(JSON.stringify({ text: "do it" })));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal error processing the request." });
    expect(JSON.stringify(body)).not.toMatch(/verbatim upstream secret/);
  });

  it("maps a transient GatewayError to a sanitized 503", async () => {
    const { GatewayError } = await import("@/lib/ai-gateway");
    analyzeServiceActions.mockRejectedValueOnce(
      new GatewayError({
        retryable: true,
        detail: "All 1 Gemini key(s) failed. quota SECRET",
      }),
    );
    const res = await POST(post(JSON.stringify({ text: "do it" })));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|Gemini key/);
  });
});
