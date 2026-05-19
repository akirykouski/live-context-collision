import { Queue } from "bullmq";
import type { ServiceActionJobData, ServiceQueueSummary } from "./types";
import { getValkey, hasValkey } from "./valkey";

export const SERVICE_ACTION_QUEUE = "workgraph-service-actions";

let queue: Queue<ServiceActionJobData> | null = null;

export function serviceQueueEnabled(): boolean {
  return hasValkey();
}

export function getServiceActionQueue(): Queue<ServiceActionJobData> {
  if (queue) return queue;
  if (!serviceQueueEnabled()) {
    throw new Error("VALKEY_URL is required for the service action queue");
  }
  queue = new Queue<ServiceActionJobData>(SERVICE_ACTION_QUEUE, {
    connection: getValkey(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 1200 },
      removeOnComplete: { age: 60 * 60 * 24, count: 200 },
      removeOnFail: { age: 60 * 60 * 24, count: 100 },
    },
  });
  return queue;
}

export async function enqueueServiceActionJob(
  data: ServiceActionJobData,
): Promise<string> {
  const job = await getServiceActionQueue().add("analyze", data, {
    jobId: `utterance-${hashText(
      [data.speaker, data.text, data.recentTranscript?.map((u) => u.text).join(" ")]
        .filter(Boolean)
        .join("|"),
    )}`,
  });
  return job.id ?? "";
}

export async function getServiceQueueSummary(): Promise<ServiceQueueSummary | null> {
  if (!serviceQueueEnabled()) return null;
  const counts = await getServiceActionQueue().getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
  );
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
