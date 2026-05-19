import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkArtifact } from "@/lib/types";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@/lib/ai-gateway", () => ({ generateContent }));

import { analyzeServiceActions, __test__ } from "@/lib/service-actions";

const { slugify, makeArtifactId, changedWithoutTimestamp, applyCandidate } =
  __test__;

function gh(over: Partial<WorkArtifact> = {}): WorkArtifact {
  return {
    id: "gh-auth",
    kind: "github_issue",
    title: "Auth Refactor",
    status: "open",
    priority: "P0",
    assignee: "Valya",
    ...over,
  };
}

function reply(payload: unknown) {
  generateContent.mockResolvedValueOnce({
    response: { text: JSON.stringify(payload) },
    servedBy: "TEST",
  });
}

beforeEach(() => generateContent.mockReset());

describe("service-actions.slugify", () => {
  it("lowercases, hyphenates and trims edges", () => {
    expect(slugify("  Reassign Auth Refactor! ")).toBe("reassign-auth-refactor");
  });
  it("caps the slug at 48 chars", () => {
    expect(slugify("a".repeat(80)).length).toBe(48);
  });
});

describe("service-actions.makeArtifactId", () => {
  it("prefixes by artifact kind", () => {
    const id = makeArtifactId(
      { artifactKind: "github_issue", artifactTitle: "New SSO bug" },
      0,
      new Set(),
    );
    expect(id).toBe("gh-new-sso-bug");
  });

  it("disambiguates against existing ids", () => {
    const existing = new Set(["gh-new-sso-bug"]);
    const id = makeArtifactId(
      { artifactKind: "github_issue", artifactTitle: "New SSO bug" },
      0,
      existing,
    );
    expect(id).toBe("gh-new-sso-bug-2");
    expect(existing.has("gh-new-sso-bug-2")).toBe(true);
  });

  it("falls back to an index-based id when nothing is sluggable", () => {
    const id = makeArtifactId({ artifactKind: "email_draft" }, 3, new Set());
    expect(id).toBe("draft-service-action-3");
  });
});

describe("service-actions.changedWithoutTimestamp", () => {
  it("ignores updatedAt differences", () => {
    const a = gh({ updatedAt: "2026-01-01T00:00:00Z" });
    const b = gh({ updatedAt: "2026-09-09T00:00:00Z" });
    expect(changedWithoutTimestamp(a, b)).toBe(false);
  });
  it("detects a real field change", () => {
    expect(changedWithoutTimestamp(gh(), gh({ assignee: "Sam" }))).toBe(true);
  });
});

describe("service-actions.applyCandidate", () => {
  const utter = { speaker: "Speaker 1", text: "Move auth to Sam." };

  it("rejects candidates with an invalid enum or no title", () => {
    expect(
      applyCandidate(
        { agent: "slack", actionType: "reassign", artifactKind: "github_issue", actionTitle: "x" },
        [gh()],
        new Set(["gh-auth"]),
        utter,
        0,
      ),
    ).toBeNull();
    expect(
      applyCandidate(
        { agent: "github", actionType: "reassign", artifactKind: "github_issue" },
        [gh()],
        new Set(["gh-auth"]),
        utter,
        0,
      ),
    ).toBeNull();
  });

  it("rejects a non-create action that targets an unknown artifact", () => {
    expect(
      applyCandidate(
        {
          agent: "github",
          actionType: "reassign",
          artifactKind: "github_issue",
          actionTitle: "Reassign",
          artifactId: "does-not-exist",
        },
        [gh()],
        new Set(["gh-auth"]),
        utter,
        0,
      ),
    ).toBeNull();
  });

  it("applies a reassign onto an existing artifact and records before/after", () => {
    const action = applyCandidate(
      {
        agent: "github",
        actionType: "reassign",
        artifactKind: "github_issue",
        artifactId: "gh-auth",
        actionTitle: "Reassign Auth Refactor to Sam",
        assignee: "Sam",
      },
      [gh()],
      new Set(["gh-auth"]),
      utter,
      0,
    );
    expect(action).not.toBeNull();
    expect(action!.before?.assignee).toBe("Valya");
    expect(action!.after.assignee).toBe("Sam");
    expect(action!.status).toBe("applied");
    expect(action!.basedOn).toEqual(utter);
  });

  it("returns null when an update changes nothing material", () => {
    const action = applyCandidate(
      {
        agent: "github",
        actionType: "update",
        artifactKind: "github_issue",
        artifactId: "gh-auth",
        actionTitle: "No-op",
      },
      [gh()],
      new Set(["gh-auth"]),
      utter,
      0,
    );
    expect(action).toBeNull();
  });

  it("creates a new artifact when no id is given", () => {
    const action = applyCandidate(
      {
        agent: "github",
        actionType: "create",
        artifactKind: "github_issue",
        actionTitle: "Create tracking issue",
        artifactTitle: "Track SSO regression",
      },
      [gh()],
      new Set(["gh-auth"]),
      utter,
      1,
    );
    expect(action).not.toBeNull();
    expect(action!.before).toBeUndefined();
    expect(action!.after.id).toBe("gh-track-sso-regression");
    expect(action!.after.status).toBe("open");
  });

  it("marks email drafts as draft status", () => {
    const action = applyCandidate(
      {
        agent: "gmail",
        actionType: "create_draft",
        artifactKind: "email_draft",
        actionTitle: "Draft customer note",
        body: "Hi Acme, ...",
      },
      [],
      new Set(),
      utter,
      0,
    );
    expect(action!.after.status).toBe("draft");
    expect(action!.after.body).toContain("Hi Acme");
  });

  it("applies priority, status, customer, source and urlLabel changes", () => {
    const action = applyCandidate(
      {
        agent: "jira_notion",
        actionType: "change_priority",
        artifactKind: "jira_task",
        artifactId: "gh-auth",
        actionTitle: "Bump to P1",
        priority: "P1",
        status: "in_progress",
        customer: "Acme",
        source: "Jira ACME-99",
        urlLabel: "ACME-99",
      },
      [gh()],
      new Set(["gh-auth"]),
      utter,
      0,
    );
    expect(action!.after).toMatchObject({
      priority: "P1",
      status: "in_progress",
      customer: "Acme",
      source: "Jira ACME-99",
      urlLabel: "ACME-99",
    });
  });

  it("falls back to the rationale when append_note has no body", () => {
    const action = applyCandidate(
      {
        agent: "jira_notion",
        actionType: "append_note",
        artifactKind: "jira_task",
        artifactId: "gh-auth",
        actionTitle: "Note",
        rationale: "Blocked on Legal sign-off.",
      },
      [gh({ body: "Existing." })],
      new Set(["gh-auth"]),
      utter,
      0,
    );
    expect(action!.after.body).toBe(
      "Existing.\n\nMeeting update: Blocked on Legal sign-off.",
    );
  });

  it("ignores an invalid priority enum value", () => {
    const action = applyCandidate(
      {
        agent: "github",
        actionType: "change_priority",
        artifactKind: "github_issue",
        artifactId: "gh-auth",
        actionTitle: "Bad priority",
        priority: "P9",
        status: "blocked",
      },
      [gh()],
      new Set(["gh-auth"]),
      utter,
      0,
    );
    // status still changed, but the bogus priority was dropped.
    expect(action!.after.priority).toBe("P0");
    expect(action!.after.status).toBe("blocked");
  });

  it("appends a meeting note to an existing body for append_note", () => {
    const action = applyCandidate(
      {
        agent: "jira_notion",
        actionType: "append_note",
        artifactKind: "jira_task",
        artifactId: "gh-auth",
        actionTitle: "Add note",
        body: "Blocked on DPA.",
      },
      [gh({ body: "Existing description." })],
      new Set(["gh-auth"]),
      utter,
      0,
    );
    expect(action!.after.body).toBe(
      "Existing description.\n\nMeeting update: Blocked on DPA.",
    );
  });
});

