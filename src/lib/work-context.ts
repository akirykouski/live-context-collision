import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { ServiceAction, WorkArtifact, WorkContextResult } from "./types";

interface WorkContextSeed {
  artifacts: WorkArtifact[];
}

interface RuntimeActionsFile {
  actions: ServiceAction[];
}

const DATA_DIR = path.join(process.cwd(), "src", "data");
const SEED_PATH = path.join(DATA_DIR, "work-context.json");
const RUNTIME_PATH = path.join(DATA_DIR, "work-actions.runtime.json");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return clone(fallback);
    throw err;
  }
}

async function writeRuntime(actions: ServiceAction[]): Promise<void> {
  const body = `${JSON.stringify({ actions }, null, 2)}\n`;
  await writeFile(RUNTIME_PATH, body, "utf8");
}

export async function getSeedArtifacts(): Promise<WorkArtifact[]> {
  const seed = await readJson<WorkContextSeed>(SEED_PATH, { artifacts: [] });
  return clone(seed.artifacts ?? []);
}

export async function getServiceActions(): Promise<ServiceAction[]> {
  const runtime = await readJson<RuntimeActionsFile>(RUNTIME_PATH, {
    actions: [],
  });
  return clone(runtime.actions ?? []);
}

export function applyActionsToArtifacts(
  artifacts: WorkArtifact[],
  actions: ServiceAction[],
): WorkArtifact[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, clone(artifact)]));

  for (const action of actions) {
    byId.set(action.after.id, clone(action.after));
  }

  return [...byId.values()];
}

export async function getWorkContext(): Promise<WorkContextResult> {
  const [seedArtifacts, actions] = await Promise.all([
    getSeedArtifacts(),
    getServiceActions(),
  ]);

  return {
    artifacts: applyActionsToArtifacts(seedArtifacts, actions),
    actions,
  };
}

export async function appendServiceActions(
  nextActions: ServiceAction[],
): Promise<ServiceAction[]> {
  if (nextActions.length === 0) return getServiceActions();
  const current = await getServiceActions();
  const merged = [...current, ...nextActions];
  await writeRuntime(merged);
  return merged;
}

export async function resetServiceActions(): Promise<ServiceAction[]> {
  await writeRuntime([]);
  return [];
}
