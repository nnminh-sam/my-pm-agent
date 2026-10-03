import { expect, test, type Page, type Request } from "@playwright/test";
import { E2E_USER } from "./fixtures";

/**
 * Acceptance tests for docs/features/pending-feedback (PF-1, PF-2). "The server is slow" is simulated by holding
 * server-action POSTs or RSC navigation requests in the browser for a while before they go out.
 */

const SLOW_MS = 1_500;
const SLOW_NAV_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isAction = (req: Request) => req.method() === "POST" && Boolean(req.headers()["next-action"]);
const isNavigation = (req: Request) => {
  const h = req.headers();
  return h["rsc"] === "1" && !h["next-router-prefetch"] && req.method() === "GET";
};

const actionLogs = new WeakMap<Page, Request[]>();

/** Hold every server-action request for SLOW_MS (once per page); returns the list of action requests sent. */
async function slowActions(page: Page) {
  const existing = actionLogs.get(page);
  if (existing) return existing;
  const sent: Request[] = [];
  actionLogs.set(page, sent);
  await page.route("**/*", async (route) => {
    if (isAction(route.request())) {
      sent.push(route.request());
      await sleep(SLOW_MS);
    }
    await route.fallback();
  });
  return sent;
}

/** Hold every (non-prefetch) RSC navigation request for SLOW_NAV_MS. */
async function slowNavigations(page: Page) {
  await page.route("**/*", async (route) => {
    if (isNavigation(route.request())) await sleep(SLOW_NAV_MS);
    await route.fallback();
  });
}

/** Open an app page and wait until it's hydrated, so links and forms go through the App Router. */
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

const spinnerIn = (page: Page, locator: ReturnType<Page["locator"]>) => locator.locator("[data-spinner]");

async function expectPending(button: ReturnType<Page["locator"]>) {
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button.locator("[data-spinner]")).toBeVisible();
}

async function expectIdle(button: ReturnType<Page["locator"]>) {
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-busy", /.*/);
  await expect(button.locator("[data-spinner]")).toHaveCount(0);
}



test.beforeEach(async ({ page }) => {
  await login(page);
});

test("PF-1.1 a pending form submit disables its button with aria-busy and a spinner, then clears", async ({ page }) => {
  await open(page, "/tasks/E2E-M1-T2");
  await slowActions(page);
  await page.getByPlaceholder("Hours").fill("0.5");
  const log = page.getByRole("button", { name: "Log", exact: true });
  await log.click();
  await expectPending(log);
  await expectIdle(log);

  // The log-out form behaves the same.
  const logout = page.getByRole("button", { name: "Log out" });
  await logout.click();
  await expectPending(logout);
  await page.waitForURL(/\/login/);
});

test("PF-1.2 a pending inline action disables its control with aria-busy and a spinner, then clears", async ({ page }) => {
  await open(page, "/tasks/E2E-M1-T1");
  await slowActions(page);

  // Status select.
  const select = page.getByLabel(/^Status of /).first();
  await select.selectOption("blocked");
  await expect(select).toBeDisabled();
  await expect(select).toHaveAttribute("aria-busy", "true");
  await expect(select.locator("xpath=..").locator("[data-spinner]")).toBeVisible();
  await expect(select).toBeEnabled();
  await expect(select.locator("xpath=..").locator("[data-spinner]")).toHaveCount(0);
  await expect(page.getByLabel(/^Status of /).first()).not.toHaveAttribute("aria-busy", /.*/);

  // Delete a comment.
  const del = page.getByRole("button", { name: "Delete" }).first();
  await del.click();
  await expectPending(del);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(2);
  await expect(page.locator("[data-spinner]")).toHaveCount(0);

  // Remove a repository.
  await open(page, "/projects/E2E");
  await slowActions(page);
  const remove = page.getByRole("button", { name: "Remove e2e/web" });
  await remove.click();
  await expectPending(remove);
  await expect(remove).toHaveCount(0);

  // Revoke an API key.
  await open(page, "/connect");
  await slowActions(page);
  page.once("dialog", (d) => d.accept());
  const revoke = page.getByRole("button", { name: "Revoke" }).first();
  await revoke.click();
  await expectPending(revoke);
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(1);
});

test("PF-1.3 clicking again or pressing Enter while pending sends no second request", async ({ page }) => {
  await open(page, "/projects/E2E");
  const sent = await slowActions(page);
  const input = page.getByLabel("Repository to link");
  await input.fill("e2e/once");
  const add = page.getByRole("button", { name: "Add", exact: true });
  await add.click();
  await expectPending(add);
  await add.click({ force: true }).catch(() => {});
  await input.press("Enter");
  await expectIdle(add);
  await expect(page.getByText("github.com/e2e/once", { exact: true })).toHaveCount(1);
  expect(sent).toHaveLength(1);
});

