import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import type { ServiceAction, WorkArtifact } from "@/lib/types";

const SEED_PATH = path.join(process.cwd(), "src", "data", "work-context.json");
const RUNTIME_PATH = path.join(
  process.cwd(),
  "src",
  "data",
  "work-actions.runtime.json",
);

/** In-memory fs so persistence is deterministic and never touches disk. */
const files = new Map<string, string>();

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return files.get(p) as string;
  }),
  writeFile: vi.fn(async (p: string, body: string) => {
    files.set(p, body);
  }),
}));

import {
  appendServiceActions,
  applyActionsToArtifacts,
  getSeedArtifacts,
  getServiceActions,
  getWorkContext,
  resetServiceActions,
} from "@/lib/work-context";

function artifact(over: Partial<WorkArtifact> = {}): WorkArtifact {
  return {
    id: "gh-1",
    kind: "github_issue",
    title: "Original",
    status: "open",
    assignee: "Valya",
    ...over,
  };
}

function action(over: Partial<ServiceAction> = {}): ServiceAction {
  return {
    id: "svc-1",
    agent: "github",
    actionType: "reassign",
    artifactKind: "github_issue",
    artifactId: "gh-1",
    title: "Reassign to Sam",
    rationale: "Decided in the meeting.",
    basedOn: { speaker: "Speaker 1", text: "Move it to Sam." },
    after: artifact({ assignee: "Sam", title: "Reassigned" }),
    status: "applied",
    createdAt: 1,
    ...over,
  };
}

beforeEach(() => {
  files.clear();
});

describe("work-context.getSeedArtifacts", () => {
  it("returns the seeded artifacts when the file exists", async () => {
    files.set(SEED_PATH, JSON.stringify({ artifacts: [artifact()] }));
    const seed = await getSeedArtifacts();
    expect(seed).toHaveLength(1);
    expect(seed[0].id).toBe("gh-1");
  });

  it("falls back to an empty list when the seed file is missing", async () => {
    expect(await getSeedArtifacts()).toEqual([]);
  });

  it("rethrows non-ENOENT read errors instead of swallowing them", async () => {
    const { readFile } = await import("fs/promises");
    const perm = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    perm.code = "EACCES";
    vi.mocked(readFile).mockRejectedValueOnce(perm);
    await expect(getSeedArtifacts()).rejects.toThrow(/EACCES/);
  });
});

describe("work-context.getServiceActions", () => {
  it("returns [] when the runtime file is missing", async () => {
    expect(await getServiceActions()).toEqual([]);
  });

  it("reads persisted runtime actions", async () => {
    files.set(RUNTIME_PATH, JSON.stringify({ actions: [action()] }));
    const actions = await getServiceActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("svc-1");
  });
});

describe("work-context.applyActionsToArtifacts", () => {
  it("overlays the action's `after` state onto the matching artifact", () => {
    const result = applyActionsToArtifacts(
      [artifact()],
      [action({ after: artifact({ assignee: "Sam" }) })],
    );
    expect(result).toHaveLength(1);
    expect(result[0].assignee).toBe("Sam");
  });

  it("appends a brand-new artifact created by an action", () => {
    const created = artifact({ id: "gh-new", title: "Fresh issue" });
    const result = applyActionsToArtifacts(
      [artifact()],
      [action({ artifactId: "gh-new", after: created })],
    );
    expect(result.map((a) => a.id).sort()).toEqual(["gh-1", "gh-new"]);
  });

  it("does not mutate the input artifacts (deep clone)", () => {
    const input = [artifact()];
    const result = applyActionsToArtifacts(input, [action()]);
    result[0].title = "mutated";
    expect(input[0].title).toBe("Original");
  });
});

describe("work-context.getWorkContext", () => {
  it("merges seed artifacts with applied actions", async () => {
    files.set(SEED_PATH, JSON.stringify({ artifacts: [artifact()] }));
    files.set(RUNTIME_PATH, JSON.stringify({ actions: [action()] }));
    const ctx = await getWorkContext();
    expect(ctx.actions).toHaveLength(1);
    expect(ctx.artifacts.find((a) => a.id === "gh-1")?.assignee).toBe("Sam");
  });
});

describe("work-context.appendServiceActions", () => {
  it("is a no-op for an empty list and does not write", async () => {
    const { writeFile } = await import("fs/promises");
    const result = await appendServiceActions([]);
    expect(result).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("merges new actions onto existing ones and persists them", async () => {
    files.set(RUNTIME_PATH, JSON.stringify({ actions: [action()] }));
    const merged = await appendServiceActions([action({ id: "svc-2" })]);
    expect(merged.map((a) => a.id)).toEqual(["svc-1", "svc-2"]);
    // Survives a round-trip through the persisted file.
    expect((await getServiceActions()).map((a) => a.id)).toEqual([
      "svc-1",
      "svc-2",
    ]);
  });
});

describe("work-context.resetServiceActions", () => {
  it("clears all persisted actions", async () => {
    files.set(RUNTIME_PATH, JSON.stringify({ actions: [action()] }));
    expect(await resetServiceActions()).toEqual([]);
    expect(await getServiceActions()).toEqual([]);
  });
});
