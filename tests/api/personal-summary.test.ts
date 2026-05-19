import { describe, it, expect, vi, beforeEach } from "vitest";

const { summarizeForPerson } = vi.hoisted(() => ({
  summarizeForPerson: vi.fn(),
}));
vi.mock("@/lib/personal-summary", () => ({ summarizeForPerson }));

import { POST } from "@/app/api/personal-summary/route";

function post(body: string) {
  return new Request("http://t/api/personal-summary", { method: "POST", body });
}

const utterances = [{ id: "u1", speaker: "S", text: "hi", at: 1 }];

beforeEach(() => summarizeForPerson.mockReset());

describe("POST /api/personal-summary", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
  });

  it("requires a personId", async () => {
    const res = await POST(post(JSON.stringify({ utterances })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "personId required" });
  });

  it("404s for an unknown person", async () => {
    const res = await POST(
      post(JSON.stringify({ personId: "nobody", utterances })),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown person" });
  });

  it("returns a 'nothing to summarise' floor for an empty meeting", async () => {
    const res = await POST(
      post(JSON.stringify({ personId: "valya", utterances: [] })),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.bottomLine).toMatch(/Nothing to summarise/);
    expect(body.summary.person.name).toBe("Valya");
    expect(summarizeForPerson).not.toHaveBeenCalled();
  });

  it("returns the engine summary for a valid request", async () => {
    summarizeForPerson.mockResolvedValueOnce({
      summary: { person: { id: "valya" }, bottomLine: "Heads up." },
    });
    const res = await POST(
      post(JSON.stringify({ personId: "valya", utterances })),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).summary.bottomLine).toBe("Heads up.");
    expect(summarizeForPerson).toHaveBeenCalledOnce();
  });

  it("maps engine failures to a 500", async () => {
    summarizeForPerson.mockRejectedValueOnce(new Error("llm exploded"));
    const res = await POST(
      post(JSON.stringify({ personId: "valya", utterances })),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "llm exploded" });
  });
});
