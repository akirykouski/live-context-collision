import { describe, it, expect, vi, beforeEach } from "vitest";

const { getWorkContext, resetServiceActions } = vi.hoisted(() => ({
  getWorkContext: vi.fn(),
  resetServiceActions: vi.fn(),
}));
vi.mock("@/lib/work-context", () => ({ getWorkContext, resetServiceActions }));

import { GET } from "@/app/api/work-context/route";
import { POST as RESET } from "@/app/api/work-context/reset/route";

beforeEach(() => {
  getWorkContext.mockReset();
  resetServiceActions.mockReset();
});

describe("GET /api/work-context", () => {
  it("returns the merged work context", async () => {
    getWorkContext.mockResolvedValueOnce({
      artifacts: [{ id: "gh-1" }],
      actions: [],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).artifacts).toHaveLength(1);
  });

  it("maps failures to a 500", async () => {
    getWorkContext.mockRejectedValueOnce(new Error("disk gone"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "disk gone" });
  });
});

describe("POST /api/work-context/reset", () => {
  it("clears actions and acknowledges", async () => {
    resetServiceActions.mockResolvedValueOnce([]);
    const res = await RESET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actions: [] });
  });

  it("maps failures to a 500", async () => {
    resetServiceActions.mockRejectedValueOnce(new Error("write failed"));
    const res = await RESET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "write failed" });
  });
});
