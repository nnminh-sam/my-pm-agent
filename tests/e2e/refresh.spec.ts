import { expect, test, type Page } from "@playwright/test";
import { E2E_USER } from "./fixtures";

/** Acceptance tests for PF-3 in docs/features/pending-feedback/use-cases.md (Refresh the page). */

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_USER.email);
  await page.getByLabel("Password").fill(E2E_USER.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

const refreshButton = (page: Page) => page.getByRole("button", { name: "Refresh", exact: true });
const TASK = "E2E-M1-T1";

/** Change the task's title from another tab, the way an agent or a second window would. */
async function rename(other: Page, to: string) {
  await open(other, `/tasks/${TASK}`);
  await other.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = other.getByLabel(`${TASK} as markdown`);
  await editor.fill((await editor.inputValue()).replace(/^title: .*$/m, `title: ${to}`));
  await other.getByRole("button", { name: "Save", exact: true }).click();
  await expect(other.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
}

/** Document (full page) requests made from now on. */
function documentRequests(page: Page) {
  const docs: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "document") docs.push(r.url());
  });
  return docs;
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("PF-3.1 clicking Refresh shows data changed elsewhere without a document reload, with a pending state", async ({ page, context }) => {
  await open(page, `/tasks/${TASK}`);
  const docs = documentRequests(page);
  const other = await context.newPage();
  await rename(other, "First task (fresh)");
  try {
    await expect(page.getByText("First task (fresh)")).toHaveCount(0);
    await page.route("**/*", async (route) => {
      if (route.request().headers()["rsc"] === "1") await new Promise((r) => setTimeout(r, 1_000));
      await route.fallback();
    });
    await refreshButton(page).click();
    await expect(refreshButton(page)).toBeDisabled();
    await expect(refreshButton(page)).toHaveAttribute("aria-busy", "true");
    await expect(refreshButton(page).locator("[data-spinner]")).toBeVisible();
    await expect(page.getByText("First task (fresh)").first()).toBeVisible();
    await expect(refreshButton(page)).toBeEnabled();
    await expect(refreshButton(page).locator("[data-spinner]")).toHaveCount(0);
    expect(docs).toEqual([]);
  } finally {
    await rename(other, "First task");
  }
});

test("PF-3.2 pressing r refreshes like the button, and the button advertises it", async ({ page, context }) => {
  await open(page, `/tasks/${TASK}`);
  await expect(refreshButton(page)).toHaveAttribute("aria-keyshortcuts", "r");
  await expect(refreshButton(page)).toHaveAttribute("title", /\br\b/);
  const docs = documentRequests(page);
  const other = await context.newPage();
  await rename(other, "First task (key)");
  try {
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("r");
    await expect(page.getByText("First task (key)").first()).toBeVisible();
    expect(docs).toEqual([]);
  } finally {
    await rename(other, "First task");
  }
});

test("PF-3.3 a refresh keeps an unsaved draft, an open filter panel and the filter in the URL", async ({ page }) => {
  await open(page, `/tasks/${TASK}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByLabel(`${TASK} as markdown`);
  const draft = (await editor.inputValue()) + "\nunsaved draft line";
  await editor.fill(draft);
  await refreshButton(page).click();
  await expect(refreshButton(page)).toBeEnabled();
  await expect(editor).toHaveValue(draft);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();

  await open(page, "/gantt?project=E2E");
  await page.locator("summary", { hasText: "Milestones" }).click();
  const panel = page.locator("details", { hasText: "Milestones" });
  await expect(panel).toHaveAttribute("open", "");
  await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  await refreshButton(page).click();
  await expect(refreshButton(page)).toBeEnabled();
  await expect(panel).toHaveAttribute("open", "");
  await expect(page.locator('input[type=checkbox][name=project][value="E2E"]')).toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  expect(page.url()).toContain("project=E2E");
});

test("PF-3.4 pressing r while typing in a field does nothing", async ({ page }) => {
  await open(page, `/tasks/${TASK}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByLabel(`${TASK} as markdown`);
  const before = await editor.inputValue();
  let rsc = 0;
  page.on("request", (r) => {
    if (r.headers()["rsc"] === "1") rsc++;
  });
  await editor.focus();
  await page.keyboard.type("r");
  expect((await editor.inputValue()).length).toBe(before.length + 1);
  await page.waitForTimeout(500);
  expect(rsc).toBe(0);
  await expect(refreshButton(page)).toBeEnabled();
  await expect(refreshButton(page).locator("[data-spinner]")).toHaveCount(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("PF-3.5 the page shows how old its data is and resets it after a refresh", async ({ page }) => {
  await page.clock.install();
  await open(page, "/");
  const label = page.locator("[data-refreshed-at]");
  await expect(label).toHaveText("Updated just now");
  await page.clock.fastForward("03:00");
  await expect(label).toHaveText(/Updated [23]m ago/);
  await refreshButton(page).click();
  await expect(label).toHaveText("Updated just now");
});