describe("service-actions.analyzeServiceActions", () => {
  const base = {
    speaker: "Speaker 1",
    artifacts: [gh()],
    existingActions: [],
  };

  it("short-circuits on empty text without calling the model", async () => {
    const res = await analyzeServiceActions({ ...base, text: "   " });
    expect(res).toEqual({ actionDetected: false, actions: [] });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("returns no actions when the model response has no text", async () => {
    generateContent.mockResolvedValueOnce({ response: { text: "" }, servedBy: "T" });
    const res = await analyzeServiceActions({ ...base, text: "do something" });
    expect(res.actionDetected).toBe(false);
  });

  it("swallows malformed JSON from the model", async () => {
    generateContent.mockResolvedValueOnce({
      response: { text: "not json {" },
      servedBy: "T",
    });
    const res = await analyzeServiceActions({ ...base, text: "do something" });
    expect(res).toEqual({ actionDetected: false, actions: [] });
  });

  it("maps valid candidates into applied actions", async () => {
    reply({
      actionDetected: true,
      actions: [
        {
          agent: "github",
          actionType: "reassign",
          artifactKind: "github_issue",
          artifactId: "gh-auth",
          actionTitle: "Reassign to Sam",
          rationale: "Decided live.",
          assignee: "Sam",
        },
      ],
    });
    const res = await analyzeServiceActions({
      ...base,
      text: "Reassign the auth refactor to Sam.",
    });
    expect(res.actionDetected).toBe(true);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0].after.assignee).toBe("Sam");
  });

  it("reports actionDetected=false when no candidate survives validation", async () => {
    reply({
      actionDetected: true,
      actions: [{ agent: "bogus", actionType: "reassign" }],
    });
    const res = await analyzeServiceActions({ ...base, text: "noise" });
    expect(res).toEqual({ actionDetected: false, actions: [] });
  });

  it("caps applied actions at 3 per utterance", async () => {
    const one = {
      agent: "github",
      actionType: "create",
      artifactKind: "github_issue",
      rationale: "x",
    };
    reply({
      actionDetected: true,
      actions: [
        { ...one, actionTitle: "A", artifactTitle: "A" },
        { ...one, actionTitle: "B", artifactTitle: "B" },
        { ...one, actionTitle: "C", artifactTitle: "C" },
        { ...one, actionTitle: "D", artifactTitle: "D" },
        { ...one, actionTitle: "E", artifactTitle: "E" },
      ],
    });
    const res = await analyzeServiceActions({ ...base, text: "create five" });
    expect(res.actions.length).toBeLessThanOrEqual(3);
  });
});
