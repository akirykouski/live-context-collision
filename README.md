# Live Context Collision

> Brings missing organizational memory into the meeting **exactly when decisions are being made**.

A live meeting agent that listens in real time, compares every new statement,
promise, priority, or timeline against a shared company memory graph, and slams
an evidence-backed warning card onto the screen the instant it detects a
collision.

It is **not** a note-taker, summarizer, or task generator. The value is
preventing a bad decision *during* the call — not a recap after it.

For AI Olympics, Milan.

---

## How it works

```
mic → Speechmatics real-time → speaker utterances
                                       │
                          local lexical retrieval over the
                          company memory graph (seed JSON)
                                       │
                  Gemini structured call (extract → judge → format)
                                       │
                          evidence-backed collision card → UI
```

The brief's six agent roles (Transcript, Decision Extractor, Memory Retrieval,
Collision Judge, Evidence Formatter, Resolution) are preserved as a pipeline.
Retrieval runs locally for speed; the four reasoning roles are fused into one
low-latency Gemini call so a card appears while the transcript is still
streaming.

### Collision types detected

`legal_compliance` · `previous_decision` · `priority_capacity` ·
`dependency_blocker` · `customer_promise`

## Stack

- **Next.js 15 (App Router) + TypeScript** — single app, deployable to Vultr
- **Speechmatics real-time** — live mic transcription with speaker diarization
- **Gemini** (`gemini-2.5-flash`) — collision reasoning, structured JSON output

## Setup

One command — installs deps on first run, checks keys, starts the server:

```bash
cp .env.example .env.local   # fill SPEECHMATICS_API_KEY and GEMINI_API_KEY
./launch.sh                  # dev → http://localhost:3000
./launch.sh --prod           # production build + start
```

Or manually: `npm install && npm run dev`.

Keys:
- Speechmatics — https://portal.speechmatics.com → API keys
- Gemini — https://aistudio.google.com/apikey

The browser never sees the Speechmatics key: `/api/speechmatics-token` mints a
60-second JWT scoped to real-time.

## Demo script — "Acme launch is about to go wrong" (~90s)

Preloaded company memory (the chips along the top): Legal rejected Feature X on
May 12 (DPA pending), SSO is blocked on Auth Refactor until next Wednesday,
Valya already owns 3 P0s, Acme is a high-value account Sales wants to promise by
Friday.

1. Press **Start meeting**, allow the mic.
2. Speaker 1: *"Acme is getting impatient. I think we should just promise
   Feature X for next Friday."*
   → **Legal / Compliance** card slams in, quoting *Legal Review, May 12*.
3. Speaker 2: *"Agreed. Let's make it P0 and assign Valya."*
   → **Priority / Capacity** card: Valya already owns 3 P0s — choose what gets
   downgraded.

The meeting just avoided two bad decisions, live.

## Company memory

Seeded from [`src/data/memory.json`](src/data/memory.json). Edit that file to
change the scenario — no code changes needed. The store interface in
[`src/lib/memory.ts`](src/lib/memory.ts) can be swapped for Postgres / a vector
DB without touching callers.

## Deploy (Vultr)

Single process (dev / minimal demo):

```bash
npm run build && npm start    # binds $PORT (default 3000)
```

### Multi-region runtime with data residency

```text
visitor
  -> Cloudflare Worker            geo-routes by request.cf.country
  -> Vultr Load Balancer (per zone, managed)   balances + /api/health
  -> N Vultr Compute instances    each runs docker-compose.vultr.yml
       app (Next.js) + worker (BullMQ)
  -> Vultr Managed Valkey (per zone)            data never leaves the zone
```

A *zone* is a legal/geographic region. A user's traffic — and therefore
their data — stays in their zone, so EU users are served from and stored in
the EU. Zones are config-driven (`WORKGRAPH_RESIDENCY_ZONES`), so adding APAC
etc. needs no code change.

- **Edge geo-routing** — `deploy/cloudflare/worker.mjs` reads
  `request.cf.country`, maps it to a zone, and proxies to that zone's Vultr
  Load Balancer. Deploy with `cd deploy/cloudflare && npx wrangler deploy`;
  set each zone's `origin` to its Vultr LB hostname and keep zone ids in sync
  with the app's `WORKGRAPH_RESIDENCY_ZONES`.
- **Per zone**: a managed Vultr Load Balancer fronts the Compute instances and
  health-checks `/api/health`; a Vultr Managed Valkey holds that zone's state.
  Deploy the stack per Compute instance:

  ```bash
  WORKGRAPH_ZONE=eu WORKGRAPH_DATA_ZONE=eu sh scripts/deploy-vultr.sh
  ```

- **App-side enforcement (defense in depth)** — the app does not blindly trust
  the edge. `/api/deployment` reports `residency`: it re-derives the expected
  zone from `CF-IPCountry`/`X-WG-Country` and flags `routedCorrectly: false`
  if a request reached the wrong region, and `consistent: false` if this
  instance's data store is not in the zone it serves. With
  `WORKGRAPH_RESIDENCY_STRICT=true` a cross-zone data store **refuses to
  start** rather than store data in the wrong jurisdiction. The Runtime panel
  surfaces all of this live.

This is not a claim of full GDPR / EU AI Act compliance — it is an auditable
architecture built around the relevant principle: regional users are served
and stored regionally, and the system verifies (not assumes) it.

Mic capture requires `https://` (or `localhost`); terminate TLS at Cloudflare
and/or the Vultr Load Balancer.

## Sponsor track mapping

- **Speechmatics** — live multi-speaker transcription drives the whole loop.
- **Gemini** — interprets statements and produces concise, source-backed cards.
- **Vultr** — per-zone Load Balancer + Compute + Managed Valkey behind a
  Cloudflare geo-router, giving verifiable EU data residency.
