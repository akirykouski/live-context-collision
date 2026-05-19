// Pre-Warmer internal types.
//
// The wire contract (Valkey key shapes) lives in "@/lib/types"
// (prewarmKeys, MemoryFact, AdditionalVocabEntry) and MUST NOT be redefined
// here. These types are the prewarmer's *internal* working shapes: candidate
// facts flowing through the source fan-out and ranker before they are mapped
// down to the on-the-wire MemoryFact[] the collision specialists consume.

/** Where a candidate fact came from. Drives source_prior in the ranker. */
export type PrewarmSource =
  | "graph"
  | "github"
  | "jira"
  | "notion"
  | "slack"
  | "calendar";

/**
 * The uniform shape every source returns. The ranker does not care where a
 * fact came from — only `source` (for the prior) and the scoring inputs.
 */
export interface CandidateFact {
  id: string;
  source: PrewarmSource;
  /** Graph node references / entity surface forms this fact is about. */
  entityIds: string[];
  /** Human-readable text — becomes the MemoryFact.statement on hot-load. */
  text: string;
  /** Epoch ms the underlying artifact was last touched. */
  timestamp: number;
  /** Original source payload, kept for citation / audit. */
  raw: unknown;
  /** Attendee ids/emails who touched this artifact (overlap scoring). */
  touchedBy?: string[];
  /**
   * For graph-sourced candidates: the already-formed MemoryFact so the
   * hot-loader can pass it through unchanged (it is the canonical shape).
   */
  memoryFact?: import("@/lib/types").MemoryFact;
}

/** A scored candidate. score is carried ONLY inside the ranker output. */
export type RankedFact = CandidateFact & { score: number };

/** One attendee of an upcoming meeting. */
export interface MeetingAttendee {
  /** Person id from people.json when known, else the raw email. */
  id: string;
  email?: string;
  name?: string;
}

/** A meeting the scheduler may prewarm. Sourced from meetings.json (fixture). */
export interface UpcomingMeeting {
  id: string;
  title: string;
  /** Epoch ms. */
  startMs: number;
  /** Epoch ms. */
  endMs: number;
  organizer: string;
  attendees: MeetingAttendee[];
  /** Free-form agenda text (joined description + agenda doc, parsed upstream). */
  agenda?: string;
  agendaDocUrl?: string;
  location?: string;
}

/** Per-source result recorded in the manifest. */
export interface SourceReport {
  name: PrewarmSource;
  latencyMs: number;
  count: number;
  error?: string;
}

/** The auditable per-job manifest written to prewarmKeys.manifest(id). */
export interface PrewarmManifest {
  meetingId: string;
  region: string;
  organizer: string;
  sources: SourceReport[];
  ranker: {
    inputCount: number;
    outputCount: number;
    scoreMin: number;
    scoreMax: number;
  };
  hot: { ok: boolean; ttlSec: number; bytes: number };
  createdAt: number;
}

/** Outcome of one prewarm job (returned by the trigger route). */
export interface PrewarmJobResult {
  meetingId: string;
  prewarmed: boolean;
  /** Set when the job was skipped (already done / not eligible / refused). */
  skippedReason?: string;
  manifest?: PrewarmManifest;
}

/** A source adapter: pure async, never throws past its own boundary here —
 *  the scheduler still wraps it in a timeout + circuit breaker. */
export interface PrewarmSourceAdapter {
  name: PrewarmSource;
  fetch(meeting: UpcomingMeeting): Promise<CandidateFact[]>;
}
