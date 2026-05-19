# Live Context Collision — Megaplan

> Research-grade improvement plan for **product** and **software/code architecture**.
> Grounded in a full source audit (commit `e399a6b` + uncommitted `prewarm/`,
> `transcript/` trees) by six parallel subsystem deep-dives. Every claim below
> is backed by a `file:line` reference from the audit. Nothing here is
> aspirational hand-waving; each item states the evidence, the proposal, the
> effort, and the expected impact.

---

## 0. Executive summary

The product is architecturally ambitious and unusually disciplined for a
hackathon build: a synchronous evidence-gated collision path, a queued
automation path, multi-region residency, a multi-key AI gateway, and ~98%
line coverage on the committed core. The reasoning *engines* are well-designed
and well-tested.

But the audit surfaces one structural fact that dominates everything else:

> **The two newest, highest-value subsystems — the Pre-Warmer
> (`src/lib/prewarm/`) and the Transcript Enhancer (`src/lib/transcript/`) —
> are fully built, fully unit-tested, and completely unwired. They are dead
> code. The collision hot path never calls `hotFactsFor`; the browser computes
> the ASR custom dictionary and then throws it away.**

The single most leveraged work in this entire plan is not new features — it is
*connecting subsystems that already exist*. Three seams (`gemini.ts` ←
`hotFactsFor`, `useSpeechmatics.ts` ← `additionalVocab`, `onUtterance` ←
`/api/transcript/resolve`) unlock latency, transcription accuracy, and
collision recall that the team has *already paid to build*.

Second-order theme: the system is **demo-overfit and gate-red**. Retrieval is
purely lexical and silently leaning on four hardcoded scenario regexes;
typecheck and the test suite currently fail (6 type errors, 7 test failures);
there is no CI; and there is no mic-free demo/replay mode — the biggest single
risk to the thing actually working when it is shown.

Third: **no authentication or rate limiting anywhere**, and the JSON-file
state fallback is silently broken in any multi-process deployment.

This plan is sequenced so that the cheapest, highest-impact, lowest-risk work
(wire the dead subsystems; make the gates green; add CI) comes first, before
any net-new capability.

---

## 1. Method & scope

- **Inputs:** `README.md`, `ARCHITECTURE.md`, `IDEA.md`, `package.json`, and a
  line-level read of `src/lib/**`, `src/app/api/**`, `src/app/page.tsx`,
  `src/hooks/**`, `src/worker/**`, `deploy/**`, `docker-compose*.yml`,
  `tests/**`, `e2e/**`.
- **Health probes run:** `npm run typecheck`, `npm test` (results in §3).
- **Six audit lenses:** collision pipeline · prewarm · transcript · infra/gateway/state ·
  frontend/UX · tests/CI/DevEx.
- **Out of scope:** rewriting the product thesis. The "intervene mid-decision,
  evidence-gated, not a recap" thesis is sound and is preserved throughout.

Effort key: **S** ≤1 day · **M** 2–4 days · **L** ~1–2 weeks · **XL** >2 weeks.
Impact key: ★ marginal · ★★ meaningful · ★★★ step-change.

---

## 2. System model (as-built)

```
mic/tab audio ──► Speechmatics RT (direct, browser holds 60s JWT)
                        │  utterances (S1/S2, EOS-segmented)
                        ▼
            page.tsx onUtterance ──┬──► POST /api/collision   (SYNC, latency = product)
                                   │       hydrateLearnedFacts → retrieveRelevant (LEXICAL)
                                   │       → domain prefilter → Promise.all(specialists→Gemini)
                                   │       → verifier (bag-of-words) → dedupeRankCap(2)
                                   │       → fire-and-forget curateMemory (6th Gemini call)
                                   └──► POST /api/service-actions (QUEUED iff Valkey)
                                           BullMQ → worker → Notion + appendServiceActions

  DEAD: prewarm/  (hot facts + ASR vocab + manifest, ranked, TTL'd) — never consumed on hot path
  DEAD: transcript/ (Layer1 vocab / Layer2 entity-resolve / Layer3 window-normalize) — no caller
```

Key truths from the audit:

- The collision path makes **1 effective Gemini round-trip** (specialists run
  `Promise.all`, `gemini.ts:202`) + a 6th fire-and-forget curator call.
