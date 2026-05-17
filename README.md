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

```bash
npm run build && npm start    # binds $PORT (default 3000)
```

Behind a TLS-terminating proxy — mic capture requires `https://` (or
`localhost`).

## Sponsor track mapping

- **Speechmatics** — live multi-speaker transcription drives the whole loop.
- **Gemini** — interprets statements and produces concise, source-backed cards.
- **Vultr** — single Next.js app, one `npm start`, production-looking demo.
