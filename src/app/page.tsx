"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechmatics } from "@/hooks/useSpeechmatics";
import seed from "@/data/memory.json";
import peopleSeed from "@/data/people.json";
import type {
  CollisionCard,
  MemoryFact,
  Person,
  PersonalSummary,
  Utterance,
} from "@/lib/types";

const SEV_VAR: Record<string, string> = {
  high: "var(--high)",
  medium: "var(--medium)",
  low: "var(--low)",
};

const CHIP_C: Record<string, string> = {
  legal_blocker: "var(--high)",
  engineering_blocker: "var(--medium)",
  decision: "var(--low)",
  person_capacity: "var(--high)",
  commitment: "var(--calm)",
  dependency: "var(--medium)",
};

function chipLabel(f: MemoryFact): string {
  switch (f.type) {
    case "legal_blocker":
      return `LEGAL · ${f.entity}`;
    case "engineering_blocker":
      return `ENG · ${f.entity}`;
    case "decision":
      return `DECIDED · ${f.entity}`;
    case "person_capacity":
      return `${f.entity} · ${f.activeP0s?.length ?? 0} P0`;
    case "commitment":
      return `CUSTOMER · ${f.entity}`;
    case "dependency":
      return `DEP · ${f.entity}`;
    default:
      return f.entity;
  }
}

const CTYPE_LABEL: Record<string, string> = {
  legal_compliance: "Legal / Compliance",
  previous_decision: "Already Decided",
  priority_capacity: "Priority / Capacity",
  dependency_blocker: "Dependency / Blocker",
  customer_promise: "Customer Promise",
};

type ModalStep = "picker" | "loading" | "result" | "error";