- Retrieval is **lexical substring scoring only** (`memory.ts:30-64`) — no
  embeddings, no stemming, false-positive substring hits.
- The deterministic fallback (`gemini.ts:52-143`) is **hardcoded to the 4 demo
  scenarios** and runs as a silent "safety net" on *every* empty live result
  (`gemini.ts:236`), masking the model's true miss rate.
- `prewarm`/`transcript` engines are inert: `AnalyzeArgs` has no `meetingId`
  (`gemini.ts:145-150`); `useSpeechmatics.ts:103-107` discards
  `tokenJson.additionalVocab`; `/api/transcript/*` has no caller.
- No auth on any route; `/api/speechmatics-token` mints unlimited JWTs
  (`speechmatics-token/route.ts:13`).
- Typecheck + tests are **currently failing**; there is **no CI**.

---

## 3. Current health — fix before anything else (P0 hygiene)

| Problem | Evidence | Fix | Effort |
|---|---|---|---|
| `npm run typecheck` exits 1 — 6 errors | `speechmatics-token.test.ts:20/31/44` (GET now takes a `Request`), `prewarm-ranker.test.ts:118/125` (literal-type widening), `transcript-resolver.test.ts:70` (`EnhancedUtterance.text` doesn't exist) | Update tests to new signatures/shapes | S |
| `npm test` exits 1 — 7 failures / 3 files | `speechmatics-token.test.ts:33` asserts `{jwt}` but route returns `{jwt, additionalVocab}`; `verbatim.test.ts` & `transcript-resolver.test.ts:142` fail on unhandled rejections from outage-simulation mocks | Update contract assertions in unit **and** `e2e/infra-security.spec.ts:69`; set `dangerouslyIgnoreUnhandledErrors` / settle late race promises in `vitest.config.ts` | S |
| `tail`-masked exit codes hid the breakage | `npm run typecheck 2>&1 \| tail` returns tail's exit 0 | Never pipe gate commands through `tail` in scripts/docs | S |
| No CI — broken state reached `main` working tree | no `.github/workflows` | Add Actions: `npm ci && typecheck && lint && test && build` on PR; gitignore `coverage/`, `test-results/`, `tsconfig.tsbuildinfo` | S |
| In-flight subsystems uncommitted | `prewarm/`, `transcript/`, modified `specialists.ts`/route untracked | Commit behind the gates once green; they are well-tested and at risk of loss | S |

**Nothing else in this plan should start until §3 is green and CI is enforcing
it.** A "decision safety" product whose own safety gates are red is not
credible.

---

# PART A — Product improvements

## A1. Activate the dead subsystems (★★★, the highest ROI in the plan)

The team has already built and tested three capabilities that are switched
off. Wiring them is small, low-risk, and individually step-change.

### A1.1 — Wire the Pre-Warmer hot facts into collision · M · ★★★
- **Evidence:** `hotFactsFor` (`specialists.ts:22-47`) is defined and tested
  but has zero call sites; `gemini.ts:193` always calls the cold lexical
  `retrieveRelevant`; `AnalyzeArgs` lacks `meetingId` (`gemini.ts:145-150`).
- **Proposal:** add `meetingId` to `AnalyzeArgs`, thread it from
  `page.tsx → /api/collision`, and make retrieval
  `await hotFactsFor(meetingId) ?? retrieveRelevant(contextText)`. Add a
  trigger->hot->collision integration test (currently nothing asserts the hot
  path is consumed).
- **Impact:** removes the synchronous cold store read + lexical bottleneck
  from the hot path; gives meeting-scoped, pre-ranked context. This is the
  prewarmer's entire purpose, currently delivering zero collision value.

### A1.2 — Wire the ASR custom dictionary (Transcript Layer 1) · S · ★★★
- **Evidence:** `/api/speechmatics-token` builds `additionalVocab`
  (`speechmatics-token/route.ts:36-45`) but `useSpeechmatics.ts:103-107`
  reads only `tokenJson.jwt`; `client.start()` sets no `additional_vocab`
  (`:195-201`); the fetch sends no `meetingId`, so the highest-rank prewarm
  vocab branch never runs (`dictionary-builder.ts:153`).
- **Proposal:** send `?meetingId=`, read `tokenJson.additionalVocab`, pass it
  into `transcription_config.additional_vocab`. Add an e2e assertion that the
  browser actually sends it.
- **Impact:** domain names (people, project codenames, memory entities) get
  transcribed correctly *at the source* — a name the ASR never gets right
  cannot be repaired downstream. Zero added hot-path latency (runs at token
  mint). Highest accuracy-per-effort item in the document.

### A1.3 — Wire entity resolution (Transcript Layer 2) as a parallel sidecar · M · ★★
- **Evidence:** `/api/transcript/resolve` is correct and tested but has no
  caller; `EnhancedUtterance` is write-only.
- **Proposal:** in `onUtterance`, fire `/api/transcript/resolve` *in parallel*
  with `/api/collision` (it is hard-capped at 500ms,
  `entity-resolver.ts:299-322`, never blocks). Feed resolved entities + ISO
  dates into the collision context. Batch ambiguous spans into one Gemini call
  instead of the current serial per-span loop (`entity-resolver.ts:251-283`).
- **Impact:** grounds pronouns/entities and normalizes "next Friday" → ISO
  before the collision judge sees them — directly lifts recall and reduces
  date-ambiguity false negatives.

### A1.4 — Schedule the prewarm + window-normalizer loops · M · ★★
- **Evidence:** `prewarm/trigger` and `/api/transcript/normalize` exist but no
  cron/scheduler invokes them (`scheduler.ts` header claims a cron that
  doesn't exist; Layer 3 route comment promises a scheduler absent from
  `src/`).
- **Proposal:** add a real scheduler (cron route, or interval in `worker/`):
  prewarm tick every 60s over the eligibility window; per-session
  window-normalize every ~75s feeding curator/summary.
- **Impact:** makes the prewarmer real (today only graph+calendar fire) and
  gives the post-meeting summary cross-reference resolution.

## A2. Trust, perception & in-meeting UX (★★★ for a "decision safety" product)

### A2.1 — Mic-free demo / replay mode · S · ★★★ (biggest demo de-risk)
- **Evidence:** the summary modal is unreachable without a live mic meeting
  (`page.tsx:278-286`); `e2e/personal-summary.spec.ts:471-490` and
  `collision-ui.spec.ts:98-111` document this dead-end. No replay path exists.
- **Proposal:** a "Run demo" control that feeds a seeded transcript (the
  `REALISTIC` array already exists in `personal-summary.spec.ts:26-37`) into
  `onUtterance` on a timer — exercising the full collision + summary story
  with no mic/Speechmatics dependency.
- **Impact:** removes the single biggest live-failure risk; makes the whole
  product demonstrable, testable headless, and reachable for the summary.

### A2.2 — "Analyzing…" affordance + non-silent AI failure · S · ★★★
- **Evidence:** up to ~30s between sentence and card with the column just
  reading "monitoring"; collision/service-action errors are swallowed in empty
  `catch {}` (`page.tsx:176`, `:219`) — a missed collision is *invisible*.
- **Proposal:** track in-flight `analyze` calls → subtle pending indicator;
  on failure set a soft inline marker on the triggering utterance ("analysis
  unavailable — retry") with a retry affordance.
- **Impact:** a safety product that fails silently has no credibility. This
  makes the safety net *visibly alive*.

### A2.3 — Collision card lifecycle · M · ★★
- **Evidence:** cards are read-only and never deduped
  (`setCards(prev => [...data.cards, ...prev])`, `page.tsx:172`); the same
  fact re-triggers and floods the column with no clear/ack/dismiss.
- **Proposal:** dedupe by `collisionType+factIds`; add acknowledge / dismiss /
  snooze; keep the column signal-dense over a 30-min meeting.
- **Impact:** the difference between a demo prop and something usable in a
  real meeting.

### A2.4 — Sanitize the personal-summary error leak · S · ★★ (also security)
- **Evidence:** on Gemini quota exhaustion the modal renders the verbatim
  Google API error JSON incl. quota IDs/URLs
  (`e2e/personal-summary.spec.ts:177-202`) — the only path that doesn't use
  the `aiErrorResponse` discipline.
- **Proposal:** route summary failures through `api-error.ts`; show "Summary
  engine is busy — try again." Never render provider JSON.

### A2.5 — Transcript/summary persistence & export · M · ★★
- **Evidence:** transcript+cards are in-memory only; a refresh or accidental
  Stop loses everything; summary is modal-only, no export.
- **Proposal:** persist meeting state (the `types.ts:269-313` transcript
  Valkey seam already exists) + copy/markdown/download for transcript and
  summary; multi-person summaries in one pass (today single-person, re-ask
  identity every time, `page.tsx:296-322`).

### A2.6 — Speechmatics reconnection resilience · M · ★★
- **Evidence:** no reconnection anywhere; a websocket drop ends the meeting,
  manual restart, in-flight audio lost (`useSpeechmatics.ts`).
- **Proposal:** N reconnects with backoff, `"reconnecting"` status on the
  dot/banner, buffer audio across the gap.
- **Impact:** survivability for a real 30-minute meeting, not just a 90s demo.

### A2.7 — Speaker → person identity resolution · M · ★★
- **Evidence:** `S1/S2` mapped to "Speaker N" with no resolution against
  `people.json` (`useSpeechmatics.ts:72-74`); Layer 2 even drops `speakerId`
  from its prompt (`entity-resolver.ts:63`).
- **Proposal:** a speaker-label→attendee resolver (seeded from prewarm
  attendees) so every downstream consumer (cards, summary, curator) knows
  *who said it* — central to "decisions affecting **you**".

## A3. Reasoning quality — beyond demo overfit (★★★)

### A3.1 — Semantic retrieval (embeddings) replacing lexical · M · ★★★
- **Evidence:** `retrieveRelevant` is pure substring matching with
  false-positive hits ("auth" matches "author"); the "no hit → all active
  facts" + "no domain → all 5 specialists" combo means a *vague* utterance
  triggers the *maximum* 5-call fan-out on noise (`memory.ts:63`,
  `gemini.ts:200`).
- **Proposal:** precompute embeddings for the (tiny) fact set + learned facts,
  embed `contextText`, cosine top-k, hybrid with lexical for exact-match
  precision.
- **Impact:** removes the dominant recall failure and the *reason the
  scenario-hardcoded fallback exists*. Also cuts worst-case quota burn.

### A3.2 — Retire/generalize the hardcoded fallback · M · ★★
- **Evidence:** `fallbackCollisionResult` is four literal scenario regexes
  with literal headlines (`gemini.ts:52-143`) and runs on *every* empty live
  result (`gemini.ts:236`), masking the real ~20% paraphrase miss rate the
  code itself admits (`gemini.ts:233`).
- **Proposal:** keep a deterministic detector for true Gemini *outage* only;
  drive it generically from the memory graph (entity + status + verb-class),
  not four hardcoded scenarios; stop running it as a silent net on every miss
  (it hides the true model performance you need to measure).

### A3.3 — Harden the verifier beyond bag-of-words · M · ★★★
- **Evidence:** `verifier.ts:30-37` is unordered token-set overlap. A
  *negation-inverted* quote ("DPA *is* approved, proceed") shares ≥60% tokens
  with "Do not proceed until the DPA is approved" → passes **and is rewritten
  to authoritative canonical text** — worse than no check. Empty-evidence
  cards pass unchanged (`verifier.ts:66-70`); `headline`/`reason`/
  `suggestedNextStep` are never grounded.
- **Proposal:** (a) reject empty-evidence cards (make `evidence` required &
  non-empty); (b) add polarity/negation detection + sequence-aware overlap
  (token-bigram Jaccard or normalized Levenshtein) so shuffled/negated quotes
  fail; (c) cheap entailment check that the `headline` is supported by the
  grounded evidence.
- **Impact:** closes the only hallucination gate's worst failure mode —
  inverting a fact while wearing a verbatim quote is the most dangerous
  possible output for this product.

### A3.4 — Surface >2 collisions instead of silent drop · S · ★
- **Evidence:** `dedupeRankCap` caps at 2 (`gemini.ts:228`); a genuine 3-way
  collision silently loses the lowest severity with no signal.
- **Proposal:** show "+N more" with expand, or raise the cap with grouping.

---

# PART B — Software & code-architecture improvements

## B1. The hot path

### B1.1 — Make collision streaming / early-return · M · ★★
- **Evidence:** the route blocks on `Promise.all` of all specialists
  (`gemini.ts:202`) then a synchronous verifier; the slowest judge sets the
  latency for everyone.
- **Proposal:** SSE/stream — emit each verified card as its specialist
  resolves (verifier is synchronous, so partials are safe). High-severity
  cards appear without waiting for the slowest domain.
- **Impact:** latency *is* the product (IDEA.md). This converts p99 from
  "slowest specialist" to "first relevant specialist".

### B1.2 — Collapse fan-out or cap concurrency · S · ★
- **Evidence:** with no domain prefilter hit, all 5 specialists fire (5×
  quota + rate-limit exposure) on essentially noise; prompts are
  pretty-printed JSON wasting tokens (`specialists.ts:200`,
  `memory-curator.ts:130`).
- **Proposal:** single batched specialist call with domain-tagged output
  (at ≤8 facts the parallelism benefit is marginal), or aggressively skip
  domains by retrieved-fact presence; compact the JSON (drop `null, 2`).

### B1.3 — Durable curator instead of fire-and-forget · M · ★★
- **Evidence:** `curateMemory` is a fire-and-forget promise
  (`collision/route.ts:41-50`) dependent on a long-lived process — lossy under
  `maxDuration` / serverless / restarts, defeating "the graph gets smarter
  across meetings".
- **Proposal:** enqueue curation as a real job (reuse the BullMQ seam) rather
  than a detached promise.

## B2. Reliability & resilience

### B2.1 — AI gateway: timeout, jitter, escalating cooldown · M · ★★
- **Evidence:** `generateContent` (`ai-gateway.ts:172`) has **no
  AbortController/timeout** — a hung Gemini socket hangs the request to the
  SDK default; fixed 60s cooldown, no jitter → synchronized re-bench storms
  under sustained 429s; `failures` counter incremented but never used.
- **Proposal:** per-call timeout (AbortController), one same-key retry on
  transient blip before benching, exponential cooldown with jitter, eject a
  key after N consecutive failures, expose `gatewayStatus()` on an endpoint
  for observability.

### B2.2 — Queue/worker idempotency · M · ★★★ (correctness, money)
- **Evidence:** `hashText` is a 32-bit DJB hash (`queue.ts:59-65`) →
  collisions silently drop distinct utterances; the worker is non-idempotent —
  `attempts:2` after a partial failure re-runs `dispatchActionsToNotion` +
  `appendServiceActions` (`worker/index.ts:47-59`) → **duplicate live Notion
  tasks**; snapshot writes are non-atomic with persistence → stuck-"active"
  snapshots.
- **Proposal:** SHA-256 (base36-truncated) jobId; Notion creation
  idempotency key; skip dispatch/append if the jobId's snapshot already
  "completed"; derive the snapshot from BullMQ job state or write it
  atomically (MULTI/Lua).
- **Impact:** prevents real, user-visible duplicate external writes — the
  highest-severity correctness bug in the backend.

### B2.3 — State model: kill or fix the JSON fallback · M · ★★
- **Evidence:** the JSON path does lock-free read-modify-write
  (`work-context.ts:94-97`) — loses concurrent writes even single-process;
  writes into `src/data/*.runtime.json` inside the code tree, not shared
  across the app/worker containers (no shared volume) → **broken in any
  containerized multi-process deployment**; only Valkey is correct there.
- **Proposal:** in any multi-process target require Valkey (fail fast if
  absent); if the fallback stays for local dev, relocate it out of `src/` to a
  writable shared volume + file lock, and surface a clear "non-durable" signal
  in `/api/deployment`.

### B2.4 — Valkey client robustness · S · ★
- **Evidence:** single shared connection, `maxRetriesPerRequest:null`
  (`valkey.ts:22`) → commands queue indefinitely if Valkey is unreachable,
  hanging requests instead of failing fast.
- **Proposal:** bounded retries + a fast-fail path; consider a small pool;
  collapse non-atomic `set`+`expire` into `SET … EX` everywhere
  (`scheduler.ts:120-121`, `hot-loader.ts:94-95`).

## B3. Security posture (no auth exists anywhere)

### B3.1 — Authenticate & rate-limit the API surface · M · ★★★
- **Evidence:** `/api/speechmatics-token` is open and mints unlimited
  Speechmatics RT JWTs (`speechmatics-token/route.ts:13`) → direct
  quota/cost-abuse vector; `/api/service-actions` (drives Gemini spend + live
  Notion writes), `/api/work-context/reset` (wipes state),
  `/api/prewarm/trigger` (`force` re-warms everything) are all unauthenticated
  and unthrottled.
- **Proposal:** session/origin check + rate limit on token minting (highest
  ROI); shared-secret/auth on all mutating routes; auth + force-debounce on
  `prewarm/trigger`.

### B3.2 — Edge→origin trust boundary · M · ★★
- **Evidence:** Vultr LBs are public; `X-WG-Country`/`X-WG-*` are set by the
  Cloudflare worker (`worker.mjs:69-86`) but the origin accepts them from
  anyone reaching the LB directly → residency headers are trivially forgeable;
  `classifyRequest` only *observes*, never blocks (`deployment/route.ts:8-33`)
  — an EU user on the US instance is still served and stored in US.
- **Proposal:** Cloudflare-only ingress (IP allowlist or shared header
  secret/mTLS) on the Vultr LBs; strip inbound `X-WG-*` at the edge before
  re-setting; optionally *enforce* (redirect/refuse) on hard residency
  violation, not just report. Frame honestly: still "auditable architecture",
  not a blanket compliance claim.

### B3.3 — Stop leaking upstream errors · S · ★★
- **Evidence:** `/api/speechmatics-token` 502 returns `error: err.message`
  (`speechmatics-token/route.ts:48-49`), inconsistent with the otherwise-good
  `aiErrorResponse` discipline; same class as A2.4.
- **Proposal:** route every endpoint's errors through `api-error.ts`.

## B4. Codebase structure & DevEx

### B4.1 — Decompose the `page.tsx` monolith · M · ★★
- **Evidence:** 1042-line single client component, 13 `useState` + 3 refs, 6
  sub-components + lookup maps in one file (`page.tsx:97-120`); every
  partial/utterance re-renders the entire tree incl. hidden Actions view &
  modal; transcript list unvirtualized and grows unbounded.
- **Proposal:** split into `components/` (`TopBar`, `LiveView`,
  `TranscriptColumn`, `CollisionsColumn`, `CollisionCard`, `ActionCenter`,
  `SummaryModal`) + `lib/labels.ts`; small store (Context+reducer or Zustand)
  for meeting state; `React.memo` rows; virtualize the transcript; isolate
  `partial` into a leaf so sub-second updates don't re-render the page;
  extract `useJobPolling` with max-attempts/timeout (today polls forever,
  `page.tsx:225-253`).
- **Impact:** core maintainability debt; also fixes a real perf cliff in long
  meetings.

### B4.2 — Accessibility & resilience polish · S · ★
- **Evidence:** modal has `role=dialog` but no focus trap / Esc / focus
  restore / `aria-labelledby` (`page.tsx:853`); no `aria-live` for new cards
  or Speechmatics errors; no `prefers-reduced-motion` guard (perpetual
  `breathe` pulse, `globals.css:86-98`); no Error Boundary anywhere (a render
  throw blanks the meeting).
- **Proposal:** focus management + `aria-live` (assertive for new collision
  cards / errors) + reduced-motion block + a page-level Error Boundary.

### B4.3 — Test/CI hardening · M · ★★ (see also §3)
- **Evidence:** no CI; gate commands `tail`-masked; outage-sim tests
  flaky-by-construction (unhandled rejections); contract duplicated across
  unit + e2e with no shared fixture; `useSpeechmatics`/components/worker/queue
  untested; stale committed `coverage/`.
- **Proposal:** CI (typecheck+lint+test+build), coverage thresholds, shared
  typed fixtures for API contracts, jsdom+RTL for the hook/components, smoke
  tests for `worker/index.ts` & `queue.ts`, pre-commit running the gates,
  add `.nvmrc`, remove the stale "clean / 141 pass" status line
  (`docs/AGENTS.md:161`).

---

## 4. Sequenced roadmap

### Phase 0 — Make it green & honest (days, do first)
§3 entirely: fix 6 type errors + 7 test failures, add CI, commit the
in-flight subsystems behind green gates. **Gate: CI green on `main`.**

### Phase 1 — Activate what's already built (week 1)
A1.1 hot facts · A1.2 ASR vocab · A1.3 entity-resolve sidecar · A2.1 demo mode
· A2.2 analyzing/visible-failure · A2.4/B3.3 error sanitization.
**Gate: prewarm + transcript subsystems consumed end-to-end (integration
tests prove it); mic-free demo runnable.**

### Phase 2 — Reasoning quality & hot-path latency (week 2–3)
A3.1 semantic retrieval · A3.3 verifier hardening · A3.2 fallback
generalization · B1.1 streaming · B1.2 fan-out · B1.3 durable curator ·
A1.4 schedulers.
**Gate: measured collision precision/recall on a labeled set replaces
fallback masking; p99 hot-path latency tracked.**

### Phase 3 — Backend correctness & security (week 3–4)
B2.2 idempotency · B2.3 state model · B2.1 gateway hardening ·
B3.1 auth/rate-limit · B3.2 edge trust.
**Gate: no duplicate Notion writes under retry; no unauthenticated mutating
route; token endpoint rate-limited.**

### Phase 4 — Product depth & maintainability (week 4+)
A2.3 card lifecycle · A2.5 persistence/export · A2.6 reconnection ·
A2.7 speaker identity · B4.1 frontend decomposition · B4.2 a11y · B4.3 test
depth.

Dependency notes: A3.1 (semantic retrieval) is what makes A3.2 (kill the
hardcoded fallback) safe. A1.1/A1.2 unlock measuring A3 honestly. B2.2 is
independent and high-severity — can be pulled forward if Notion is used live.

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Demo fails (no mic/Speechmatics on the day) | High | Critical | A2.1 mic-free replay mode — Phase 1 |
| Verifier passes a negation-inverted "verbatim" quote | Medium | Critical (anti-thesis) | A3.3 polarity + sequence check |
| Duplicate live Notion tasks on worker retry | Medium | High | B2.2 idempotency |
| Speechmatics JWT endpoint abused for cost | Medium | High | B3.1 rate-limit |
| JSON fallback silently drops state in prod | High (if no Valkey) | High | B2.3 require Valkey multi-process / fail fast |
| Wiring dead subsystems regresses latency | Low | Medium | hot-facts has `?? cold` fallback; 500ms cap on Layer 2; integration tests in Phase 1 gate |
| Removing hardcoded fallback drops demo recall | Medium | Medium | Do A3.1 first; keep outage-only deterministic detector |

---

## 6. Success metrics

- **Gate health:** CI green; typecheck 0 errors; 0 flaky tests; coverage
  threshold enforced (currently ~98% lines but red).
- **Subsystem activation:** prewarm hot-facts hit-rate >0 on live meetings;
  `additional_vocab` present in the Speechmatics config (asserted in e2e);
  Layer-2 resolve invoked per utterance within its 500ms budget.
- **Reasoning:** labeled-set collision precision/recall measured *without* the
  scenario fallback masking it; paraphrase miss rate (today self-admitted
  ~20%, `gemini.ts:233`) tracked and trending down; zero negation-inversion
  escapes in an adversarial quote test set.
- **Latency:** p50/p99 from utterance-final → first verified card (target: p99
  ≤ slowest single specialist via streaming, not the `Promise.all` ceiling).
- **Correctness:** zero duplicate Notion writes under induced worker retry;
  zero unauthenticated mutating routes; zero raw-provider-error strings
  reaching any client response.
- **Product:** full collision→summary story runnable with no microphone.

---

## 7. The one-paragraph version

Three subsystems you already built and tested are switched off — turn them on
(`hotFactsFor` into `gemini.ts`, `additionalVocab` into `useSpeechmatics.ts`,
`/api/transcript/resolve` into `onUtterance`); that alone is the highest-ROI
work in the codebase. First make the gates green and add CI, because they are
currently red and nothing enforces them. Then stop the product from being
demo-overfit: replace lexical retrieval with embeddings so you can retire the
four hardcoded scenario regexes and *measure* real accuracy, and harden the
verifier so it can't pass a negation-inverted fact wearing a verbatim quote.
Add a mic-free demo mode (your biggest live-failure risk), make AI failure
visible (a silent safety net isn't one), and add authentication/rate-limiting
and worker idempotency before this touches a real meeting or a real Notion
workspace.
