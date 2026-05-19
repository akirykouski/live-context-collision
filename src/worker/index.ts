import { Worker } from "bullmq";
import { analyzeServiceActions } from "../lib/service-actions";
import {
  SERVICE_ACTION_QUEUE,
  serviceQueueEnabled,
} from "../lib/queue";
import { setJobSnapshot } from "../lib/runtime-store";
import type { ServiceActionJobData } from "../lib/types";
import { getValkey } from "../lib/valkey";
import { appendServiceActions, getWorkContext } from "../lib/work-context";

if (!serviceQueueEnabled()) {
  console.error("[worker] VALKEY_URL is required to run the worker.");
  process.exit(1);
}

const worker = new Worker<ServiceActionJobData>(
  SERVICE_ACTION_QUEUE,
  async (job) => {
    const now = Date.now();
    await setJobSnapshot({
      id: job.id ?? "",
      status: "active",
      actionIds: [],
      createdAt: now,
      updatedAt: now,
    });

    const context = await getWorkContext();
    const result = await analyzeServiceActions({
      speaker: job.data.speaker,
      text: job.data.text,
      recentTranscript: job.data.recentTranscript?.slice(-6),
      artifacts: context.artifacts,
      existingActions: context.actions,
    });

    if (result.actions.length > 0) {
      await appendServiceActions(result.actions);
    }

    const completedAt = Date.now();
    await setJobSnapshot({
      id: job.id ?? "",
      status: "completed",
      actionIds: result.actions.map((action) => action.id),
      createdAt: now,
      updatedAt: completedAt,
    });

    return {
      actionDetected: result.actionDetected,
      actionIds: result.actions.map((action) => action.id),
    };
  },
  {
    connection: getValkey(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  },
);

worker.on("ready", () => {
  console.log(`[worker] listening on ${SERVICE_ACTION_QUEUE}`);
});

worker.on("failed", async (job, err) => {
  const now = Date.now();
  await setJobSnapshot({
    id: job?.id ?? "unknown",
    status: "failed",
    actionIds: [],
    error: err instanceof Error ? err.message : String(err),
    createdAt: now,
    updatedAt: now,
  });
  console.error(`[worker] job ${job?.id ?? "unknown"} failed`, err);
});

async function shutdown() {
  console.log("[worker] shutting down");
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