export default function Page() {
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [cards, setCards] = useState<CollisionCard[]>([]);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<{ speaker: string; text: string }[]>([]);

  // ── post-meeting summary modal state ─────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStep, setModalStep] = useState<ModalStep>("picker");
  const [summary, setSummary] = useState<PersonalSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const facts = seed.facts as MemoryFact[];
  const people = peopleSeed.people as Person[];

  const analyze = useCallback(async (u: Utterance) => {
    const recent = histRef.current.slice(-6);
    histRef.current.push({ speaker: u.speaker, text: u.text });
    try {
      const res = await fetch("/api/collision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          speaker: u.speaker,
          text: u.text,
          recentTranscript: recent,
        }),
      });
      const data = await res.json();
      if (data.collisionDetected && data.cards?.length) {
        setCards((prev) => [...data.cards, ...prev]);
        setFlagged((prev) => new Set(prev).add(u.id));
      }
    } catch {
      /* keep the meeting flowing even if the engine hiccups */
    }
  }, []);

  const onUtterance = useCallback(
    (u: Utterance) => {
      setUtterances((prev) => [...prev, u]);
      void analyze(u);
    },
    [analyze],
  );

  const { status, partial, error, start, stop } = useSpeechmatics(onUtterance);
  const listening = status === "listening" || status === "connecting";

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [utterances, partial]);

  // ── lifecycle: when Stop is pressed and there's content, open modal ──
  const handleStop = useCallback(() => {
    stop();
    if (utterances.length > 0) {
      setModalStep("picker");
      setSummary(null);
      setSummaryError(null);
      setModalOpen(true);
    }
  }, [stop, utterances.length]);

  // Manual re-open (e.g. user closed the modal and wants it back)
  const reopenSummary = useCallback(() => {
    if (utterances.length === 0) return;
    setModalStep(summary ? "result" : "picker");
    setSummaryError(null);
    setModalOpen(true);
  }, [utterances.length, summary]);

  const pickPerson = useCallback(
    async (person: Person) => {
      setModalStep("loading");
      setSummaryError(null);
      try {
        const res = await fetch("/api/personal-summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            personId: person.id,
            utterances,
            cards,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "summary engine error");
        setSummary(data.summary as PersonalSummary);
        setModalStep("result");
      } catch (err) {
        setSummaryError(
          err instanceof Error ? err.message : "could not build summary",
        );
        setModalStep("error");
      }
    },
    [utterances, cards],
  );

  const meetingHasContent = utterances.length > 0;
  const showReopen = !modalOpen && !listening && meetingHasContent;

  return (
    <div className="shell" data-alert={cards.length > 0}>
      <header className="topbar">
        <div className="brand">
          <span className="mark">
            Live <em>Context</em> Collision
          </span>
          <span className="sub">Decision Safety Layer</span>
        </div>

        <button
          className="mic-btn"
          data-on={listening}
          onClick={() => (listening ? handleStop() : start())}
        >
          {status === "connecting"
            ? "Connecting…"
            : listening
              ? "■ Stop meeting"
              : "● Start meeting"}
        </button>

        {showReopen && (
          <button className="modal-close" onClick={reopenSummary}>
            ▸ Open summary
          </button>
        )}

        <div className="status">
          <span className="dot" data-s={status} />
          {status === "idle" && "standby"}
          {status === "connecting" && "linking speechmatics"}
          {status === "listening" && "listening · live"}
          {status === "error" && "error"}
        </div>

        <div className="chips">
          {facts.map((f) => (
            <span
              key={f.id}
              className="chip"
              style={{ ["--chip-c" as string]: CHIP_C[f.type] }}
              title={f.statement}
            >
              <b>{chipLabel(f)}</b>
            </span>
          ))}
        </div>
      </header>

      {error && <div className="banner">SPEECHMATICS: {error}</div>}

      <main className="main">
        <section className="col">
          <div className="col-head">
            <span>Live Meeting Transcript</span>
            <span className="count">{utterances.length} utterances</span>
          </div>
          <div className="transcript" ref={transcriptRef}>
            {utterances.length === 0 && !partial && (
              <div className="empty">
                Press <b>Start meeting</b> and speak.
                <br />
                Transcription streams here; collisions surface on the right
                <br />
                the moment a statement contradicts company memory.
              </div>
            )}
            {utterances.map((u) => (
              <div key={u.id} className="utt" data-flag={flagged.has(u.id)}>
                <div className="who">{u.speaker}</div>
                <div className="said">{u.text}</div>
              </div>
            ))}
            {partial && <div className="partial">{partial}</div>}
          </div>
        </section>

        <section className="col">
          <div className="col-head">
            <span>Context Collisions</span>
            <span className="count">
              {cards.length > 0 ? `${cards.length} flagged` : "monitoring"}
            </span>
          </div>
          <div className="cards" ref={cardsRef}>
            {cards.length === 0 ? (
              <div className="allclear">
                <div className="ring">✓</div>
                <span>No collisions · context aligned</span>
              </div>
            ) : (
              cards.map((c) => (
                <article
                  key={c.id}
                  className="card"
                  style={{ ["--sev" as string]: SEV_VAR[c.severity] }}
                >
                  <div className="ctype">
                    <span className="badge">
                      {CTYPE_LABEL[c.collisionType] ?? c.collisionType}
                    </span>
                    <span className="sev-tag">{c.severity} severity</span>
                  </div>
                  <h2 className="title">{c.title}</h2>
                  <p className="headline">{c.headline}</p>

                  {c.evidence.map((e, i) => (
                    <div className="evi" key={i}>
                      <div className="src">{e.source}</div>
                      <div className="quote">“{e.quote}”</div>
                    </div>
                  ))}

                  {c.reason && (
                    <div className="row">
                      <span className="k">Reason</span>
                      <span className="v">{c.reason}</span>
                    </div>
                  )}
                  {c.suggestedNextStep && (
                    <div className="row next">
                      <span className="k">Next</span>
                      <span className="v">{c.suggestedNextStep}</span>
                    </div>
                  )}

                  <div className="footer">
                    Triggered by <b>{c.triggeredBy.speaker}</b>: “
                    {c.triggeredBy.text}”
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>

      {modalOpen && (
        <SummaryModal
          step={modalStep}
          people={people}
          summary={summary}
          error={summaryError}
          onPick={pickPerson}
          onClose={() => setModalOpen(false)}
          onBack={() => {
            setModalStep("picker");
            setSummary(null);
            setSummaryError(null);
          }}
          utteranceCount={utterances.length}
          cardCount={cards.length}
        />
      )}
    </div>
  );
}

// ─────────────────────────── modal ───────────────────────────────────

interface SummaryModalProps {
  step: ModalStep;
  people: Person[];
  summary: PersonalSummary | null;
  error: string | null;
  onPick: (p: Person) => void;
  onClose: () => void;
  onBack: () => void;
  utteranceCount: number;
  cardCount: number;
}

function SummaryModal(props: SummaryModalProps) {
  const {
    step,
    people,
    summary,
    error,
    onPick,
    onClose,
    onBack,
    utteranceCount,
    cardCount,
  } = props;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <div>
            <div className="h-eyebrow">
              {step === "result" && summary
                ? `Your view · ${summary.person.name}`
                : "Meeting ended"}
            </div>
            <div className="h-title">
              {step === "result" && summary
                ? "Here's your meeting, in 30 seconds"
                : step === "loading"
                  ? "Building your view"
                  : step === "error"
                    ? "Couldn't build the summary"
                    : "Who are you?"}
            </div>
            <div className="h-sub">
              {step === "picker" &&
                `${utteranceCount} utterances · ${cardCount} collisions flagged. Pick the participant whose personal view you want to read.`}
              {step === "loading" &&
                "Reading the transcript, the collision log, and the memory facts that pertain to you."}
              {step === "error" &&
                "The summary engine could not return a result. You can try again or pick someone else."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {step === "result" && (
              <button className="modal-close" onClick={onBack}>
                ← Pick again
              </button>
            )}
            <button className="modal-close" onClick={onClose}>
              ✕ Close
            </button>
          </div>
        </div>

        <div className="modal-body">
          {step === "picker" && (
            <div className="people-grid">
              {people.map((p) => (
                <button
                  key={p.id}
                  className="person-card"
                  onClick={() => onPick(p)}
                >
                  <span className="p-name">{p.name}</span>
                  <span className="p-role">{p.role}</span>
                  <span className="p-team">{p.team}</span>
                </button>
              ))}
            </div>
          )}

          {step === "loading" && (
            <div className="summary-loading">
              <div className="spinner" />
              <div className="msg">Composing your view…</div>
            </div>
          )}

          {step === "error" && (
            <div>
              <div className="banner" style={{ margin: "0 0 18px" }}>
                {error ?? "unknown error"}
              </div>
              <button className="modal-close" onClick={onBack}>
                ← Try another person
              </button>
            </div>
          )}

          {step === "result" && summary && <SummaryBody summary={summary} />}
        </div>
      </div>
    </div>
  );
}

function SummaryBody({ summary }: { summary: PersonalSummary }) {
  return (
    <>
      {summary.bottomLine && (
        <div className="summary-bottomline">
          <div className="label">Bottom line · {summary.person.name}</div>
          <div className="line">{summary.bottomLine}</div>
        </div>
      )}

      <Section
        title="Your action items"
        count={summary.actionItems.length}
        emptyText="Nothing landed on your plate."
      >
        {summary.actionItems.map((a, i) => (
          <div className="s-item" key={i}>
            <div className="primary">{a.item}</div>
            {a.dueHint && <span className="due">{a.dueHint}</span>}
            {a.basedOn && <div className="based">“{a.basedOn}”</div>}
          </div>
        ))}
      </Section>

      <Section
        title="Decisions affecting you"
        count={summary.decisionsAffectingYou.length}
        emptyText="No decisions made that touch your scope."
      >
        {summary.decisionsAffectingYou.map((d, i) => (
          <div className="s-item" key={i}>
            <div className="primary">{d.decision}</div>
            <div className="meta">{d.whyItMattersToYou}</div>
            {d.driver && (
              <div className="meta" style={{ marginTop: 4 }}>
                <span style={{ opacity: 0.6 }}>Driven by · </span>
                {d.driver}
              </div>
            )}
          </div>
        ))}
      </Section>

      <Section
        title="Flags raised about you"
        count={summary.flagsRaised.length}
        emptyText="No collisions involved you this meeting."
        alert={summary.flagsRaised.length > 0}
      >
        {summary.flagsRaised.map((f, i) => (
          <div
            className="s-item flag"
            key={i}
            style={{ ["--sev" as string]: SEV_VAR[f.severity] }}
          >
            <div className="flag-head">
              <span className="flag-badge">
                {CTYPE_LABEL[f.collisionType] ?? f.collisionType}
              </span>
              <span className="flag-sev">{f.severity} severity</span>
            </div>
            <div className="primary">{f.headline}</div>
            <div className="meta">{f.relevance}</div>
          </div>
        ))}
      </Section>

      <Section
        title="Open questions for you"
        count={summary.openQuestions.length}
        emptyText="Nothing left dangling that points at you."
      >
        {summary.openQuestions.map((q, i) => (
          <div className="s-item" key={i}>
            <div className="primary">{q.question}</div>
            <div className="meta">{q.whyYou}</div>
          </div>
        ))}
      </Section>
    </>
  );
}

function Section({
  title,
  count,
  emptyText,
  alert,
  children,
}: {
  title: string;
  count: number;
  emptyText: string;
  alert?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`summary-section${alert ? " alert" : ""}`}>
      <div className="s-head">
        <span className="s-title">{title}</span>
        <span className="s-count">
          {count > 0 ? `${count} item${count === 1 ? "" : "s"}` : "empty"}
        </span>
      </div>
      {count > 0 ? children : <div className="summary-empty">{emptyText}</div>}
    </section>
  );
}
