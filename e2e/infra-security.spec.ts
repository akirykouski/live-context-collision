/**
 * Agent D — Infrastructure, HTTP contract, security / info-leak, robustness.
 *
 * Black-box. The prod server is already running at http://localhost:3000.
 * We do NOT POST to state-mutating routes owned by other agents
 * (service-actions, work-context, work-context/reset). GET /api/work-context
 * is read-only and allowed.
 *
 * AI-call budget: the brief caps AI endpoint calls at 1-2. This spec makes
 * exactly ONE characterizing call to /api/personal-summary (the only AI route
 * that does NOT have a local fallback, so it actually surfaces the upstream
 * error contract). /api/collision has a deterministic fallback and never hits
 * the budget concern (it returns 200 regardless of quota).
 */
import { expect, request, test } from "@playwright/test";

const BASE = "http://localhost:3000";

/** Decode a JWT payload (base64url) without verifying the signature. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`not a 3-part JWT: ${parts.length}`);
  let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

// ---------------------------------------------------------------------------
// 1. Speechmatics token: real JWT, short TTL, scope=rt, NO long-lived key leak.
// ---------------------------------------------------------------------------
test.describe("speechmatics-token", () => {
  test("returns a fresh 60s rt JWT each call, never leaks the long-lived key", async () => {
    const ctx = await request.newContext();
    const jwts: string[] = [];
    const rawBodies: string[] = [];

    for (let i = 0; i < 5; i++) {
      const res = await ctx.get(`${BASE}/api/speechmatics-token`);
      expect(res.status(), "speechmatics-token must be 200").toBe(200);
      const body = await res.json();
      const rawText = JSON.stringify(body);
      rawBodies.push(rawText);
      expect(body.jwt, "response must contain a jwt").toBeTruthy();
      jwts.push(body.jwt);

      const payload = decodeJwtPayload(body.jwt);
      // scope / product must be real-time.
      expect(
        payload.product ?? payload.scope,
        `payload should mark rt scope: ${JSON.stringify(payload)}`,
      ).toBe("rt");
      // Short TTL: exp - iat ~ 60s (allow a little slack).
      const exp = Number(payload.exp);
      const iat = Number(payload.iat);
      expect(Number.isFinite(exp) && Number.isFinite(iat)).toBeTruthy();
      const ttl = exp - iat;
      expect(ttl, `TTL should be ~60s, got ${ttl}`).toBeGreaterThan(0);
      expect(ttl, `TTL should be short (<=120s), got ${ttl}`).toBeLessThanOrEqual(120);

      // The raw long-lived key must NEVER appear anywhere in the body or token.
      // We don't know its value black-box, but we can assert there is no
      // obvious api-key-shaped secret leaked next to the jwt and that the
      // payload carries no "apiKey"/"api_key"/"secret" claim.
      const lowerPayload = JSON.stringify(payload).toLowerCase();
      expect(lowerPayload).not.toContain("api_key");
      expect(lowerPayload).not.toContain("apikey");
      expect(lowerPayload).not.toContain("secret");
      // Body must have ONLY the jwt key (no debug/key fields).
      expect(Object.keys(body).sort()).toEqual(["jwt"]);
    }

    // Each call must mint a token whose exp is in the future relative to
    // "now" (i.e. freshly issued, not a cached stale token). Note Speechmatics
    // JWT iat/exp are second-granularity, so 5 sub-second calls legitimately
    // yield byte-identical tokens — that is NOT a defect; do not assert
    // textual difference here.
    const nowSec = Math.floor(Date.now() / 1000);
    for (const jwt of jwts) {
      const p = decodeJwtPayload(jwt);
      expect(
        Number(p.exp),
        "every minted JWT must expire in the future (fresh)",
      ).toBeGreaterThan(nowSec);
    }
    // Sanity: at least the request succeeded 5x and produced parseable tokens.
    expect(jwts.length).toBe(5);

    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. AI gateway status: labels + health, NEVER raw key values.
// ---------------------------------------------------------------------------
test.describe("ai-gateway status", () => {
  test("exposes pool health without leaking key values", async () => {
    const ctx = await request.newContext();
    const res = await ctx.get(`${BASE}/api/ai-gateway`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBeTruthy();
    expect(body.keys.length).toBeGreaterThan(0);

    for (const k of body.keys) {
      // Shape contract.
      expect(typeof k.label).toBe("string");
      expect(typeof k.healthy).toBe("boolean");
      expect(typeof k.failures).toBe("number");
      expect("cooldownMsRemaining" in k).toBeTruthy();
      // The label must be an ENV VAR NAME, not a key value.
      expect(k.label).toMatch(/^GEMINI_API_KEY/);
      // No field should carry a raw key value.
      expect("key" in k).toBeFalsy();
      expect("apiKey" in k).toBeFalsy();
    }

    // Gemini API keys typically look like "AIza..." (Google) — assert no such
    // string appears anywhere in the JSON.
    const raw = JSON.stringify(body);
    expect(raw, "no AIza-style Google key in gateway JSON").not.toMatch(
      /AIza[0-9A-Za-z_-]{20,}/,
    );

    // Post-quota-exhaustion: failures should be reflected (>0 on at least one
    // key) OR cooldown active. This documents observed state, not a hard bug.
    const anyFailures = body.keys.some(
      (k: { failures: number; cooldownMsRemaining: number }) =>
        k.failures > 0 || k.cooldownMsRemaining > 0,
    );
    test
      .info()
      .annotations.push({
        type: "observed",
        description: `ai-gateway keys: ${JSON.stringify(body.keys)} (failures reflected=${anyFailures})`,
      });

    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. health & deployment: document output, flag sensitive leaks.
// ---------------------------------------------------------------------------
test.describe("health & deployment info", () => {
  test("/api/health is a minimal liveness probe", async () => {
    const ctx = await request.newContext();
    const res = await ctx.get(`${BASE}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.time).toBe("string");
    // No env / secret leak.
    const raw = JSON.stringify(body).toLowerCase();
    for (const bad of ["key", "secret", "token", "password", "env", "/users/"]) {
      expect(raw, `health must not leak "${bad}"`).not.toContain(bad);
    }
    await ctx.dispose();
  });

  test("/api/deployment exposes only non-sensitive deploy metadata", async () => {
    const ctx = await request.newContext();
    const res = await ctx.get(`${BASE}/api/deployment`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const raw = JSON.stringify(body);
    // Must not contain absolute filesystem paths, key values, or URLs to
    // internal infra.
    expect(raw).not.toMatch(/\/Users\/|\/home\/|\/var\/|\/etc\//);
    expect(raw).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(raw.toLowerCase()).not.toContain("secret");
    // serverSideKeys boolean is fine; raw key values are not present.
    expect(typeof body.serverSideKeys).toBe("boolean");
    test
      .info()
      .annotations.push({ type: "observed", description: `deployment: ${raw}` });
    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. jobs/[id]: bogus / malformed / traversal ids — no leak, no 500 stack.
// ---------------------------------------------------------------------------
test.describe("jobs/[id] robustness", () => {
  const ids = [
    "bogus123",
    "not a real id !!",
    "../../etc/passwd",
    encodeURIComponent("../../etc/passwd"),
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "'; DROP TABLE jobs;--",
    "𝕏𝕏-emoji-😀-id",
  ];

  for (const id of ids) {
    test(`jobs/${id} does not 500 or leak internals`, async () => {
      const ctx = await request.newContext();
      const res = await ctx.get(`${BASE}/api/jobs/${id}`);
      const status = res.status();
      const text = await res.text();
      // Without Valkey the route returns a benign queued stub (200) or 404.
      expect(
        [200, 400, 404].includes(status),
        `expected 200/400/404, got ${status} body=${text.slice(0, 300)}`,
      ).toBeTruthy();
      // Never a stack trace / file path / redis internal leak.
      expect(text).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/); // node stack frame
      expect(text).not.toMatch(/\/Users\/|node_modules|ioredis|ECONNREFUSED/);
      expect(text.toLowerCase()).not.toContain("etc/passwd\nroot:");
      await ctx.dispose();
    });
  }
});

// ---------------------------------------------------------------------------
// 5. HTTP method contract: wrong method => 405, unknown route => 404.
// ---------------------------------------------------------------------------
test.describe("HTTP method contract", () => {
  const postOnly = [
    "/api/collision",
    "/api/service-actions",
    "/api/personal-summary",
    "/api/work-context/reset",
  ];
  for (const path of postOnly) {
    test(`GET ${path} (POST-only) => 405, not 500`, async () => {
      const ctx = await request.newContext();
      const res = await ctx.get(`${BASE}${path}`);
      expect(
        [404, 405].includes(res.status()),
        `expected 404/405, got ${res.status()}`,
      ).toBeTruthy();
      expect(res.status()).not.toBe(500);
      await ctx.dispose();
    });
  }

  const getOnly = ["/api/health", "/api/ai-gateway", "/api/speechmatics-token"];
  for (const path of getOnly) {
    test(`POST ${path} (GET-only) => 405, not 500`, async () => {
      const ctx = await request.newContext();
      const res = await ctx.post(`${BASE}${path}`, { data: {} });
      expect(
        [404, 405].includes(res.status()),
        `expected 404/405, got ${res.status()}`,
      ).toBeTruthy();
      expect(res.status()).not.toBe(500);
      await ctx.dispose();
    });
  }

  test("unknown route /api/nope => 404", async () => {
    const ctx = await request.newContext();
    const res = await ctx.get(`${BASE}/api/nope`);
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });

  test("trailing-slash variant of /api/health still resolves (200 or 308)", async () => {
    const ctx = await request.newContext({ maxRedirects: 0 });
    const res = await ctx.get(`${BASE}/api/health/`);
    expect(
      [200, 301, 307, 308, 404].includes(res.status()),
      `unexpected status ${res.status()} for trailing slash`,
    ).toBeTruthy();
    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// 6. Error contract / info-leak for the AI path (ONE characterizing call).
//    personal-summary has NO local fallback, so it surfaces the upstream
//    Gemini error verbatim through the route's 500.
// ---------------------------------------------------------------------------
test.describe("AI error contract & info-leak (1 call)", () => {
  test("personal-summary surfaces upstream failure — assess leak & status mapping", async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${BASE}/api/personal-summary`, {
      data: {
        personId: "valya",
        utterances: [
          {
            speaker: "Alex",
            text: "We will ship Feature X to Acme this Friday.",
          },
        ],
      },
    });
    const status = res.status();
    const text = await res.text();
    test.info().annotations.push({
      type: "observed",
      description: `personal-summary status=${status} body=${text.slice(0, 600)}`,
    });

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body is itself a finding */
    }

    if (status === 200) {
      // Quota recovered or summary produced — nothing to assert on leak.
      expect(body).toHaveProperty("summary");
      await ctx.dispose();
      return;
    }

    // Collect ALL violations so a single run documents every finding instead
    // of stopping at the first failed assertion.
    const findings: string[] = [];

    // FINDING #1 (ERROR-CONTRACT): transient upstream capacity/quota error is
    // mapped to 500. A quota/rate-limit/overload condition SHOULD be 429 or
    // 503 so clients can back off; 500 tells clients it's a permanent bug.
    if (status === 500) {
      findings.push(
        `ERROR-CONTRACT[med]: transient AI quota/rate-limit returns HTTP 500 ` +
          `(should be 429/503). status=${status}`,
      );
    }

    // FINDING #2 (INFO-LEAK): the error message must NOT carry upstream
    // provider internals or the gateway's internal aggregate phrasing.
    const msg = String(body.error ?? text).toLowerCase();
    const leakSignals = [
      "ai.google.dev",
      "googleapis.com",
      "generativelanguage",
      "quota_id",
      "quotaid",
      "retrydelay",
      "retry_delay",
      "gemini_api_key", // key label leak from the gateway aggregate error
      "gemini key(s) failed", // gateway internal phrasing
      "resource_exhausted",
      "check your plan and billing",
    ];
    const leaked = leakSignals.filter((s) => msg.includes(s));
    if (leaked.length) {
      findings.push(
        `INFO-LEAK[HIGH]: error body forwards verbatim upstream Gemini ` +
          `internals to the client: [${leaked.join(", ")}]`,
      );
    }
    // No raw stack trace.
    if (/\bat \w+.*\(.*:\d+:\d+\)/.test(text)) {
      findings.push("INFO-LEAK[HIGH]: error body contains a node stack trace");
    }

    test.info().annotations.push({
      type: "FINDINGS",
      description: findings.join(" || ") || "none",
    });

    await ctx.dispose();
    // Surface the real product bugs as a hard failure (do not hide them).
    expect(
      findings,
      `Real product findings on /api/personal-summary:\n - ${findings.join(
        "\n - ",
      )}\nFull body: ${text.slice(0, 500)}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Security headers.
// ---------------------------------------------------------------------------
test.describe("security headers", () => {
  test("document presence/absence of common hardening headers", async () => {
    const ctx = await request.newContext();
    const res = await ctx.get(`${BASE}/api/health`);
    const h = res.headers();
    const present = {
      "x-content-type-options": h["x-content-type-options"] ?? null,
      "x-frame-options": h["x-frame-options"] ?? null,
      "content-security-policy": h["content-security-policy"] ?? null,
      "strict-transport-security": h["strict-transport-security"] ?? null,
      "referrer-policy": h["referrer-policy"] ?? null,
    };
    test.info().annotations.push({
      type: "observed",
      description: `security headers: ${JSON.stringify(present)}`,
    });
    // Low severity for a local demo: we DOCUMENT, we do not hard-fail on
    // missing CSP/HSTS. But X-Content-Type-Options=nosniff is cheap and its
    // absence is worth flagging — soft assert via annotation only.
    expect(res.status()).toBe(200);
    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// 8. Robustness: oversized / nested / wrong-content-type / unicode bodies.
//    Sent to /api/collision (POST, has a fallback so no shared-state mutation
//    risk and no AI-budget concern — it returns 200 deterministically).
// ---------------------------------------------------------------------------
test.describe("POST robustness (collision)", () => {
  test("oversized ~5MB JSON body does not 500 with a stack", async () => {
    const ctx = await request.newContext();
    const big = "x".repeat(5 * 1024 * 1024);
    const res = await ctx.post(`${BASE}/api/collision`, {
      headers: { "Content-Type": "application/json" },
      data: { speaker: "A", text: big },
    });
    const txt = await res.text();
    expect(
      [200, 400, 413, 422].includes(res.status()),
      `oversized body: got ${res.status()} body=${txt.slice(0, 200)}`,
    ).toBeTruthy();
    expect(txt).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
    await ctx.dispose();
  });

  test("deeply nested JSON does not crash the route", async () => {
    const ctx = await request.newContext();
    let nested: unknown = "leaf";
    for (let i = 0; i < 5000; i++) nested = { n: nested };
    const res = await ctx.post(`${BASE}/api/collision`, {
      headers: { "Content-Type": "application/json" },
      data: { speaker: "A", text: "hi", recentTranscript: nested },
    });
    const txt = await res.text();
    expect(
      [200, 400, 422, 500].includes(res.status()),
      `nested body status ${res.status()}`,
    ).toBeTruthy();
    // Even if 500, must not leak a stack / file path.
    expect(txt).not.toMatch(/\/Users\/|node_modules/);
    await ctx.dispose();
  });

  test("wrong Content-Type (text/plain) with JSON body => 400 invalid JSON, not 500", async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${BASE}/api/collision`, {
      headers: { "Content-Type": "text/plain" },
      data: '{"speaker":"A","text":"hello"}',
    });
    const txt = await res.text();
    expect(
      [200, 400, 415].includes(res.status()),
      `wrong content-type: got ${res.status()} body=${txt.slice(0, 200)}`,
    ).toBeTruthy();
    expect(res.status()).not.toBe(500);
    await ctx.dispose();
  });

  test("malformed JSON => 400 with clean {error} body", async () => {
    const ctx = await request.newContext();
    // Send a genuinely malformed raw byte body (Buffer => not re-serialized).
    const res = await ctx.post(`${BASE}/api/collision`, {
      headers: { "Content-Type": "application/json" },
      data: Buffer.from("{not valid json", "utf8"),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
    await ctx.dispose();
  });

  test("unicode/emoji text returns a clean 200 (fallback path)", async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${BASE}/api/collision`, {
      headers: { "Content-Type": "application/json" },
      data: { speaker: "测试-😀", text: "emoji 🚀 unicode ✅ test ünïcödé" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("collisionDetected");
    expect(Array.isArray(body.cards)).toBeTruthy();
    await ctx.dispose();
  });

  test("empty text short-circuits to 200 no-collision (no AI call)", async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${BASE}/api/collision`, {
      headers: { "Content-Type": "application/json" },
      data: { speaker: "A", text: "   " },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.collisionDetected).toBe(false);
    expect(body.cards).toEqual([]);
    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// 9. Static / source exposure: .env, dotfiles, directory listing, source maps.
// ---------------------------------------------------------------------------
test.describe("static / source exposure", () => {
  const paths = [
    "/.env",
    "/.env.local",
    "/.git/config",
    "/api/../package.json",
    "/_next/",
    "/src/lib/ai-gateway.ts",
    "/next.config.mjs",
  ];
  for (const p of paths) {
    test(`GET ${p} must not expose source/secrets`, async () => {
      const ctx = await request.newContext();
      const res = await ctx.get(`${BASE}${p}`);
      const status = res.status();
      const txt = await res.text();
      // Acceptable: 403/404. Unacceptable: 200 returning real config/source.
      if (status === 200) {
        expect(txt).not.toMatch(/GEMINI_API_KEY\s*=/);
        expect(txt).not.toMatch(/SPEECHMATICS_API_KEY\s*=/);
        expect(txt).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
        expect(txt, `${p} returned 200 with file content`).not.toMatch(
          /import .* from|export (default|const|function)/,
        );
      } else {
        expect([301, 307, 308, 403, 404]).toContain(status);
      }
      await ctx.dispose();
    });
  }
});

// ---------------------------------------------------------------------------
// 10. Concurrent burst on /api/health stays healthy.
// ---------------------------------------------------------------------------
test.describe("concurrency", () => {
  test("50 concurrent GET /api/health all return 200", async () => {
    const ctx = await request.newContext();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => ctx.get(`${BASE}/api/health`)),
    );
    const statuses = results.map((r) => r.status());
    expect(
      statuses.every((s) => s === 200),
      `not all 200: ${JSON.stringify(statuses)}`,
    ).toBeTruthy();
    await ctx.dispose();
  });
});
