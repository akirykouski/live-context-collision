# Agent Architecture — how the agents are linked

Focused view of the agentic pipeline after the fan-out + verifier +
memory-curator upgrade. Infra/topology/residency live in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md); this file is only about how the
agents connect and hand off.

## 1. Agent inventory

| # | Agent | File | Tier | Blocking? | Engine |
|---|-------|------|------|-----------|--------|
| 1 | Transcript | `src/hooks/useSpeechmatics.ts` | hot | n/a | Speechmatics realtime |
| 2 | Retrieval (lexical) | `src/lib/memory.ts` | hot | sync | pure TS |
| 3 | Collision Orchestrator | `src/lib/gemini.ts` | hot | yes | control logic |
| 4 | Specialist judges ×5 | `src/lib/collision/specialists.ts` | hot | parallel | Gemini (1 call each) |
| 5 | Evidence Verifier | `src/lib/collision/verifier.ts` | hot | sync | pure TS, no LLM |
| 6 | Memory Curator (scribe) | `src/lib/memory-curator.ts` | warm | fire-and-forget | Gemini |
| 7 | Learned-facts store | `src/lib/learned-facts.ts` | warm | async + sync cache | Valkey / file |
| 8 | Service-Action router | `src/lib/service-actions.ts` | warm | queued | Gemini |
| 9 | Service-Action worker | `src/worker/index.ts` | warm | BullMQ | Gemini |
| 10 | Personal Summary | `src/lib/personal-summary.ts` | cold | post-meeting | Gemini |
| — | AI Gateway (shared) | `src/lib/ai-gateway.ts` | all | — | 4-key Gemini pool |

