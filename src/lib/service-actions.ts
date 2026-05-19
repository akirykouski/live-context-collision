import { Type } from "@google/genai";
import { generateContent } from "./ai-gateway";
import type {
  ServiceAction,
  ServiceActionResult,
  ServiceActionType,
  ServiceAgentKind,
  WorkArtifact,
  WorkArtifactKind,
  WorkPriority,
} from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const AGENTS = ["github", "jira_notion", "gmail"] as const;
const ARTIFACT_KINDS = [
  "github_issue",
  "jira_task",
  "notion_task",
  "email_thread",
  "email_draft",
] as const;
const ACTION_TYPES = [
  "create",
  "update",
  "reassign",
  "change_priority",
  "change_status",
  "create_draft",
  "append_note",
] as const;
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

const SYSTEM_INSTRUCTION = `You are the WorkGraph Service Action router.

You are given:
1. The latest finalized utterance from a live meeting.
2. A small recent transcript window.
3. Existing dummy work artifacts from GitHub, Jira/Notion, and Gmail.
4. Already-applied service actions from this meeting.

Decide whether the latest utterance contains a CLEAR operational instruction
that one of the service agents should apply now.

Create actions only when the speaker explicitly decides, assigns, reprioritizes,
changes status, asks to create an issue/task, asks to update a task, or asks to
draft/send customer/team communication.

Do NOT create actions for casual discussion, questions, brainstorming, vague
intent, or statements that only describe context.

Agents:
- github: GitHub issues, engineering issues, PR/issue work.
- jira_notion: Jira tasks, Notion tasks, product/project status, priority,
  ownership, decision notes.
- gmail: customer/team email threads and draft emails.

Rules:
- Prefer updating an existing artifact when the instruction refers to one.
- Use the exact artifact id from the provided artifacts for updates.
- Use create_draft for email drafts.
- Use create for new GitHub issues or Jira/Notion tasks.
- For creates, artifactId may be empty; the server will generate one.
- Keep actionTitle short and demo-readable.
- rationale must explain why the action follows from the utterance.
- body should contain the new draft, issue/task description, or note content
  when relevant.
- Return no more than 3 actions for one utterance.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    actionDetected: { type: Type.BOOLEAN },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          agent: { type: Type.STRING, enum: [...AGENTS] },
          actionType: { type: Type.STRING, enum: [...ACTION_TYPES] },
          artifactKind: { type: Type.STRING, enum: [...ARTIFACT_KINDS] },
          artifactId: { type: Type.STRING },
          actionTitle: { type: Type.STRING },
          artifactTitle: { type: Type.STRING },
          rationale: { type: Type.STRING },
          assignee: { type: Type.STRING },
          priority: { type: Type.STRING, enum: [...PRIORITIES] },
          status: { type: Type.STRING },
          customer: { type: Type.STRING },
          body: { type: Type.STRING },
          source: { type: Type.STRING },
          urlLabel: { type: Type.STRING },
        },
        required: [
          "agent",
          "actionType",
          "artifactKind",
          "actionTitle",
          "rationale",
        ],
      },
    },
  },
  required: ["actionDetected", "actions"],
};

interface Candidate {
  agent?: string;
  actionType?: string;
  artifactKind?: string;
  artifactId?: string;
  actionTitle?: string;
  artifactTitle?: string;
  rationale?: string;
  assignee?: string;
  priority?: string;
  status?: string;
  customer?: string;
  body?: string;
  source?: string;
  urlLabel?: string;
}

export interface AnalyzeServiceActionArgs {
  speaker: string;
  text: string;
  recentTranscript?: { speaker: string; text: string }[];
  artifacts: WorkArtifact[];
  existingActions: ServiceAction[];
}

function artifactForPrompt(artifact: WorkArtifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    status: artifact.status,
    priority: artifact.priority,
    assignee: artifact.assignee,
    customer: artifact.customer,
    source: artifact.source,
    urlLabel: artifact.urlLabel,
    body: artifact.body,
    metadata: artifact.metadata,
  };
}

function actionForPrompt(action: ServiceAction) {
  return {
    agent: action.agent,
    actionType: action.actionType,
    artifactId: action.artifactId,
    title: action.title,
    after: {
      title: action.after.title,
      status: action.after.status,
      priority: action.after.priority,
      assignee: action.after.assignee,
      customer: action.after.customer,
    },
  };
}

function isOneOf<T extends readonly string[]>(
  value: string | undefined,
  options: T,
): value is T[number] {
  return !!value && (options as readonly string[]).includes(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeArtifactId(
  candidate: Candidate,
  actionIndex: number,
  existingIds: Set<string>,
): string {
  const base =
    slugify(
      candidate.artifactId ||
        candidate.artifactTitle ||
        candidate.actionTitle ||
        `service-action-${actionIndex}`,
    ) || `service-action-${actionIndex}`;
  const prefix =
    candidate.artifactKind === "email_draft"
      ? "draft"
      : candidate.artifactKind === "github_issue"
        ? "gh"
        : candidate.artifactKind === "jira_task"
          ? "jira"
          : candidate.artifactKind === "notion_task"
            ? "notion"
            : "artifact";

  let id = `${prefix}-${base}`;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${prefix}-${base}-${suffix}`;
    suffix += 1;
  }
  existingIds.add(id);
  return id;
}

