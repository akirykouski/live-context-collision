import { Client } from "@notionhq/client";
import type { ServiceAction, WorkPriority } from "../types";

// ─── env wiring ──────────────────────────────────────────────────────────
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

export function notionEnabled(): boolean {
  return Boolean(NOTION_API_KEY && NOTION_DATABASE_ID);
}

let cachedClient: Client | null = null;
function getClient(): Client {
  if (!cachedClient) cachedClient = new Client({ auth: NOTION_API_KEY });
  return cachedClient;
}

// ─── field mapping ───────────────────────────────────────────────────────
// The hackathon Sprint Board DB uses these option names for Priority:
//   "P0 — Critical", "P1 — High", "P2 — Medium", "P3 — Low".
// Note: the dash is U+2014 (em dash), not a hyphen.
const PRIORITY_OPTION: Record<WorkPriority, string> = {
  P0: "P0 — Critical",
  P1: "P1 — High",
  P2: "P2 — Medium",
  P3: "P3 — Low",
};

// Status names live under Notion's `status` property type, which has a fixed
// set defined in-app. Our internal statuses are looser, so we squash them.
function mapStatus(raw: string | undefined): string {
  const v = (raw || "").toLowerCase();
  if (v.includes("progress") || v === "active") return "In progress";
  if (v === "done" || v === "complete" || v === "completed") return "Done";
  return "Not started";
}

function richText(text: string | undefined): { rich_text: { text: { content: string } }[] } {
  if (!text) return { rich_text: [] };
  // Notion caps a single rich_text item at 2000 chars; chunk if needed.
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 1900));
    remaining = remaining.slice(1900);
  }
  return { rich_text: chunks.map((content) => ({ text: { content } })) };
}

function titleProp(text: string): { title: { text: { content: string } }[] } {
  return { title: [{ text: { content: text.slice(0, 200) } }] };
}

// ─── public API ──────────────────────────────────────────────────────────

/**
 * Pushes a single service action into the Notion Sprint Board database.
 *
 * Only acts when:
 *   - Notion env is configured;
 *   - the action came from the `jira_notion` agent;
 *   - the action creates a new task (we don't try to update real Notion pages
 *     because the seed artifacts don't have a notion_page_id mapping yet).
 *
 * On success the caller can patch `action.after` with the returned page url
 * so the UI shows a clickable link to the live Notion task.
 */
export async function pushActionToNotion(
  action: ServiceAction,
): Promise<{ pageId: string; url: string } | null> {
  if (!notionEnabled()) return null;
  if (action.agent !== "jira_notion") return null;
  if (action.actionType !== "create") return null;

  const after = action.after;
  const properties: Record<string, unknown> = {
    Task: titleProp(after.title || action.title || "Untitled task"),
    Status: { status: { name: mapStatus(after.status) } },
  };

  if (after.priority && PRIORITY_OPTION[after.priority]) {
    properties.Priority = { select: { name: PRIORITY_OPTION[after.priority] } };
  }
  if (after.assignee) {
    properties.Assignee = richText(after.assignee);
  }
  if (action.basedOn?.text) {
    properties["Transcript Quote"] = richText(
      `${action.basedOn.speaker}: "${action.basedOn.text}"`,
    );
  }
  // `Source Meeting` is a select — pass a name and Notion will reuse the
  // option if it already exists (or auto-create if the DB allows new options).
  properties["Source Meeting"] = {
    select: { name: "Live Context Collision · meeting" },
  };

  const body = after.body || action.rationale;
  const children = body
    ? [
        {
          object: "block" as const,
          type: "paragraph" as const,
          paragraph: { rich_text: [{ type: "text" as const, text: { content: body.slice(0, 1900) } }] },
        },
      ]
    : undefined;

  try {
    const page = await getClient().pages.create({
      parent: { database_id: NOTION_DATABASE_ID as string },
      properties: properties as never,
      ...(children ? { children } : {}),
    });
    const pageWithUrl = page as { id: string; url?: string };
    return {
      pageId: pageWithUrl.id,
      url: pageWithUrl.url ?? `https://www.notion.so/${pageWithUrl.id.replace(/-/g, "")}`,
    };
  } catch (err) {
    console.warn(
      "[notion] push failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Walks a batch of service actions, pushes each eligible one to Notion, and
 * returns a copy of the array with `after.urlLabel` / `after.metadata`
 * patched on the actions that landed. Errors are swallowed per-action so a
 * single Notion hiccup never breaks the meeting flow.
 */
export async function dispatchActionsToNotion(
  actions: ServiceAction[],
): Promise<ServiceAction[]> {
  if (!notionEnabled() || actions.length === 0) return actions;

  return Promise.all(
    actions.map(async (action) => {
      const result = await pushActionToNotion(action);
      if (!result) return action;

      const after = {
        ...action.after,
        urlLabel: "Notion · live task",
        metadata: {
          ...(action.after.metadata ?? {}),
          notion_page_id: result.pageId,
          notion_url: result.url,
        },
      };
      return { ...action, after };
    }),
  );
}