test("PF-1.4 a failed action leaves the trigger idle and shows the call site's error", async ({ page }) => {
  await open(page, "/projects/E2E");
  await slowActions(page);
  await page.getByLabel("Repository to link").fill("not a remote");
  const add = page.getByRole("button", { name: "Add", exact: true });
  await add.click();
  await expectPending(add);
  await expectIdle(add);
  await expect(page.getByRole("alert").filter({ hasText: "isn't a git remote" })).toBeVisible();
});

test("PF-1.5 the spinner is hidden from assistive technology and a visually hidden status names the action", async ({ page }) => {
  await open(page, "/connect");
  await slowActions(page);
  const create = page.getByRole("button", { name: "Create API key" });
  await create.click();
  const spinner = create.locator("[data-spinner]");
  await expect(spinner).toHaveAttribute("aria-hidden", "true");
  const status = page.getByRole("status").filter({ hasText: "Creating…" });
  await expect(status).toHaveCount(1);
  await expect(status).toHaveClass(/sr-only/);
  await expectIdle(create);
  await expect(page.getByRole("status").filter({ hasText: "Creating…" })).toHaveCount(0);
  // The action finished: the new key's one-time panel shows.
  await expect(page.getByLabel("New API key")).toBeVisible();
});

test("PF-1.6 with prefers-reduced-motion the spinner shows without animating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "/tasks/E2E-M1-T2");
  await slowActions(page);
  await page.getByPlaceholder("Hours").fill("0.25");
  const log = page.getByRole("button", { name: "Log", exact: true });
  await log.click();
  const spinner = spinnerIn(page, log);
  await expect(spinner).toBeVisible();
  expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await expectIdle(log);
});

test("PF-2.1 a slow navigation shows the loading skeleton in the page area with the nav bar still there", async ({ page }) => {
  await open(page, "/");
  await slowNavigations(page);
  await page.getByRole("navigation").getByRole("link", { name: "Backlog" }).click();
  const skeleton = page.locator("[data-page-skeleton]");
  await expect(skeleton).toBeVisible();
  await expect(page.locator("main").locator("[data-page-skeleton]")).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Projects" })).toBeVisible();
  await page.waitForURL(/\/backlog$/);
  await expect(skeleton).toHaveCount(0);
});

test("PF-2.2 a slow navigation shows the top progress bar until the new page shows", async ({ page }) => {
  await open(page, "/");
  await slowNavigations(page);
  await page.getByRole("navigation").getByRole("link", { name: "Projects" }).click();
  const bar = page.locator("[data-navigation-progress]").first();
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  expect(box?.y).toBe(0);
  await page.waitForURL(/\/projects$/);
  await expect(page.locator("[data-page-skeleton]")).toHaveCount(0);
  await expect(page.locator("[data-navigation-progress]")).toHaveCount(0);
});

test("PF-2.3 changing a Gantt filter on a slow server shows the progress bar until the filtered view shows", async ({ page }) => {
  await open(page, "/gantt");
  await slowNavigations(page);
  await page.locator("summary", { hasText: "Projects" }).click();
  await page.locator('input[type=checkbox][name=project][value="E2E"]').click();
  await expect(page.locator("[data-navigation-progress]").first()).toBeVisible();
  await page.waitForURL(/project=E2E/);
  await expect(page.locator("[data-navigation-progress]")).toHaveCount(0);
});

test("PF-2.4 the skeleton is aria-busy with a hidden Loading… status, and the bar is hidden from assistive technology", async ({ page }) => {
  await open(page, "/");
  await slowNavigations(page);
  await page.getByRole("navigation").getByRole("link", { name: "Connect" }).click();
  const skeleton = page.locator("[data-page-skeleton]");
  await expect(skeleton).toHaveAttribute("aria-busy", "true");
  const status = skeleton.getByRole("status");
  await expect(status).toHaveText("Loading…");
  await expect(status).toHaveClass(/sr-only/);
  const bar = page.locator("[data-navigation-progress]").first();
  await expect(bar).toBeVisible();
  for (const el of await page.locator("[data-navigation-progress]").all()) await expect(el).toHaveAttribute("aria-hidden", "true");
  await page.waitForURL(/\/connect$/);
});

test("PF-2.5 a navigation that completes within 150 ms never shows the progress bar", async ({ page }) => {
  await open(page, "/projects");
  await page.getByRole("navigation").getByRole("link", { name: "Backlog" }).click();
  await page.waitForURL(/\/backlog$/);
  await expect(page.locator("[data-page-skeleton]")).toHaveCount(0);
  // Watch for the bar from here on; back/forward is served from the router's cache, well within 150 ms.
  await page.evaluate(() => {
    (window as unknown as { barSeen: boolean }).barSeen = false;
    new MutationObserver(() => {
      if (document.querySelector("[data-navigation-progress]")) (window as unknown as { barSeen: boolean }).barSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const started = Date.now();
  await page.goBack();
  await page.waitForURL(/\/projects$/);
  await expect(page.getByRole("heading").first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(1_000);
  await sleep(500);
  expect(await page.evaluate(() => (window as unknown as { barSeen: boolean }).barSeen)).toBe(false);
});
