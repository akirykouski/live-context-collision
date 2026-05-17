// Shared types for the Live Context Collision engine.

export type CollisionType =
  | "legal_compliance"
  | "previous_decision"
  | "priority_capacity"
  | "dependency_blocker"
  | "customer_promise";

export type Severity = "high" | "medium" | "low";

/**
 * A single fact in the company memory graph. Kept deliberately loose: the demo
 * value is in the relationships the LLM reasons over, not a rigid schema.
 */
export interface MemoryFact {
  id: string;
  type:
    | "legal_blocker"
    | "engineering_blocker"
    | "decision"
    | "person_capacity"
    | "commitment"
    | "dependency";
  /** Primary entity this fact is about (feature, project, person, customer). */
  entity: string;
  /** Free-form related entities so retrieval can match loosely. */
  related?: string[];
  status?: "active" | "resolved" | "expired";
  source: string;
  /** The substance of the fact, phrased so it can be quoted in a card. */
  statement: string;
  reason?: string;
  severity?: Severity;
  /** For person_capacity facts. */
  activeP0s?: string[];
  /** A rule the org enforces, surfaced verbatim in the card. */
  rule?: string;
}

/** What the meeting was streamed: a finalized utterance from one speaker. */
export interface Utterance {
  id: string;
  speaker: string;
  text: string;
  at: number; // epoch ms
}

/** The evidence-backed card the UI renders when a collision is detected. */
export interface CollisionCard {
  id: string;
  collisionType: CollisionType;
  /** Card heading, e.g. "Context collision detected". */
  title: string;
  /** One-line statement of the conflict. */
  headline: string;
  /** Quoted evidence lines pulled from memory, in render order. */
  evidence: { source: string; quote: string }[];
  reason?: string;
  suggestedNextStep?: string;
  severity: Severity;
  /** Which memory fact ids backed this card (for the audit trail). */
  factIds: string[];
  /** The utterance that triggered detection. */
  triggeredBy: { speaker: string; text: string };
}

/** Engine response for one analyzed utterance. */
export interface CollisionResult {
  collisionDetected: boolean;
  cards: CollisionCard[];
}