function changedWithoutTimestamp(before: WorkArtifact, after: WorkArtifact) {
  const strip = (artifact: WorkArtifact) => {
    const { updatedAt: _updatedAt, ...rest } = artifact;
    return rest;
  };
  return JSON.stringify(strip(before)) !== JSON.stringify(strip(after));
}

function extractAssignee(text: string): string | undefined {
  const match = text.match(/\b(?:to|owner to|assign(?:ed)? to|reassign(?:ed)? to)\s+([A-Z][a-z]+)\b/);
  return match?.[1];
}

function extractPriority(text: string): WorkPriority | undefined {
  const priority = text.match(/\bP[0-3]\b/i)?.[0]?.toUpperCase();
  if (isOneOf(priority, PRIORITIES)) return priority as WorkPriority;
  if (/\b(high|urgent|highest|top priority)\b/i.test(text)) return "P0";
  if (/\bmedium\b/i.test(text)) return "P1";
  if (/\blow\b/i.test(text)) return "P3";
  return undefined;
}

function createFallbackAction(
  args: AnalyzeServiceActionArgs,
  action: {
    agent: ServiceAgentKind;
    actionType: ServiceActionType;
    artifactKind: WorkArtifactKind;
    title: string;
    rationale: string;
    before?: WorkArtifact;
    after: WorkArtifact;
  },
  index: number,
): ServiceAction {
  return {
    id: `svc-${Date.now()}-fallback-${index}`,
    agent: action.agent,
    actionType: action.actionType,
    artifactKind: action.artifactKind,
    artifactId: action.after.id,
    title: action.title,
    rationale: action.rationale,
    basedOn: { speaker: args.speaker, text: args.text },
    before: action.before,
    after: action.after,
    status: "applied",
    createdAt: Date.now(),
  };
}

