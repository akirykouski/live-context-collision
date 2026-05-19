import { describe, it, expect, vi, beforeEach } from "vitest";

const { analyzeUtterance } = vi.hoisted(() => ({ analyzeUtterance: vi.fn() }));
vi.mock("@/lib/gemini", () => ({ analyzeUtterance }));

import { POST } from "@/app/api/collision/route";

function post(body: string) {
  return new Request("http://t/api/collision", { method: "POST", body });
}

beforeEach(() => analyzeUtterance.mockReset());

describe("POST /api/collision", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await POST(post("{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
  });

  it("returns an empty result for blank text without calling the engine", async () => {
    const res = await POST(post(JSON.stringify({ text: "   " })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collisionDetected: false, cards: [] });
    expect(analyzeUtterance).not.toHaveBeenCalled();
  });

  it("passes the utterance through and returns the engine result", async () => {
    analyzeUtterance.mockResolvedValueOnce({
      collisionDetected: true,
      cards: [{ id: "1" }],
    });
    const res = await POST(
      post(
        JSON.stringify({
          speaker: "Speaker 1",
          text: "Ship Feature X now.",
          recentTranscript: Array.from({ length: 9 }, (_, i) => ({
            speaker: "S",
            text: `t${i}`,
          })),
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).collisionDetected).toBe(true);
    const arg = analyzeUtterance.mock.calls[0][0];
    expect(arg.speaker).toBe("Speaker 1");
    // Only the last 6 transcript lines are forwarded.
    expect(arg.recentTranscript).toHaveLength(6);
  });

  it("defaults the speaker when none is given", async () => {
    analyzeUtterance.mockResolvedValueOnce({ collisionDetected: false, cards: [] });
    await POST(post(JSON.stringify({ text: "hi" })));
    expect(analyzeUtterance.mock.calls[0][0].speaker).toBe("Speaker");
  });

  it("maps engine failures to a 500", async () => {
    analyzeUtterance.mockRejectedValueOnce(new Error("gemini down"));
    const res = await POST(post(JSON.stringify({ text: "boom" })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "gemini down" });
  });
});