Specialist judges (#4): `legal_compliance`, `previous_decision`,
`priority_capacity`, `dependency_blocker`, `customer_promise`.

## 2. Hot path — one utterance → one verified card

```
 mic ── Speechmatics realtime (browser) ──► finalized utterance
   │
   ▼  POST /api/collision        (src/app/api/collision/route.ts)
 analyzeUtterance()              ◄── Collision Orchestrator (gemini.ts)
   │
   ├─ 1. hydrateLearnedFacts()   throttled 3s read of learned-facts → sync cache
   ├─ 2. retrieveRelevant(text)  lexical pre-filter over  SEED ∪ LEARNED
   ├─ 3. domain-gate             keep only judges whose fact types were retrieved
   ├─ 4. Promise.all(runSpecialist) ── FAN-OUT (parallel)
   │        legal │ prior-decision │ capacity │ dependency │ customer
   │        each judge sees ONLY its slice of memory + the utterance
   ├─ 5. all judges errored? ──► deterministic seeded fallback
   │        (Gemini outage only — "found nothing" is NOT an error)
   ├─ 6. verifyCard() per card ── VERIFIER (pure TS, zero latency)
   │        grounded quote   → rewrite to fact's verbatim text + real source
   │        fabricated quote  → drop quote
   │        all fabricated    → drop the whole card
   ├─ 7. dedupe(type+headline) → rank(severity) → cap 2 → hydrate(id, trigger)
   ▼
 CollisionResult ─────────────────────────► UI card
   │
   └─ 8. void curateMemory(...)  fire-and-forget AFTER result is built
                                  never awaited, never throws into the response
```

Latency stays ≈ one model call: judges run concurrently (4), the verifier is
pure string work (6), the curator is off the response path (8).

## 3. The write-back loop — the graph learns mid-meeting

This is the link that makes the system more than stateless detection:

```
 utterance N ─► curateMemory()  (fire-and-forget from /api/collision)
                   │ Gemini: extract ONLY new durable facts
                   │ (decision │ commitment │ dependency │ capacity │ blocker)
                   ▼
              appendLearnedFacts()  (learned-facts.ts)
                   │ dedupe by id + normalized statement
                   ├─ Valkey list  workgraph:learned-facts   (if VALKEY_URL)
                   ├─ else  src/data/learned-facts.runtime.json
                   └─ update in-process sync cache
                   ▼
 utterance N+k ─► analyzeUtterance ─► hydrateLearnedFacts ─► retrieveRelevant
                   now retrieves over  SEED ∪ LEARNED
                   ▼
              collides against a decision made earlier in THIS meeting
```

- The **sync cache** lets the synchronous hot-path retrieval see learned
  facts without an `await`.
- **Valkey** makes them visible across processes (web ↔ worker).
- `hydrateLearnedFacts()` is throttled (3s) so an utterance burst doesn't
  hammer the store.
- `/api/work-context/reset` calls `resetLearnedFacts()` to re-arm the demo.

## 4. Linkage graph (who calls whom)

```
useSpeechmatics ─utterance─► /api/collision ─► analyzeUtterance (Orchestrator)
                                                  ├─► memory.retrieveRelevant ─► learnedFactsCache
                                                  ├─► specialists.runSpecialist ×N ─► ai-gateway ─► Gemini
                                                  ├─► verifier.verifyCard            (no LLM)
                                                  └─► (fallback) seeded detector     (no LLM)
                              /api/collision ─► curateMemory ─► ai-gateway ─► Gemini
                                                  └─► learned-facts.append ─► Valkey | file (+cache)

useSpeechmatics ─utterance─► /api/service-actions ─► enqueue (BullMQ/Valkey)
                              worker/index.ts ─► analyzeServiceActions ─► ai-gateway ─► Gemini
                                                └─► work-context.append ─► Valkey | file

(meeting end) ─► /api/personal-summary ─► personal-summary ─► ai-gateway ─► Gemini
                 reads: full transcript + fired cards + memory facts

/api/work-context/reset ─► resetServiceActions  +  resetLearnedFacts
```

Shared substrate that links every agent:

- **AI Gateway** (`ai-gateway.ts`) — every Gemini caller (judges, curator,
  service-actions, summary) goes through one 4-key failover pool.
- **Memory** (`memory.ts`) — the single retrieval surface; merges seed JSON +
  learned cache so all readers see one graph.
- **Valkey / file** — learned-facts store, service-action store, queue + job
  snapshots; `hasValkey()` is the one switch between Valkey and JSON mode.

## 5. Tiers & contracts

- **Hot (must be fast):** Transcript → Retrieval → Orchestrator → Judges →
  Verifier. `analyzeUtterance` contract: empty/malformed → `{false,[]}`;
  `collisionDetected` true only if ≥1 verified card; ≤2 cards; deterministic
  fallback only when *all* judges error.
- **Warm (async, off the card path):** Memory Curator, Learned-facts store,
  Service-Action router/worker. Best-effort — a failure here never affects
  the live card.
- **Cold (post-meeting):** Personal Summary.

## 6. Resilience & trust

- Per-judge isolation: one judge's key/quota error is swallowed (`errored`
  flag); other judges still produce cards.
- Full Gemini outage on the hot path → deterministic seeded detector
  (card id carries a `-fallback-` marker).
- Curator on outage → records nothing, logs `memory curation skipped`.
- Trust gate principle: **only an LLM judges; only deterministic code
  verifies.** No second LLM critic on the hot path.

## 7. Known tradeoff — request multiplier

One utterance now costs up to **5 specialist calls + 1 curator call ≈ 6
Gemini requests** (was 1 fused call). On Gemini free tier (20 req/day/model)
≈ 3 utterances/day. Mitigations, by value:

1. A cheap **triage/router** pre-filter so judges fire only on consequential
   utterances (biggest saving; not yet built).
2. Higher-quota/paid key, or a cheaper model for the specialists.
3. Optional **fused-mode** flag: one combined call in low-quota envs,
   fan-out for demo/prod.

Domain-gating (hot-path step 3) already trims unrelated judges, but a single
Feature-X + Acme utterance legitimately engages ~4 domains.

## 8. Verification status (last live run)

| Path | Status |
|------|--------|
| Specialist fan-out (legal, capacity) live | ✅ verified |
| Verifier — verbatim evidence, correct source/ids | ✅ verified |
| Deterministic fallback under full outage | ✅ verified |
| Curator graceful degradation | ✅ verified |
| Curator successful end-to-end write-back | ⚠️ unverified (free-tier quota exhausted before a curator call landed) |
| `tsc --noEmit` / vitest | ✅ clean / 141 pass |
