// One-shot smoke test: build a synthetic ServiceAction and push it into the
// configured Notion database. Run with:
//   npx tsx scripts/test-notion.ts
import "dotenv/config";
import { pushActionToNotion } from "../src/lib/integrations/notion";
import type { ServiceAction } from "../src/lib/types";

async function main() {
  const action: ServiceAction = {
    id: `svc-test-${Date.now()}`,
    agent: "jira_notion",
    actionType: "create",
    artifactKind: "notion_task",
    artifactId: `notion-test-${Date.now()}`,
    title: "Test task from Live Context Collision",
    rationale: "Smoke test of the Notion integration.",
    basedOn: {
      speaker: "Maksim",
      text: "Create a Notion task to follow up on the DPA review for Acme, assign Mira, priority P1.",
    },
    after: {
      id: `notion-test-${Date.now()}`,
      kind: "notion_task",
      title: "Follow up on the DPA review for Acme",
      status: "open",
      priority: "P1",
      assignee: "Mira",
      customer: "Acme",
      source: "Live meeting smoke test",
      body: "Confirm with Legal that the DPA update for Acme is approved before promising Feature X.",
    },
    status: "applied",
    createdAt: Date.now(),
  };

  const result = await pushActionToNotion(action);
  if (!result) {
    console.error("Notion push returned null — check env vars and console warnings above.");
    process.exit(1);
  }
  console.log("Notion page created:", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
