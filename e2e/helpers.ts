import type { Page, TestInfo } from "@playwright/test";

/** Attaches console/pageerror collectors so specs can assert a clean page. */
export function collectPageDiagnostics(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(`${err.name}: ${err.message}`);
  });

  return { consoleErrors, pageErrors };
}

/** Known-benign noise we don't want to fail builds on (mic/secure-context). */
export function filterBenign(errors: string[]) {
  return errors.filter(
    (e) =>
      !/getUserMedia|Permission denied|NotAllowedError|secure context|AudioContext|microphone|speechmatics|websocket/i.test(
        e,
      ),
  );
}

export async function attachDiagnostics(
  testInfo: TestInfo,
  diag: { consoleErrors: string[]; pageErrors: string[] },
) {
  await testInfo.attach("console-errors", {
    body: JSON.stringify(diag.consoleErrors, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("page-errors", {
    body: JSON.stringify(diag.pageErrors, null, 2),
    contentType: "application/json",
  });
}
