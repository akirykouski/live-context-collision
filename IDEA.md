# The Idea

> Code-grounded summary at commit `14abecb`. Sources: `README.md`,
> `package.json`, `src/lib/*`, `src/app/api/*`, `src/app/page.tsx`.

## One line

**Live Context Collision** — a real-time meeting agent that surfaces the
*missing organizational memory* exactly when a decision is being made, before
the wrong call is locked in.

## The problem

Teams make decisions in meetings without the context that already exists
somewhere else — a prior decision, a legal blocker, someone's capacity, a
customer promise, a dependency. By the time anyone finds the conflicting fact,
the decision has shipped. The knowledge existed; it just wasn't *in the room
at the moment it mattered*.

## What it does

While people talk, the app listens, and the instant a statement collides with
known organizational memory it raises an **evidence-backed card** — the
conflict, the quoted source facts, and a suggested next step. It does not
summarize after the fact; it intervenes during the decision.

Three surfaces, all driven by the same live transcript:

1. **Live collision detection (the hot path).** Each finalized utterance is
   checked against a company memory graph. Specialist analyzers
   (`src/lib/collision/specialists.ts`) propose collisions across fixed types
   — `legal_compliance`, `previous_decision`, `priority_capacity`,
   `dependency_blocker`, `customer_promise` — and a deterministic verifier
   (`collision/verifier.ts`) gates them so cards are quoted, not hallucinated.
   This path is **synchronous on purpose**: latency is the product.

2. **Service agents / Action Center (off the hot path).** Slower automation
   watches the same conversation and proposes concrete changes to work
   systems — create/update a GitHub issue, Jira/Notion task, reassign,
   re-prioritize, draft an email — each with a before/after diff and the
   verbatim utterance it was based on (`src/lib/service-actions.ts`,
   `src/lib/types.ts`). Every AI action is visible and auditable.

3. **Personal post-meeting summary.** After the meeting, a named participant
   gets a first-person recap — their action items, decisions affecting them,
   flags raised, open questions to pick up (`src/lib/personal-summary.ts`).

The memory itself is not static: `src/lib/memory-curator.ts` curates new
*learned facts* from the conversation so the graph improves across meetings.

## How it works (mechanism, from code)

- **Speechmatics** does live multi-speaker transcription. Audio never touches
  our backend — the browser mints a short-lived JWT from
  `/api/speechmatics-token` and streams directly to Speechmatics.
- **Gemini** interprets statements and produces concise, source-backed output,
  always server-side behind a multi-key failover gateway
  (`src/lib/ai-gateway.ts`).
- **Vultr** is the runtime: a Cloudflare edge Worker geo-routes each visitor
  by country to a per-region Vultr Load Balancer → stateless app/worker
  instances → a region-local Managed Valkey. A user's traffic and data stay
  in their region.

## Why it's differentiated

- **Intervention, not recap.** Value is delivered mid-decision, not in
  post-meeting notes.
- **Evidence-gated.** Cards quote real memory facts; a verifier rejects
  unsupported claims — built against hallucination.
- **Auditable automation.** Service actions carry a before/after trail and the
  utterance that triggered them.
- **Verifiable data residency.** The system *checks* that the edge routed a
  user to the correct region and refuses to start if its data store is in the
  wrong zone — an auditable architecture, explicitly *not* a blanket GDPR
  compliance claim (`src/lib/residency.ts`, `README.md`).
- **Latency-aware split.** Realtime decisions stay synchronous; slower
  automations are queued through Valkey — the architecture respects the
  constraint that "in the room, now" is the whole point.

## Sponsor mapping (from `README.md`)

- **Speechmatics** — live multi-speaker transcription drives the whole loop.
- **Gemini** — interprets statements into concise, source-backed cards.
- **Vultr** — per-zone Load Balancer + Compute + Managed Valkey behind a
  Cloudflare geo-router, giving verifiable EU data residency.
