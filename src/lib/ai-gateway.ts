import { GoogleGenAI } from "@google/genai";
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from "@google/genai";

/**
 * AI gateway: pools up to 4 Gemini API keys and fails over automatically.
 *
 * Keys are read from the environment, in priority order:
 *   GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, GEMINI_API_KEY_4
 * plus an optional comma-separated GEMINI_API_KEYS. Duplicates are dropped and
 * the list is capped at 4.
 *
 * On a *retryable* failure for a key (auth/quota/rate-limit/5xx/network) the
 * gateway parks that key on a cooldown and moves to the next one. A
 * *non-retryable* failure (e.g. a malformed request from our own code) is
 * thrown immediately — trying other keys would just burn them on the same bug.
 */

const MAX_KEYS = 4;
const COOLDOWN_MS = 60_000;

interface KeyState {
  key: string;
  label: string;
  client: GoogleGenAI;
  /** epoch ms until which this key is benched; 0 = healthy. */
  cooldownUntil: number;
  failures: number;
}

function collectKeys(): { key: string; label: string }[] {
  const raw: { key: string; label: string }[] = [];

  const numbered: [string | undefined, string][] = [
    [process.env.GEMINI_API_KEY, "GEMINI_API_KEY"],
    [process.env.GEMINI_API_KEY_2, "GEMINI_API_KEY_2"],
    [process.env.GEMINI_API_KEY_3, "GEMINI_API_KEY_3"],
    [process.env.GEMINI_API_KEY_4, "GEMINI_API_KEY_4"],
  ];
  for (const [v, label] of numbered) {
    if (v && v.trim()) raw.push({ key: v.trim(), label });
  }

  if (process.env.GEMINI_API_KEYS) {
    process.env.GEMINI_API_KEYS.split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .forEach((k, i) => raw.push({ key: k, label: `GEMINI_API_KEYS[${i}]` }));
  }

  // De-dupe by key value, preserve priority order, cap at MAX_KEYS.
  const seen = new Set<string>();
  const unique: { key: string; label: string }[] = [];
  for (const entry of raw) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    unique.push(entry);
    if (unique.length >= MAX_KEYS) break;
  }
  return unique;
}

let pool: KeyState[] | null = null;

function getPool(): KeyState[] {
  if (pool) return pool;
  const keys = collectKeys();
  if (keys.length === 0) {
    throw new Error(
      "No Gemini API keys configured. Set GEMINI_API_KEY (and optionally GEMINI_API_KEY_2..4).",
    );
  }
  pool = keys.map(({ key, label }) => ({
    key,
    label,
    client: new GoogleGenAI({ apiKey: key }),
    cooldownUntil: 0,
    failures: 0,
  }));
  return pool;
}

/**
 * Retryable = the key/endpoint is the problem, another key might work.
 * Non-retryable = our request is the problem, every key fails identically.
 */
function isRetryable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();

  // Key/quota/network signals first — these are *always* worth another key,
  // regardless of HTTP status. Critically, Gemini returns HTTP 400 with
  // reason API_KEY_INVALID for a dead/wrong key, so we must catch it here
  // BEFORE the generic "400 = our bad request" rule below.
  if (
    /(api_key_invalid|api key not valid|invalid api key|permission|unauthor|forbidden|quota|rate limit|resource exhausted|resource_exhausted|exceeded|suspended|billing)/.test(
      msg,
    )
  )
    return true;
  if (
    /(network|fetch failed|timeout|etimedout|econn|socket|enotfound|unavailable|overloaded|internal error|try again)/.test(
      msg,
    )
  )
    return true;

  const status =
    (err as { status?: number })?.status ??
    (err as { code?: number })?.code ??
    Number(msg.match(/\b(\d{3})\b/)?.[1]);

  if (Number.isFinite(status)) {
    // A genuine bad request from our own code — every key fails identically.
    if (status === 400 || status === 404 || status === 422) return false;
    // Bad/restricted key, quota, or Google-side outage → fail over.
    if (status === 401 || status === 403 || status === 429) return true;
    if (status >= 500) return true;
  }
  return false;
}

export interface GatewayResult {
  response: GenerateContentResponse;
  /** Which key label served the request — useful for the demo HUD. */
  servedBy: string;
}

/**
 * Drop-in replacement for `client.models.generateContent`, with failover.
 * Tries every currently-healthy key; if all are cooling down it still attempts
 * them (a stale cooldown shouldn't take the whole app offline).
 */
export async function generateContent(
  params: GenerateContentParameters,
): Promise<GatewayResult> {
  const states = getPool();
  const now = Date.now();

  // Healthy keys first (priority order), then cooled-down keys as a last resort.
  const healthy = states.filter((s) => s.cooldownUntil <= now);
  const benched = states.filter((s) => s.cooldownUntil > now);
  const order = [...healthy, ...benched];

  let lastErr: unknown;
  for (const state of order) {
    try {
      const response = await state.client.models.generateContent(params);
      state.cooldownUntil = 0;
      state.failures = 0;
      return { response, servedBy: state.label };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        // Our request is broken — failing over wastes keys. Surface it.
        throw err;
      }
      state.failures += 1;
      state.cooldownUntil = Date.now() + COOLDOWN_MS;
      console.warn(
        `[ai-gateway] ${state.label} failed (${state.failures}x), benched ${COOLDOWN_MS / 1000}s: ${
          (err as { message?: string })?.message ?? err
        }`,
      );
    }
  }

  throw new Error(
    `All ${states.length} Gemini key(s) failed. Last error: ${
      (lastErr as { message?: string })?.message ?? String(lastErr)
    }`,
  );
}

/** Snapshot of pool health, for an optional status endpoint / demo HUD. */
export function gatewayStatus() {
  const now = Date.now();
  return getPool().map((s) => ({
    label: s.label,
    healthy: s.cooldownUntil <= now,
    cooldownMsRemaining: Math.max(0, s.cooldownUntil - now),
    failures: s.failures,
  }));
}
