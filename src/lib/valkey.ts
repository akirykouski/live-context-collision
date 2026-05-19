import IORedis from "ioredis";

let connection: IORedis | null = null;

export function getValkeyUrl(): string | null {
  const url = process.env.VALKEY_URL?.trim();
  return url ? url : null;
}

export function hasValkey(): boolean {
  return getValkeyUrl() !== null;
}

export function getValkey(): IORedis {
  if (connection) return connection;

  const url = getValkeyUrl();
  if (!url) {
    throw new Error("VALKEY_URL is not configured");
  }

  connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
  return connection;
}

export async function closeValkey(): Promise<void> {
  if (!connection) return;
  const current = connection;
  connection = null;
  await current.quit();
}
