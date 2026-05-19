import { NextResponse } from "next/server";
import { GatewayError } from "./ai-gateway";

/**
 * Single sanitized error boundary for the AI routes.
 *
 * Routes must never echo `err.message` to the client: the AI gateway and the
 * upstream provider embed quota ids, internal model/tier names, provider URLs
 * and key-pool size in their errors. This helper logs the full detail
 * server-side and returns a generic, client-safe body with a correct status:
 *
 *   - transient upstream/capacity failure  -> 503 (+ Retry-After)
 *   - everything else                      -> 500
 */
export function aiErrorResponse(err: unknown, label: string): NextResponse {
  // Full detail to the server log only (includes GatewayError.detail).
  if (err instanceof GatewayError) {
    console.error(`[${label}] ${err.message} :: ${err.detail}`);
  } else {
    console.error(`[${label}] engine error`, err);
  }

  const retryable =
    err instanceof GatewayError
      ? err.retryable
      : looksTransient(err);

  if (retryable) {
    return NextResponse.json(
      { error: "The AI service is temporarily unavailable. Please retry shortly." },
      { status: 503, headers: { "Retry-After": "15" } },
    );
  }

  return NextResponse.json(
    { error: "Internal error processing the request." },
    { status: 500 },
  );
}

/** Best-effort transient classification for non-GatewayError throws. */
function looksTransient(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return /(quota|rate limit|resource[_ ]?exhausted|exceeded|temporarily|unavailable|overloaded|timeout|429|503|5\d\d\b)/.test(
    msg,
  );
}
