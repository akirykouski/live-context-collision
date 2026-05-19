import type { ServiceAction, ServiceJobSnapshot } from "./types";
import { getValkey, hasValkey } from "./valkey";

const ACTIONS_KEY = "workgraph:actions";
const JOB_KEY_PREFIX = "workgraph:jobs:";
const JOB_TTL_SECONDS = 60 * 60 * 24;

export function useValkeyRuntime(): boolean {
  return hasValkey();
}

export async function getRuntimeActions(): Promise<ServiceAction[] | null> {
  if (!useValkeyRuntime()) return null;
  const raw = await getValkey().lrange(ACTIONS_KEY, 0, -1);
  return raw
    .map((entry) => {
      try {
        return JSON.parse(entry) as ServiceAction;
      } catch {
        return null;
      }
    })
    .filter((action): action is ServiceAction => action !== null);
}

export async function appendRuntimeActions(
  actions: ServiceAction[],
): Promise<ServiceAction[] | null> {
  if (!useValkeyRuntime()) return null;
  if (actions.length > 0) {
    await getValkey().rpush(
      ACTIONS_KEY,
      ...actions.map((action) => JSON.stringify(action)),
    );
  }
  return getRuntimeActions();
}

export async function resetRuntimeActions(): Promise<ServiceAction[] | null> {
  if (!useValkeyRuntime()) return null;
  const redis = getValkey();
  const keys = await redis.keys(`${JOB_KEY_PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(ACTIONS_KEY);
  return [];
}

export async function setJobSnapshot(
  snapshot: ServiceJobSnapshot,
): Promise<void> {
  if (!useValkeyRuntime()) return;
  await getValkey().set(
    `${JOB_KEY_PREFIX}${snapshot.id}`,
    JSON.stringify(snapshot),
    "EX",
    JOB_TTL_SECONDS,
  );
}

export async function getJobSnapshot(
  id: string,
): Promise<ServiceJobSnapshot | null> {
  if (!useValkeyRuntime()) return null;
  const raw = await getValkey().get(`${JOB_KEY_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServiceJobSnapshot;
  } catch {
    return null;
  }
}
