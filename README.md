<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
<div align="center">

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![Speechmatics](https://img.shields.io/badge/Speechmatics-realtime-6c5ce7)
![Gemini](https://img.shields.io/badge/Gemini-2.5--flash-4285F4?logo=google)
![Vultr](https://img.shields.io/badge/Vultr-multi--region-007BFC)
![Tests](https://img.shields.io/badge/tests-220%20passing-brightgreen)

</div>

<!-- PROJECT HEADER -->
<br />
<div align="center">
  <h1 align="center">Live Context Collision</h1>

  <p align="center">
    A real-time meeting agent that surfaces missing organizational memory
    <strong> exactly when a decision is being made</strong> — before the wrong call is locked in.
    <br />
    <br />
    <a href="ARCHITECTURE.md"><strong>Architecture deep-dive »</strong></a>
    ·
    <a href="docs/AGENTS.md">Agent pipeline</a>
    ·
    <a href="IDEA.md">The idea</a>
    <br />
    <br />
    <em>Built for the <a href="https://lablab.ai/ai-hackathons/milan-ai-week-hackathon">Milan AI Week Hackathon</a> — Speechmatics · Gemini · Vultr tracks.</em>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li><a href="#how-it-works">How It Works</a></li>
    <li><a href="#getting-started">Getting Started</a></li>
    <li><a href="#the-90-second-demo">The 90-Second Demo</a></li>
    <li><a href="#architecture-at-a-glance">Architecture at a Glance</a></li>
    <li><a href="#data-residency">Data Residency</a></li>
    <li><a href="#testing">Testing</a></li>
    <li><a href="#roadmap--wiring-status">Roadmap & Wiring Status</a></li>
    <li><a href="#sponsor-track-mapping">Sponsor Track Mapping</a></li>
  </ol>
</details>

<!-- ABOUT -->
## About The Project

Teams make decisions in meetings without the context that already exists
*somewhere else* — a prior decision, a legal blocker, someone's capacity, a
customer promise, a dependency. By the time anyone finds the conflicting fact,
the decision has already shipped. The knowledge existed; it just wasn't **in the
room at the moment it mattered**.

**Live Context Collision** listens to the meeting in real time, compares every
new statement, promise, priority, or timeline against a shared company memory
graph, and slams an **evidence-backed warning card** onto the screen the instant
it detects a collision.

It is **not** a note-taker, summarizer, or task generator. The value is
preventing a bad decision *during* the call — not a recap after it.

Three surfaces, all driven by the same live transcript:

| Surface | What it does | Latency tier |
| --- | --- | --- |
| **Live collision detection** | Each finalized utterance is checked against the memory graph; specialist judges propose collisions, a deterministic verifier gates them so cards are *quoted, not hallucinated*. | Hot — synchronous on purpose |
| **Service agents / Action Center** | Slower automation proposes concrete changes to work systems (GitHub / Jira / Notion / email) with a before→after diff and the verbatim utterance it acted on. | Warm — queued |
| **Personal post-meeting summary** | A named participant gets a first-person recap: their action items, decisions affecting them, flags raised, open questions. | Cold — post-meeting |

The memory itself is not static — a memory-curator distills new *learned facts*
from the conversation so the graph improves across meetings.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- BUILT WITH -->
## Built With

- **[Next.js 15](https://nextjs.org/)** (App Router) + **TypeScript** — single deployable app
- **[Speechmatics Real-Time](https://www.speechmatics.com/)** — live multi-speaker transcription with diarization
- **[Google Gemini](https://ai.google.dev/)** (`gemini-2.5-flash`) — collision reasoning, structured JSON output
- **[Vultr](https://www.vultr.com/)** — multi-region Compute + managed Load Balancer + Managed Valkey
- **[Cloudflare Workers](https://workers.cloudflare.com/)** — edge geo-router for data residency
- **[BullMQ](https://docs.bullmq.io/)** + **[ioredis](https://github.com/redis/ioredis)** — off-hot-path job queue
- **[Vitest](https://vitest.dev/)** + **[Playwright](https://playwright.dev/)** — unit + e2e suites

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- HOW IT WORKS -->
## How It Works

```
mic / shared tab → Speechmatics real-time → speaker utterances
                                                   │
                       local lexical retrieval over the company
                       memory graph  (seed JSON ∪ learned facts)
                                                   │
        5 specialist Gemini judges (parallel) → deterministic verifier
                                                   │
                       evidence-backed collision card → UI
                                                   │
                       fire-and-forget memory curation (graph learns)
```

The brief's six agent roles (Transcript, Decision Extractor, Memory Retrieval,
Collision Judge, Evidence Formatter, Resolution) are preserved as a pipeline.
Retrieval runs locally for speed; the reasoning roles are split into five
parallel specialist judges so a verified card appears while the transcript is
still streaming.

**Collision types detected:**
`legal_compliance` · `previous_decision` · `priority_capacity` ·
`dependency_blocker` · `customer_promise`

> **Trust gate principle:** only an LLM *judges*; only deterministic code
> *verifies*. A card's quote is rewritten to the memory fact's verbatim text or
> dropped — there is no second LLM critic on the hot path.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

- Node.js 20+
- A [Speechmatics API key](https://portal.speechmatics.com) (Portal → API keys)
- A [Gemini API key](https://aistudio.google.com/apikey)

### Installation

One command — installs deps on first run, checks keys, starts the server:

```bash
cp .env.example .env.local   # fill SPEECHMATICS_API_KEY and GEMINI_API_KEY
./launch.sh                  # dev → http://localhost:3000
./launch.sh --prod           # production build + start
```

Or manually: `npm install && npm run dev`.

> The browser **never sees the Speechmatics key**: `/api/speechmatics-token`
> mints a 60-second JWT scoped to real-time and (Layer 1) attaches the custom
> dictionary the browser seeds into `transcription_config.additional_vocab`.
> Gemini is **always server-side**, behind a multi-key failover gateway.

Mic capture requires `https://` (or `localhost`).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- DEMO -->
## The 90-Second Demo

> *"The Acme launch is about to go wrong."*

Preloaded company memory (the chips along the top): Legal rejected Feature X on
May 12 (DPA pending) · SSO is blocked on Auth Refactor until next Wednesday ·
Valya already owns 3 P0s · Acme is a high-value account Sales wants to promise
by Friday.

1. Press **Start meeting**, allow the mic.
2. **Speaker 1:** *"Acme is getting impatient. I think we should just promise
   Feature X for next Friday."*
   → **Legal / Compliance** card slams in, quoting *Legal Review, May 12*.
3. **Speaker 2:** *"Agreed. Let's make it P0 and assign Valya."*
   → **Priority / Capacity** card: Valya already owns 3 P0s — choose what gets
   downgraded.
4. Press **Stop**, pick a participant → **personal post-meeting summary**.

The meeting just avoided two bad decisions, live.

Edit [`src/data/memory.json`](src/data/memory.json) to change the scenario — no
code changes needed. The store interface in
[`src/lib/memory.ts`](src/lib/memory.ts) can be swapped for Postgres / a vector
DB without touching callers.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ARCHITECTURE -->
## Architecture at a Glance

```text
visitor
  └─ Cloudflare Worker            geo-routes by request.cf.country
       └─ Vultr Load Balancer     per zone, managed, health-checks /api/health
            └─ N Vultr Compute    app (Next.js) + worker (BullMQ), stateless
                 └─ Managed Valkey per zone — data never leaves the zone
```

Two processing paths share one transcript:

- **Live (synchronous):** `/api/collision` → lexical retrieval → 5 parallel
  Gemini specialist judges → deterministic verifier → card. Latency *is* the
  product.
- **Queued (off the hot path):** `/api/service-actions` → BullMQ (when Valkey
  is present) → worker → Action Center, with full before/after audit trail.

Two newer subsystems harden the input side:

- **Pre-Warmer** (`src/lib/prewarm/*`) — 5–15 min before a meeting, fans out to
  pluggable sources (graph, calendar, GitHub, Jira, Notion, Slack), ranks
  candidates with a deterministic relevance formula, and hot-loads the top
  facts + an ASR vocabulary into Valkey for that meeting.
- **Transcript Enhancer** (`src/lib/transcript/*`) — three *non-destructive*
  overlay layers: (1) a custom Speechmatics dictionary seeded before
  recognition, (2) a per-utterance fuzzy + LLM entity resolver, (3) a sliding
  ~75 s window pass for pronouns/cross-references. Raw text is never rewritten;
  cards still quote the original.

📐 **Full, code-grounded architecture (Mermaid diagrams, source map, the two
processing paths, residency enforcement, and a candid review of what is wired
vs. dormant):** see **[ARCHITECTURE.md](ARCHITECTURE.md)**.
🤖 **How the agents hand off (hot/warm/cold tiers, the write-back loop):** see
**[docs/AGENTS.md](docs/AGENTS.md)**.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- RESIDENCY -->
## Data Residency

A *zone* is a legal/geographic region. A user's traffic — and therefore their
data — stays in their zone, so EU users are served from and stored in the EU.
Zones are config-driven (`WORKGRAPH_RESIDENCY_ZONES`); adding APAC etc. needs no
code change.

- **Edge geo-routing** — `deploy/cloudflare/worker.mjs` reads
  `request.cf.country`, maps it to a zone, proxies to that zone's Vultr LB.
- **Per zone** — a managed Vultr Load Balancer + a Managed Valkey holding that
  zone's state.
- **App-side enforcement (defense in depth)** — `/api/deployment` re-derives
  the expected zone from `CF-IPCountry`/`X-WG-Country` and flags
  `routedCorrectly: false` / `consistent: false`. With
  `WORKGRAPH_RESIDENCY_STRICT=true` a cross-zone data store **refuses to
  start**. The Runtime panel surfaces all of this live.

> This is not a claim of full GDPR / EU AI Act compliance — it is an *auditable*
> architecture built around the relevant principle: regional users are served
> and stored regionally, and the system **verifies (not assumes)** it.

Deploy: `WORKGRAPH_ZONE=eu WORKGRAPH_DATA_ZONE=eu sh scripts/deploy-vultr.sh`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- TESTING -->
## Testing

```bash
npm run test          # vitest — 220 passing
npm run coverage      # v8 coverage
npm run typecheck     # tsc --noEmit
npx playwright test   # e2e
```

> **Known red:** `tests/api/speechmatics-token.test.ts` (1 test) is stale — the
> token route now returns `{ jwt, additionalVocab }` (Transcript Layer 1) but
> the test still asserts `{ jwt }`. Tracked in
> [Roadmap & Wiring Status](#roadmap--wiring-status).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap & Wiring Status

The two newer subsystems are **fully implemented and unit-tested**, but
deliberately staged. Honest status:

- [x] Live collision detection (specialist fan-out + verifier) — **wired**
- [x] Service-action queue + Action Center — **wired**
- [x] Personal post-meeting summary — **wired**
- [x] Memory curator write-back loop — **wired**
- [x] Multi-region residency (edge + app-side enforcement) — **wired**
- [x] Transcript **Layer 1** custom dictionary — **wired** (served by `/api/speechmatics-token`)
- [ ] Transcript **Layer 2/3** (entity resolver, window normalizer) — built + tested; endpoints live, **no UI caller yet**
- [ ] Pre-Warmer → collision seam — `hotFactsFor()` exists, but `gemini.ts` does not call it yet; the scheduler runs only via `/api/prewarm/trigger` (no cron)
- [ ] Cheap triage/router pre-filter to cut the per-utterance Gemini request multiplier
- [ ] Fix the stale `speechmatics-token` test
- [ ] Real GitHub / Jira / Notion / Slack source clients (Phase 2)

See [ARCHITECTURE.md §12](ARCHITECTURE.md) for the full review.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- SPONSORS -->
## Sponsor Track Mapping

- **Speechmatics** — live multi-speaker transcription drives the whole loop;
  a custom dictionary is seeded into recognition before the meeting starts.
- **Gemini** — interprets statements into concise, source-backed cards behind a
  multi-key failover gateway.
- **Vultr** — per-zone Load Balancer + Compute + Managed Valkey behind a
  Cloudflare geo-router, giving verifiable EU data residency.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<div align="center">
<sub>Live Context Collision · built for the Milan AI Week Hackathon ·
README structured with <a href="https://github.com/othneildrew/Best-README-Template">Best-README-Template</a></sub>
</div>