function fallbackServiceActions(args: AnalyzeServiceActionArgs): ServiceActionResult {
  const text = args.text.trim();
  const lower = text.toLowerCase();
  const actions: ServiceAction[] = [];
  const nowIso = new Date().toISOString();
  const assignee = extractAssignee(text);
  const priority = extractPriority(text);

  if (
    /\b(github|gh|issue|repo|webhook|auth refactor|sso)\b/.test(lower) &&
    /\b(reassign|assign|owner|priority|p[0-3]|high|urgent|update|move)\b/.test(lower)
  ) {
    const before =
      args.artifacts.find((artifact) => artifact.id === "gh-auth-refactor") ??
      args.artifacts.find((artifact) => artifact.kind === "github_issue");
    if (before) {
      const after: WorkArtifact = {
        ...before,
        assignee: assignee ?? before.assignee,
        priority: priority ?? before.priority,
        updatedAt: nowIso,
      };
      if (changedWithoutTimestamp(before, after)) {
        actions.push(
          createFallbackAction(
            args,
            {
              agent: "github",
              actionType: assignee ? "reassign" : "change_priority",
              artifactKind: "github_issue",
              title: "Update GitHub issue from meeting",
              rationale: "The speaker gave an explicit GitHub issue ownership or priority change.",
              before,
              after,
            },
            actions.length,
          ),
        );
      }
    }
  }

  if (
    /\b(jira|notion|task|ticket|acme launch|feature x)\b/.test(lower) &&
    /\b(reassign|assign|owner|priority|status|update|move|block|in progress|done)\b/.test(lower)
  ) {
    const before =
      args.artifacts.find((artifact) =>
        /feature\s*x/.test(lower)
          ? artifact.id === "notion-featurex-decision"
          : artifact.id === "jira-acme-launch",
      ) ?? args.artifacts.find((artifact) => artifact.kind === "jira_task");
    if (before) {
      const nextStatus = /\b(done|complete|completed)\b/.test(lower)
        ? "done"
        : /\b(block|blocked)\b/.test(lower)
          ? "blocked"
          : /\bin progress\b/.test(lower)
            ? "in_progress"
            : before.status;
      const after: WorkArtifact = {
        ...before,
        assignee: assignee ?? before.assignee,
        priority: priority ?? before.priority,
        status: nextStatus,
        updatedAt: nowIso,
      };
      if (changedWithoutTimestamp(before, after)) {
        actions.push(
          createFallbackAction(
            args,
            {
              agent: "jira_notion",
              actionType: assignee
                ? "reassign"
                : priority
                  ? "change_priority"
                  : "change_status",
              artifactKind: before.kind,
              title: "Update project task from meeting",
              rationale: "The speaker gave an explicit Jira/Notion task update.",
              before,
              after,
            },
            actions.length,
          ),
        );
      }
    }
  }

  if (
    /\b(email|gmail|draft|send|reply|customer|acme)\b/.test(lower) &&
    /\b(draft|email|send|reply|tell|message)\b/.test(lower)
  ) {
    const draftTitle = /legal|dpa|feature\s*x/.test(lower)
      ? "Draft Acme note about Feature X approval"
      : "Draft customer follow-up from meeting";
    const after: WorkArtifact = {
      id: `draft-${slugify(draftTitle)}-${Date.now().toString(36)}`,
      kind: "email_draft",
      title: draftTitle,
      status: "draft",
      customer: /acme/.test(lower) ? "Acme" : undefined,
      source: "Live meeting",
      urlLabel: "Gmail draft",
      body:
        "Hi team,\n\nQuick follow-up from today's call: we should avoid promising a launch date until the relevant blocker is resolved. I will send a cleaner customer-facing update once Legal and Engineering confirm the next safe milestone.\n\nBest,",
      updatedAt: nowIso,
    };
    actions.push(
      createFallbackAction(
        args,
        {
          agent: "gmail",
          actionType: "create_draft",
          artifactKind: "email_draft",
          title: "Create Gmail draft from meeting",
          rationale: "The speaker asked for customer/team communication to be drafted.",
          after,
        },
        actions.length,
      ),
    );
  }

  return {
    actionDetected: actions.length > 0,
    actions: actions.slice(0, 3),
  };
}

