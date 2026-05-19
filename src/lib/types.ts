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

// ─────────────────────────── personal summary ──────────────────────────

/**
 * A named person on the team. After the meeting ends, the user picks one of
 * these to generate a personal post-meeting summary written from that
 * perspective.
 */
export interface Person {
  id: string;
  name: string;
  role: string;
  team: string;
  /** Memory fact ids this person personally owns or is closely tied to. */
  ownedFactIds: string[];
  /** First-person framing of what this person cares about — fed to the LLM
   * so the summary is genuinely personal, not a generic recap. */
  perspective: string;
}

/** A concrete thing this person committed to, was assigned, or now owns. */
export interface PersonalActionItem {
  /** The action, phrased in second person ("Confirm with Legal that…"). */
  item: string;
  /** Loose due hint ("by Friday", "before next sync"). Empty if unspecified. */
  dueHint?: string;
  /** Verbatim excerpt from the meeting that established this item. */
  basedOn: string;
}

/** A decision the meeting reached that touches this person's scope. */
export interface PersonalDecision {
  /** What was decided, in plain English. */
  decision: string;
  /** Why it matters to *this* person specifically. */
  whyItMattersToYou: string;
  /** Speaker who drove the decision, if identifiable. */
  driver?: string;
}

/** A collision card from the meeting that involved this person. */
export interface PersonalFlag {
  collisionType: CollisionType;
  headline: string;
  severity: Severity;
  /** Why this flag is relevant to this person (owner, blocker, etc.). */
  relevance: string;
}

/** A question raised in the meeting that was never resolved. */
export interface PersonalOpenQuestion {
  question: string;
  /** Why this person should be the one to pick it up. */
  whyYou: string;
}

/**
 * The structured personal post-meeting summary, written from one named
 * person's point of view. Shown in a modal after the user picks who they are.
 */
export interface PersonalSummary {
  person: { id: string; name: string; role: string };
  /** One sentence at the top: the most important takeaway for this person. */
  bottomLine: string;
  actionItems: PersonalActionItem[];
  decisionsAffectingYou: PersonalDecision[];
  flagsRaised: PersonalFlag[];
  openQuestions: PersonalOpenQuestion[];
}

/** Engine response for a personal summary request. */
export interface PersonalSummaryResult {
  summary: PersonalSummary;
}

// ───────────────────────── service agents / action center ────────────────

export type ServiceAgentKind = "github" | "jira_notion" | "gmail";

export type WorkArtifactKind =
  | "github_issue"
  | "jira_task"
  | "notion_task"
  | "email_thread"
  | "email_draft";

export type WorkPriority = "P0" | "P1" | "P2" | "P3";

export type ServiceActionType =
  | "create"
  | "update"
  | "reassign"
  | "change_priority"
  | "change_status"
  | "create_draft"
  | "append_note";

export interface WorkArtifact {
  id: string;
  kind: WorkArtifactKind;
  title: string;
  status?: string;
  priority?: WorkPriority;
  assignee?: string;
  customer?: string;
  source?: string;
  urlLabel?: string;
  body?: string;
  updatedAt?: string;
  metadata?: Record<string, string | number | boolean | string[]>;
}

export interface ServiceAction {
  id: string;
  agent: ServiceAgentKind;
  actionType: ServiceActionType;
  artifactKind: WorkArtifactKind;
  artifactId: string;
  title: string;
  rationale: string;
  basedOn: {
    speaker: string;
    text: string;
  };
  before?: WorkArtifact;
  after: WorkArtifact;
  status: "proposed" | "applied";
  createdAt: number;
}

export interface WorkContextResult {
  artifacts: WorkArtifact[];
  actions: ServiceAction[];
  queue?: ServiceQueueSummary;
}

export interface ServiceActionResult {
  actionDetected: boolean;
  actions: ServiceAction[];
  queued?: boolean;
  jobId?: string;
}

export type ServiceJobStatus = "queued" | "active" | "completed" | "failed";

export interface ServiceActionJobData {
  speaker: string;
  text: string;
  recentTranscript?: { speaker: string; text: string }[];
}

export interface ServiceJobSnapshot {
  id: string;
  status: ServiceJobStatus;
  actionIds: string[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceQueueSummary {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export interface DeploymentInfo {
  runtime: string;
  region: string;
  queue: string;
  loadBalancer: boolean;
  rawAudioStored: false;
  transcriptTtl: string;
  serverSideKeys: true;
  modules: string[];
  valkeyConfigured: boolean;
  timestamp: string;
}
