import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { ServiceAction, WorkArtifact, WorkContextResult } from "./types";
import {
  appendRuntimeActions,
  getRuntimeActions,
  resetRuntimeActions,
} from "./runtime-store";
import { getServiceQueueSummary } from "./queue";

interface WorkContextSeed {
  artifacts: WorkArtifact[];
}

interface RuntimeActionsFile {
  actions: ServiceAction[];
}

const DATA_DIR = path.join(process.cwd(), "src", "data");
const SEED_PATH =
  process.env.WORK_CONTEXT_PATH || path.join(DATA_DIR, "work-context.json");
const RUNTIME_PATH =
  process.env.WORK_ACTIONS_PATH ||
  path.join(DATA_DIR, "work-actions.runtime.json");

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
  const valkeyActions = await getRuntimeActions();
  if (valkeyActions) return valkeyActions;

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
  const [seedArtifacts, actions, queue] = await Promise.all([
    getSeedArtifacts(),
    getServiceActions(),
    getServiceQueueSummary(),
  ]);

  return {
    artifacts: applyActionsToArtifacts(seedArtifacts, actions),
    actions,
    queue: queue ?? undefined,
  };
}

export async function appendServiceActions(
  nextActions: ServiceAction[],
): Promise<ServiceAction[]> {
  const valkeyActions = await appendRuntimeActions(nextActions);
  if (valkeyActions) return valkeyActions;

  if (nextActions.length === 0) return getServiceActions();
  const current = await getServiceActions();
  const merged = [...current, ...nextActions];
  await writeRuntime(merged);
  return merged;
}

export async function resetServiceActions(): Promise<ServiceAction[]> {
  const valkeyActions = await resetRuntimeActions();
  if (valkeyActions) return valkeyActions;

  await writeRuntime([]);
  return [];
}
