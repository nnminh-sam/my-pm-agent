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
  await expect(page.getByRole("heading", { name: "Open pull requests" })).toBeVisible();
  await expect(page.getByText("github.com/e2e/synced")).toBeVisible();
  await page.locator("summary").filter({ hasText: /Never synced|Out of sync/ }).first().click();
  await expect(page.getByRole("button", { name: /Retry now|Retry after/ }).first()).toBeVisible();
});
