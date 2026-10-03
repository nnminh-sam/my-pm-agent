import { test, expect, Page } from "@playwright/test";
import { E2E_USER } from "./fixtures";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_USER.email);
  await page.getByLabel("Password").fill(E2E_USER.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("/");
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("PO-2.2 the project page shows the PR section for a linked GitHub repo", async ({ page }) => {
  await open(page, "/projects/GH");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Open pull requests" }) });
  await expect(section).toBeVisible();
  await expect(section.getByText("Nothing fetched from GitHub yet.")).toBeVisible();
  await section.locator("summary").filter({ hasText: /Never synced|Out of sync/ }).first().click();
  await expect(section.getByRole("button", { name: /Retry now|Retry after/ }).first()).toBeVisible();
});

test("PO-2.1 a task's page shows its PRs on a project that was company", async ({ page }) => {
  await open(page, "/tasks/GH-M1-T1");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Pull requests" }) });
  await expect(section).toBeVisible();
  await expect(section.getByText("e2e/synced#1")).toBeVisible();
  await expect(section.locator("summary").filter({ hasText: /Never synced|Out of sync/ })).toBeVisible();
});
