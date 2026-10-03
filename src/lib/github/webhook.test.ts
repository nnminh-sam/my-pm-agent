import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { POST } from "@/app/api/github/webhook/route";
import { proxy } from "@/proxy";
import type { Db, Row } from "../db";
import { migrate } from "../migrate";
import * as repo from "../repo";
import { setRepository, type Repository } from "../repository";
import { FileRepository } from "../repository/file";
import { PgRepository } from "../repository/postgres";
import { FsStore } from "../store/fs";
import type { GithubSnapshot } from "../types";
import type { PrOverview, RepoPrItem } from "./overview";
import { applyWebhookEvent, verifySignature, webhookKeys } from "./webhook";

const SECRET = "whsec_fake_webhook_secret_for_tests";
const NOW = new Date("2026-09-29T10:00:00.000Z");
const sign = (body: string | Uint8Array, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// ---- payload builders (the shapes GitHub sends) ----

const ghPull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  body: "body",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  milestone: null,
  user: { login: "alice" },
  assignees: [{ login: "alice" }],
  requested_reviewers: [{ login: "carol" }],
  base: { ref: "main" },
  head: { ref: `feat-${n}` },
  updated_at: "2026-09-29T09:00:00Z",
  html_url: `https://github.com/me/app/pull/${n}`,
  ...extra,
});
const prEvent = (action: string, pr: Record<string, unknown>, fullName = "Me/App") => ({
  action,
  number: pr.number,
  pull_request: pr,
  repository: { full_name: fullName },
});
const reviewEvent = (login: string, state: string, pr: Record<string, unknown>, action = "submitted", fullName = "me/app") => ({
  action,
  review: { user: { login }, state, submitted_at: "2026-09-29T09:30:00Z", body: "review text is never stored" },
  pull_request: pr,
  repository: { full_name: fullName },
});

