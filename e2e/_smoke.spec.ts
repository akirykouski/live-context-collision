import { test, expect } from "@playwright/test";
import { collectPageDiagnostics, filterBenign } from "./helpers";

test.describe("smoke", () => {
  test("home renders with no fatal client error", async ({ page }) => {
    const diag = collectPageDiagnostics(page);
    await page.goto("/", { waitUntil: "networkidle" });

    await expect(page.locator("header.topbar")).toBeVisible();
    await expect(page.getByRole("button", { name: /Start meeting/i })).toBeVisible();
    await expect(
      page.locator(".view-switch button", { hasText: "Live" }),
    ).toBeVisible();
    await expect(
      page.locator(".view-switch button", { hasText: "Actions" }),
    ).toBeVisible();

    expect(filterBenign(diag.pageErrors)).toEqual([]);
  });

  test("ai-gateway status endpoint reports a healthy key pool", async ({
    request,
  }) => {
    const res = await request.get("/api/ai-gateway");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBeGreaterThan(0);
  });
});
