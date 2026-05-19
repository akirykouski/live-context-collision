import { describe, it, expect, vi, beforeEach } from "vitest";

const { runScheduler, prewarmMeetingById } = vi.hoisted(() => ({
  runScheduler: vi.fn(),
  prewarmMeetingById: vi.fn(),
}));
vi.mock("@/lib/prewarm/scheduler", () => ({ runScheduler, prewarmMeetingById }));

const { valkeyState } = vi.hoisted(() => ({
  valkeyState: {
    available: true,
    store: new Map<string, string>(),
  },
}));
vi.mock("@/lib/valkey", () => ({
  hasValkey: () => valkeyState.available,
  getValkey: () => ({
    async exists(k: string) {
      return valkeyState.store.has(k) ? 1 : 0;
    },
    async get(k: string) {
      return valkeyState.store.get(k) ?? null;
    },
  }),
}));

import { POST } from "@/app/api/prewarm/trigger/route";
import { GET } from "@/app/api/prewarm/status/route";
import { prewarmKeys } from "@/lib/types";

function post(body: string) {
  return new Request("http://t/api/prewarm/trigger", {
    method: "POST",
    body,
  });
}
function get(qs: string) {
  return new Request(`http://t/api/prewarm/status${qs}`);
}

beforeEach(() => {
  runScheduler.mockReset();
  prewarmMeetingById.mockReset();
  valkeyState.available = true;
  valkeyState.store.clear();
});

describe("POST /api/prewarm/trigger", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await POST(post("{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
  });

  it("no meetingId → runs the scheduler tick and returns a job summary", async () => {
    runScheduler.mockResolvedValueOnce([
      { meetingId: "m1", prewarmed: true },
    ]);
    const res = await POST(post(JSON.stringify({})));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("scheduler");
    expect(body.eligible).toBe(1);
    expect(body.results[0].meetingId).toBe("m1");
  });

  it("with meetingId → single prewarm, force forwarded", async () => {
    prewarmMeetingById.mockResolvedValueOnce({
      meetingId: "acme-launch-sync",
      prewarmed: true,
    });
    const res = await POST(
      post(JSON.stringify({ meetingId: "acme-launch-sync", force: true })),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("single");
    expect(prewarmMeetingById).toHaveBeenCalledWith("acme-launch-sync", {
      force: true,
    });
  });

  it("maps an engine failure to a sanitized 500 (no leak)", async () => {
    runScheduler.mockRejectedValueOnce(new Error("verbatim secret detail"));
    const res = await POST(post(JSON.stringify({})));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal error processing the request." });
    expect(JSON.stringify(body)).not.toMatch(/verbatim secret detail/);
  });
});

describe("GET /api/prewarm/status", () => {
  it("missing meetingId → 400", async () => {
    const res = await GET(get(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "meetingId is required" });
  });

  it("returns status + parsed manifest when present", async () => {
    const manifest = { meetingId: "m1", organizer: "diego" };
    valkeyState.store.set(prewarmKeys.marker("m1"), "1");
    valkeyState.store.set(prewarmKeys.hot("m1"), "[]");
    valkeyState.store.set(prewarmKeys.manifest("m1"), JSON.stringify(manifest));
    const res = await GET(get("?meetingId=m1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prewarmed).toBe(true);
    expect(body.hotKeyPresent).toBe(true);
    expect(body.manifest).toEqual(manifest);
  });

  it("reports valkey:false when no store configured", async () => {
    valkeyState.available = false;
    const res = await GET(get("?meetingId=m1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valkey).toBe(false);
    expect(body.prewarmed).toBe(false);
  });
});