const overview = (n: number, extra: Partial<PrOverview> = {}): PrOverview => ({
  repo: "me/app",
  number: n,
  title: `PR ${n}`,
  body: "body",
  state: "open",
  merged_at: null,
  milestone: null,
  reviewers: [
    { login: "bob", state: "approved" },
    { login: "carol", state: "pending" },
  ],
  assignees: ["alice"],
  author: "alice",
  base: "main",
  head: `feat-${n}`,
  updated_at: "2026-09-29T09:00:00Z",
  url: `https://github.com/me/app/pull/${n}`,
  ...extra,
});
const item = (n: number, extra: Partial<RepoPrItem> = {}): RepoPrItem => ({
  repo: "me/app",
  number: n,
  title: `PR ${n}`,
  state: "open",
  author: "alice",
  reviewers: ["carol"],
  assignees: ["alice"],
  updated_at: "2026-09-29T09:00:00Z",
  url: `https://github.com/me/app/pull/${n}`,
  ...extra,
});

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe("verifySignature", () => {
  const body = JSON.stringify({ zen: "Design for failure." });
  it("accepts GitHub's signature of the exact body, as a string or bytes, hex in either case", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
    expect(verifySignature(new TextEncoder().encode(body), sign(body), SECRET)).toBe(true);
    expect(verifySignature(body, `sha256=${sign(body).slice(7).toUpperCase()}`, SECRET)).toBe(true);
  });
  it("rejects a bad signature: another secret, another body, one flipped digit", () => {
    expect(verifySignature(body, sign(body, "whsec_other_fake"), SECRET)).toBe(false);
    expect(verifySignature(`${body} `, sign(body), SECRET)).toBe(false);
    const good = sign(body);
    const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    expect(verifySignature(body, flipped, SECRET)).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, "", SECRET)).toBe(false);
  });
  it("rejects a wrong or missing prefix (sha1=, SHA256=, bare hex)", () => {
    const hex = sign(body).slice("sha256=".length);
    for (const header of [hex, `sha1=${hex}`, `SHA256=${hex}`, ` sha256=${hex}`, `sha256=${hex} `]) {
      expect(verifySignature(body, header, SECRET)).toBe(false);
    }
  });
  it("rejects a length mismatch and malformed hex without throwing", () => {
    const hex = sign(body).slice("sha256=".length);
    for (const header of [`sha256=${hex.slice(0, -2)}`, `sha256=${hex}00`, "sha256=", `sha256=${"z".repeat(64)}`, `sha256=${hex.slice(0, 63)}g`]) {
      expect(verifySignature(body, header, SECRET)).toBe(false);
    }
  });
  it("rejects everything when no secret is configured", () => {
    for (const secret of [undefined, null, ""]) {
      expect(verifySignature(body, sign(body, ""), secret)).toBe(false);
      expect(verifySignature(body, sign(body), secret)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// applyWebhookEvent (pure)
// ---------------------------------------------------------------------------

describe("applyWebhookEvent", () => {
  const PR = "pr:me/app#7";
  const LIST = "repo:me/app";
  const stored = (data: unknown, extra: Partial<GithubSnapshot> = {}): GithubSnapshot => ({
    key: PR,
    data: data as GithubSnapshot["data"],
    fetched_at: "2026-09-29T09:10:00.000Z",
    last_attempt_at: "2026-09-29T09:50:00.000Z",
    ...extra,
  });

  it("keys: the PR, plus the repo list for pull_request; none without a repo or number", () => {
    expect(webhookKeys("pull_request", prEvent("opened", ghPull(7)))).toEqual([PR, LIST]);
    expect(webhookKeys("pull_request_review", reviewEvent("bob", "approved", ghPull(7)))).toEqual([PR]);
    expect(webhookKeys("pull_request", { pull_request: ghPull(7) })).toEqual([]);
    expect(webhookKeys("pull_request", prEvent("opened", ghPull(7), "not a repo"))).toEqual([]);
    expect(webhookKeys("pull_request", prEvent("opened", { ...ghPull(7), number: "7" }))).toEqual([]);
    expect(applyWebhookEvent("pr:me/app#8", null, "pull_request", prEvent("opened", ghPull(7)), NOW)).toBeNull();
  });

  it("pull_request closed + merged: state merged, reviewer states kept, fetched_at set, error cleared, retry_after kept", () => {
    const before = stored(overview(7), {
      last_error: { reason: "github_down", status: 503, message: "down", request_id: null },
      retry_after: "2026-09-29T10:30:00.000Z",
    });
    const pr = ghPull(7, {
      state: "closed",
      merged: true,
      merged_at: "2026-09-29T09:55:00Z",
      title: "Renamed",
      requested_reviewers: [],
      updated_at: "2026-09-29T09:55:00Z",
    });
    const after = applyWebhookEvent(PR, before, "pull_request", prEvent("closed", pr), NOW);
    expect(after).toEqual({
      key: PR,
      data: overview(7, {
        state: "merged",
        merged_at: "2026-09-29T09:55:00Z",
        title: "Renamed",
        reviewers: [{ login: "bob", state: "approved" }],
        updated_at: "2026-09-29T09:55:00Z",
      }),
      fetched_at: NOW.toISOString(),
      last_attempt_at: "2026-09-29T09:50:00.000Z",
      retry_after: "2026-09-29T10:30:00.000Z",
    });
  });

  it("pull_request: requested reviewers from the payload; one who already reviewed keeps their state", () => {
    const pr = ghPull(7, { requested_reviewers: [{ login: "Bob" }, { login: "dave" }], updated_at: "2026-09-29T09:20:00Z" });
    const after = applyWebhookEvent(PR, stored(overview(7)), "pull_request", prEvent("review_requested", pr), NOW);
    expect((after?.data as PrOverview).reviewers).toEqual([
      { login: "bob", state: "approved" },
      { login: "dave", state: "pending" },
    ]);
  });

  it("pull_request with no snapshot yet (or a data-less failure row) builds one from the payload", () => {
    const after = applyWebhookEvent(PR, null, "pull_request", prEvent("opened", ghPull(7)), NOW);
    expect(after).toEqual({ key: PR, data: overview(7, { reviewers: [{ login: "carol", state: "pending" }] }), fetched_at: NOW.toISOString() });
    const failed: GithubSnapshot = { key: PR, last_attempt_at: "2026-09-29T09:50:00.000Z", last_error: { reason: "timeout" } };
    expect(applyWebhookEvent(PR, failed, "pull_request", prEvent("opened", ghPull(7)), NOW)).toMatchObject({
      data: { number: 7 },
      fetched_at: NOW.toISOString(),
      last_attempt_at: "2026-09-29T09:50:00.000Z",
    });
  });

  it("pull_request older than what's stored changes nothing; a sparse payload maps leniently", () => {
    const newer = stored(overview(7, { updated_at: "2026-09-29T09:40:00Z" }));
    expect(applyWebhookEvent(PR, newer, "pull_request", prEvent("edited", ghPull(7, { title: "old" })), NOW)).toBeNull();
    expect(applyWebhookEvent(PR, null, "pull_request", { ...prEvent("opened", ghPull(7)), pull_request: { number: 7, state: 3 } }, NOW)).toMatchObject({
      data: { number: 7, state: "open", title: "" },
    });
  });

  it("pull_request_review approved: that reviewer's state only; the rest of the snapshot kept", () => {
    const before = stored(overview(7));
    const after = applyWebhookEvent(PR, before, "pull_request_review", reviewEvent("Carol", "approved", ghPull(7, { title: "ignored" })), NOW);
    expect(after).toEqual({
      ...before,
      data: overview(7, { reviewers: [{ login: "bob", state: "approved" }, { login: "Carol", state: "approved" }] }),
      fetched_at: NOW.toISOString(),
    });
  });

  it("pull_request_review follows reduceReviews: commented never overrides, dismissed clears, edited is ignored", () => {
    const before = stored(overview(7));
    const commented = applyWebhookEvent(PR, before, "pull_request_review", reviewEvent("bob", "commented", ghPull(7)), NOW);
    expect((commented?.data as PrOverview).reviewers).toEqual(overview(7).reviewers);
    const changes = applyWebhookEvent(PR, before, "pull_request_review", reviewEvent("bob", "changes_requested", ghPull(7)), NOW);
    expect((changes?.data as PrOverview).reviewers[0]).toEqual({ login: "bob", state: "changes_requested" });
    const dismissed = applyWebhookEvent(PR, before, "pull_request_review", reviewEvent("bob", "dismissed", ghPull(7), "dismissed"), NOW);
    expect((dismissed?.data as PrOverview).reviewers).toEqual([{ login: "carol", state: "pending" }]);
    expect(applyWebhookEvent(PR, before, "pull_request_review", reviewEvent("bob", "changes_requested", ghPull(7), "edited"), NOW)).toBeNull();
    expect(applyWebhookEvent(PR, before, "pull_request_review", { ...reviewEvent("bob", "approved", ghPull(7)), review: { state: "approved" } }, NOW)).toBeNull();
  });

  it("pull_request_review with no snapshot yet builds one, reviewer states starting from this review", () => {
    const after = applyWebhookEvent(PR, null, "pull_request_review", reviewEvent("bob", "approved", ghPull(7)), NOW);
    expect(after).toEqual({
      key: PR,
      data: overview(7, { reviewers: [{ login: "bob", state: "approved" }, { login: "carol", state: "pending" }] }),
      fetched_at: NOW.toISOString(),
    });
  });

  it("the repo list: upserts an open PR, removes a closed one, leaves fetched_at alone, needs a fetched list", () => {
    const list: GithubSnapshot = { key: LIST, data: [item(3), item(7)], fetched_at: "2026-09-29T09:10:00.000Z" };
    const opened = applyWebhookEvent(LIST, list, "pull_request", prEvent("opened", ghPull(9)), NOW);
    expect(opened).toEqual({ ...list, data: [item(9, { reviewers: ["carol"] }), item(3), item(7)] });
    const edited = applyWebhookEvent(LIST, list, "pull_request", prEvent("edited", ghPull(7, { title: "New", draft: true })), NOW);
    expect(edited?.data).toEqual([item(3), item(7, { title: "New", state: "draft" })]);
    const merged = applyWebhookEvent(LIST, list, "pull_request", prEvent("closed", ghPull(7, { state: "closed", merged: true })), NOW);
    expect(merged).toEqual({ ...list, data: [item(3)] });
    expect(applyWebhookEvent(LIST, list, "pull_request", prEvent("closed", ghPull(5, { state: "closed" })), NOW)).toBeNull();
    expect(applyWebhookEvent(LIST, null, "pull_request", prEvent("opened", ghPull(9)), NOW)).toBeNull();
    expect(applyWebhookEvent(LIST, list, "pull_request_review", reviewEvent("bob", "approved", ghPull(7)), NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/github/webhook, on both backends
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(async () => {
  setRepository(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pglite(): Promise<Repository> {
  const pg = new PGlite();
  const query = async (text: string, params?: unknown[]) => (await pg.query<Row>(text, params)).rows;
  await migrate({ exec: async (sql) => void (await pg.exec(sql)), query });
  const db: Db = {
    query,
    transaction: (statements) =>
      pg.transaction(async (tx) => {
        const results: Row[][] = [];
        for (const s of statements) results.push((await tx.query<Row>(s.text, s.params)).rows);
        return results;
      }),
  };
  return new PgRepository(db);
}

const backends: { name: string; setup: () => Promise<Repository> }[] = [
  {
    name: "fs",
    async setup() {
      const dir = await mkdtemp(path.join(tmpdir(), "my-pm-webhook-"));
      tempDirs.push(dir);
      return new FileRepository(new FsStore(dir));
    },
  },
  { name: "postgres (pglite)", setup: pglite },
];

function delivery(event: string, payload: unknown, { signature, raw }: { signature?: string | null; raw?: string } = {}) {
  const body = raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": "fake-guid" };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return new Request("http://localhost:3000/api/github/webhook", { method: "POST", headers, body });
}

describe.each(backends)("POST /api/github/webhook on the $name backend", (backend) => {
  let fetchSpy: MockInstance<typeof fetch>;
  let consoleSpies: MockInstance[];
  const logged = () => consoleSpies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");

  beforeAll(async () => {
    setRepository(await backend.setup());
    await repo.createProject({ title: "Mine", code: "ME", repos: ["github.com/me/app"] });
    await repo.createProject({ title: "Corp", code: "CO", context: "company", repos: ["github.com/corp/app"] });
  });
  beforeEach(() => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    // No delivery ever calls GitHub (or anything else), and the secret never reaches a log.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logged()).not.toContain(SECRET);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function send(req: Request, status: number) {
    const res = await POST(req);
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    if (status === 204) expect(text).toBe("");
    return text;
  }

  it("a signed closed + merged pull_request marks the snapshot merged, keeping reviewer states", async () => {
    await repo.upsertGithubSnapshot({ key: "pr:me/app#7", data: overview(7), fetched_at: "2026-09-29T09:10:00.000Z" });
    const pr = ghPull(7, { state: "closed", merged: true, merged_at: "2026-09-29T09:55:00Z", requested_reviewers: [], updated_at: "2026-09-29T09:55:00Z" });
    await send(delivery("pull_request", prEvent("closed", pr)), 204);
    const snap = await repo.getGithubSnapshot("pr:me/app#7");
    expect(snap?.data).toMatchObject({ state: "merged", merged_at: "2026-09-29T09:55:00Z", reviewers: [{ login: "bob", state: "approved" }] });
    expect(Date.parse(snap!.fetched_at!)).toBeGreaterThan(Date.parse("2026-09-29T09:10:00.000Z"));
    // No repo list was fetched yet, so none is made from one delivery.
    expect(await repo.getGithubSnapshot("repo:me/app")).toBeNull();
  });

  it("a signed pull_request_review approved updates that reviewer", async () => {
    await repo.upsertGithubSnapshot({ key: "pr:me/app#8", data: overview(8), fetched_at: "2026-09-29T09:10:00.000Z" });
    await send(delivery("pull_request_review", reviewEvent("carol", "approved", ghPull(8))), 204);
    expect((await repo.getGithubSnapshot("pr:me/app#8"))?.data).toMatchObject({
      reviewers: [
        { login: "bob", state: "approved" },
        { login: "carol", state: "approved" },
      ],
    });
  });

  it("a review on a PR with no snapshot builds one from the payload", async () => {
    expect(await repo.getGithubSnapshot("pr:me/app#9")).toBeNull();
    await send(delivery("pull_request_review", reviewEvent("bob", "changes_requested", ghPull(9))), 204);
    const snap = await repo.getGithubSnapshot("pr:me/app#9");
    expect(snap?.data).toMatchObject({ number: 9, reviewers: [{ login: "bob", state: "changes_requested" }, { login: "carol", state: "pending" }] });
    expect(snap?.data).not.toHaveProperty("review");
    expect(JSON.stringify(snap)).not.toContain("review text");
  });

  it("keeps a fetched repo list roughly right: a new PR is added, a closed one removed", async () => {
    await repo.upsertGithubSnapshot({ key: "repo:me/app", data: [item(3)], fetched_at: "2026-09-29T09:10:00.000Z" });
    await send(delivery("pull_request", prEvent("opened", ghPull(10))), 204);
    expect((await repo.getGithubSnapshot("repo:me/app"))?.data).toMatchObject([{ number: 10 }, { number: 3 }]);
    await send(delivery("pull_request", prEvent("closed", ghPull(3, { state: "closed" }))), 204);
    expect(await repo.getGithubSnapshot("repo:me/app")).toEqual({
      key: "repo:me/app",
      data: [item(10, { reviewers: ["carol"] })],
      fetched_at: "2026-09-29T09:10:00.000Z",
    });
  });

  it("a bad or missing signature gets 401 and stores nothing", async () => {
    const payload = prEvent("opened", ghPull(20));
    const body = JSON.stringify(payload);
    for (const signature of [null, "", sign(body, "whsec_wrong_fake"), sign(body).slice("sha256=".length), "sha256=abc"]) {
      const text = await send(delivery("pull_request", payload, { signature }), 401);
      expect(JSON.parse(text)).toMatchObject({ error: "unauthorized" });
    }
    // Signed, then the body changed in transit.
    await send(delivery("pull_request", payload, { signature: sign(body), raw: body.replace("PR 20", "PR 21") }), 401);
    expect(await repo.getGithubSnapshot("pr:me/app#20")).toBeNull();
  });

  it("no GITHUB_WEBHOOK_SECRET: 401 even for a delivery signed with an empty key, without saying why", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    const payload = prEvent("opened", ghPull(21));
    const unset = await send(delivery("pull_request", payload, { signature: sign(JSON.stringify(payload), "") }), 401);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    const bad = await send(delivery("pull_request", payload, { signature: sign(JSON.stringify(payload), "whsec_wrong_fake") }), 401);
    expect(unset).toBe(bad);
    expect(await repo.getGithubSnapshot("pr:me/app#21")).toBeNull();
  });

  it("ping and any other event get 204 with nothing stored", async () => {
    await send(delivery("ping", { zen: "Keep it logically awesome.", hook_id: 1, repository: { full_name: "me/app" } }), 204);
    await send(delivery("push", { ref: "refs/heads/main", pull_request: ghPull(22), repository: { full_name: "me/app" } }), 204);
    await send(delivery("issues", prEvent("opened", ghPull(22))), 204);
    expect(await repo.getGithubSnapshot("pr:me/app#22")).toBeNull();
  });

  it("PO-2.2 accepts webhook events for a project that was company", async () => {
    await send(delivery("pull_request", prEvent("closed", ghPull(2, { state: "closed", merged: true }), "corp/app")), 204);
    await send(delivery("pull_request_review", reviewEvent("bob", "approved", ghPull(2), "submitted", "Corp/App")), 204);
    expect((await repo.getGithubSnapshot("pr:corp/app#2"))?.data).toMatchObject({ number: 2 });
  });

  it("PO-2.3 an unlinked repo gets 204 with nothing stored", async () => {
    await send(delivery("pull_request", prEvent("opened", ghPull(1), "stranger/repo")), 204);
    await send(delivery("pull_request_review", reviewEvent("bob", "approved", ghPull(1), "submitted", "stranger/repo")), 204);
    for (const key of ["pr:stranger/repo#1", "repo:stranger/repo"]) {
      expect(await repo.getGithubSnapshot(key)).toBeNull();
    }
  });

  it("malformed JSON after a valid signature gets 400; a payload without a repo gets 204", async () => {
    const raw = "payload=%7B%7D";
    const text = await send(delivery("pull_request", null, { raw, signature: sign(raw) }), 400);
    expect(JSON.parse(text)).toMatchObject({ error: "invalid_input" });
    await send(delivery("pull_request", { action: "opened", pull_request: ghPull(23) }), 204);
    await send(delivery("pull_request", ["not", "an", "object"]), 204);
  });
});

// ---------------------------------------------------------------------------
// src/proxy.ts: exactly /api/github/webhook is reachable without a session or API key
// ---------------------------------------------------------------------------

describe("proxy exemption", () => {
  afterEach(() => vi.unstubAllEnvs());
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
  const post = (pathname: string) => new NextRequest(`http://localhost:3000${pathname}`, { method: "POST", body: "{}" });

  it.each([
    { mode: "jwt", env: { JWT_SECRET: "webhook-test-jwt-secret-".padEnd(48, "0"), VERCEL: "" } },
    { mode: "locked", env: { JWT_SECRET: "", VERCEL: "1" } },
  ])("lets the webhook through in $mode mode, and nothing near it", async ({ env }) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    expect(passes(await proxy(post("/api/github/webhook")))).toBe(true);
    for (const other of ["/api/github", "/api/github/webhook/x", "/api/github/webhooks", "/api/github/webhook2", "/api/mcp"]) {
      const res = await proxy(post(other));
      expect(passes(res)).toBe(false);
      expect(res.status).toBe(401);
    }
  });
});
