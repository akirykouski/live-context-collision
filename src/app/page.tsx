"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechmatics } from "@/hooks/useSpeechmatics";
import seed from "@/data/memory.json";
import type { CollisionCard, MemoryFact, Utterance } from "@/lib/types";

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

export default function Page() {
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [cards, setCards] = useState<CollisionCard[]>([]);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<{ speaker: string; text: string }[]>([]);

  const facts = seed.facts as MemoryFact[];

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
          onClick={() => (listening ? stop() : start())}
        >
          {status === "connecting"
            ? "Connecting…"
            : listening
              ? "■ Stop meeting"
              : "● Start meeting"}
        </button>

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
              <div
                key={u.id}
                className="utt"
                data-flag={flagged.has(u.id)}
              >
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
    </div>
  );
}