function applyCandidate(
  candidate: Candidate,
  artifacts: WorkArtifact[],
  existingIds: Set<string>,
  utterance: { speaker: string; text: string },
  actionIndex: number,
): ServiceAction | null {
  const agent = isOneOf(candidate.agent, AGENTS)
    ? (candidate.agent as ServiceAgentKind)
    : null;
  const actionType = isOneOf(candidate.actionType, ACTION_TYPES)
    ? (candidate.actionType as ServiceActionType)
    : null;
  const artifactKind = isOneOf(candidate.artifactKind, ARTIFACT_KINDS)
    ? (candidate.artifactKind as WorkArtifactKind)
    : null;

  if (!agent || !actionType || !artifactKind || !candidate.actionTitle) {
    return null;
  }

  const isCreate = actionType === "create" || actionType === "create_draft";
  const before = candidate.artifactId
    ? artifacts.find((artifact) => artifact.id === candidate.artifactId)
    : undefined;

  if (!isCreate && !before) return null;

  const id = before?.id ?? makeArtifactId(candidate, actionIndex, existingIds);
  const nowIso = new Date().toISOString();
  const after: WorkArtifact = before
    ? { ...before }
    : {
        id,
        kind: artifactKind,
        title: candidate.artifactTitle || candidate.actionTitle,
        status: actionType === "create_draft" ? "draft" : "open",
        source: "Live meeting",
      };

  after.id = id;
  after.kind = artifactKind;
  after.title = candidate.artifactTitle || before?.title || candidate.actionTitle;
  after.updatedAt = nowIso;

  if (candidate.assignee) after.assignee = candidate.assignee;
  if (isOneOf(candidate.priority, PRIORITIES)) {
    after.priority = candidate.priority as WorkPriority;
  }
  if (candidate.status) after.status = candidate.status;
  if (candidate.customer) after.customer = candidate.customer;
  if (candidate.source) after.source = candidate.source;
  if (candidate.urlLabel) after.urlLabel = candidate.urlLabel;

  if (actionType === "create_draft" && !after.status) after.status = "draft";

  if (candidate.body) {
    after.body =
      actionType === "append_note" && before?.body
        ? `${before.body}\n\nMeeting update: ${candidate.body}`
        : candidate.body;
  } else if (actionType === "append_note" && before?.body) {
    after.body = `${before.body}\n\nMeeting update: ${candidate.rationale ?? ""}`;
  }

  if (before && !changedWithoutTimestamp(before, after)) return null;

  return {
    id: `svc-${Date.now()}-${actionIndex}`,
    agent,
    actionType,
    artifactKind,
    artifactId: after.id,
    title: candidate.actionTitle,
    rationale: candidate.rationale || "Applied from the live meeting.",
    basedOn: utterance,
    before,
    after,
    status: "applied",
    createdAt: Date.now(),
  };
}

export async function analyzeServiceActions(
  args: AnalyzeServiceActionArgs,
): Promise<ServiceActionResult> {
  const text = args.text.trim();
  if (!text) return { actionDetected: false, actions: [] };

  const prompt = JSON.stringify(
    {
      latestUtterance: { speaker: args.speaker, text },
      recentTranscript: args.recentTranscript ?? [],
      workArtifacts: args.artifacts.map(artifactForPrompt),
      existingActions: args.existingActions.slice(-12).map(actionForPrompt),
    },
    null,
    2,
  );

  let raw: string | undefined;
  try {
    const { response } = await generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.15,
        maxOutputTokens: 1800,
      },
    });
    raw = response.text;
  } catch (err) {
    console.warn(
      "[service-actions] Gemini unavailable, using seeded-context fallback:",
      err instanceof Error ? err.message : err,
    );
    return fallbackServiceActions(args);
  }

  if (!raw) return { actionDetected: false, actions: [] };

  let parsed: { actionDetected?: boolean; actions?: Candidate[] };
  try {
    parsed = JSON.parse(raw) as { actionDetected?: boolean; actions?: Candidate[] };
  } catch {
    return { actionDetected: false, actions: [] };
  }

  const existingIds = new Set(args.artifacts.map((artifact) => artifact.id));
  const actions = (parsed.actions ?? [])
    .slice(0, 3)
    .map((candidate, i) =>
      applyCandidate(
        candidate,
        args.artifacts,
        existingIds,
        { speaker: args.speaker, text },
        i,
      ),
    )
    .filter((action): action is ServiceAction => action !== null);

  return {
    actionDetected: Boolean(parsed.actionDetected) && actions.length > 0,
    actions,
  };
}

/** Internal helpers exposed for unit testing only. Not part of the public API. */
export const __test__ = {
  slugify,
  makeArtifactId,
  changedWithoutTimestamp,
  applyCandidate,
};
