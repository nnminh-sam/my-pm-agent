import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db, Row } from "../db";
import { migrate } from "../migrate";
import * as repo from "../repo";
import { setRepository, type Repository } from "../repository";
import { FileRepository } from "../repository/file";
import { PgRepository } from "../repository/postgres";
import { FsStore } from "../store/fs";
import { pullPr, pullRepoOpenPrs, type PullOptions } from "./pull";
import { FRESH_MS } from "./sync";

const TOKEN = "ghp_faketoken_pull_test";
const tempDirs: string[] = [];
afterAll(async () => {
  setRepository(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pglite(): Promise<Repository> {
  const pg = new PGlite();
  await migrate({
    exec: async (sql) => {
      await pg.exec(sql);
    },
    query: async (text, params) => (await pg.query<Row>(text, params)).rows,
  });
  const db: Db = {
    query: async (text, params) => (await pg.query<Row>(text, params)).rows,
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
      const dir = await mkdtemp(path.join(tmpdir(), "my-pm-pull-"));
      tempDirs.push(dir);
      return new FileRepository(new FsStore(dir));
    },
  },
  { name: "postgres (pglite)", setup: pglite },
];

const pull = (n: number, title = "Add thing") => ({
  number: n,
  title,
  body: "body",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  milestone: null,
  user: { login: "alice" },
  assignees: [],
  requested_reviewers: [{ login: "carol" }],
  base: { ref: "main" },
  head: { ref: "feat" },
  updated_at: "2026-09-29T09:00:00Z",
  html_url: `https://github.com/me/app/pull/${n}`,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

/** A fake GitHub whose next responses the test sets; counts calls. */
function fakeGithub() {
  const state = { calls: [] as string[], respond: (url: string): Response => (url.includes("/reviews") ? json([]) : json(pull(1))) };
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    state.calls.push(url);
    return state.respond(url);
  }) as typeof fetch;
  return { state, f };
}

describe.each(backends)("pull path on the $name backend", (backend) => {
  let clock: Date;
  const gh = fakeGithub();
  const opts = (extra: PullOptions = {}): PullOptions => ({
    now: () => clock,
    client: { fetch: gh.f, token: TOKEN, baseUrl: "http://gh.test" },
    ...extra,
  });
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeAll(async () => {
    setRepository(await backend.setup());
    clock = new Date("2026-09-29T10:00:00.000Z");
    await repo.createProject({ title: "Mine", code: "ME", repos: ["github.com/me/app", "github.com/me/lib"] });
    await repo.createProject({ title: "Corp", code: "CO", context: "company", repos: ["github.com/corp/app"] });
  });

  it("first fetch fails: never synced, the reason stored, nothing thrown", async () => {
    gh.state.calls = [];
    gh.state.respond = () => json({ message: "Service Unavailable" }, 503);
    const r = await pullPr("me/app#1", opts());
    expect(r).toMatchObject({ allowed: true, key: "pr:me/app#1", data: null, decision: { action: "fetch", reason: "never_fetched" } });
    if (!r.allowed) return;
    expect(r.sync).toMatchObject({ sync: "never", fetched_at: null, reason: "github_down", last_attempt_at: clock.toISOString() });
    expect(gh.state.calls).toHaveLength(2);
    expect(await repo.getGithubSnapshot("pr:me/app#1")).toEqual(r.snapshot);
    expect(r.snapshot).not.toHaveProperty("data");
  });

  it("success then failure: out of sync, serving the old data with the last sync time", async () => {
    gh.state.respond = (url) => (url.includes("/reviews") ? json([]) : json(pull(1, "First")));
    tick(1000);
    const ok = await pullPr(" ME/App#1 ", opts({ force: true }));
    if (!ok.allowed) throw new Error("refused");
    expect(ok.sync).toMatchObject({ sync: "synced", fetched_at: clock.toISOString(), reason: null });
    expect(ok.data?.title).toBe("First");
    const syncedAt = clock.toISOString();

    // Within 60s: served without a call.
    gh.state.calls = [];
    tick(FRESH_MS - 1);
    expect(await pullPr("me/app#1", opts())).toMatchObject({ decision: { action: "serve", reason: "fresh" }, data: { title: "First" } });
    expect(gh.state.calls).toHaveLength(0);

    // Stale and GitHub is down: the good snapshot stays.
    tick(1);
    gh.state.respond = () => {
      throw new TypeError("fetch failed");
    };
    const down = await pullPr("me/app#1", opts());
    if (!down.allowed) throw new Error("refused");
    expect(down.decision).toEqual({ action: "fetch", reason: "stale" });
    expect(down.data?.title).toBe("First");
    expect(down.sync).toMatchObject({ sync: "out_of_sync", fetched_at: syncedAt, reason: "github_down", last_attempt_at: clock.toISOString() });
    expect(await repo.getGithubSnapshot("pr:me/app#1")).toMatchObject({ data: { title: "First" }, fetched_at: syncedAt });
  });

  it("a 429 with a reset header sets retry_after; no call before it, not even from Retry now", async () => {
    tick(FRESH_MS);
    const reset = new Date(clock.getTime() + 3600_000);
    gh.state.respond = () =>
      json({ message: "API rate limit exceeded" }, 429, { "x-ratelimit-reset": String(Math.floor(reset.getTime() / 1000)), "x-ratelimit-remaining": "0" });
    const limited = await pullPr("me/app#1", opts());
    if (!limited.allowed) throw new Error("refused");
    expect(limited.sync).toMatchObject({ sync: "out_of_sync", reason: "rate_limited", retry_after: new Date(Math.floor(reset.getTime() / 1000) * 1000).toISOString() });
    expect(limited.data?.title).toBe("First");

    gh.state.calls = [];
    gh.state.respond = (url) => (url.includes("/reviews") ? json([]) : json(pull(1, "Second")));
    tick(FRESH_MS);
    const retry = await pullPr("me/app#1", opts({ force: true }));
    expect(retry).toMatchObject({ decision: { action: "serve", reason: "retry_after" }, data: { title: "First" }, sync: { sync: "out_of_sync" } });
    expect(gh.state.calls).toHaveLength(0);

    // After the reset, Retry now goes through and clears the error.
    clock = new Date(reset.getTime() + 1000);
    const after = await pullPr("me/app#1", opts({ force: true }));
    expect(after).toMatchObject({ data: { title: "Second" }, sync: { sync: "synced", reason: null, retry_after: null } });
    expect(gh.state.calls).toHaveLength(2);
  });

  it("pulls a repo's open PRs from a project remote or owner/repo, under the repo key", async () => {
    gh.state.calls = [];
    gh.state.respond = () => json([pull(3), pull(4)]);
    const r = await pullRepoOpenPrs("github.com/me/lib", opts());
    expect(r).toMatchObject({ allowed: true, key: "repo:me/lib", sync: { sync: "synced" } });
    expect(r.allowed && r.data?.map((p) => p.number)).toEqual([3, 4]);
    expect(gh.state.calls).toEqual(["http://gh.test/repos/me/lib/pulls?state=open&per_page=100"]);
    expect(await pullRepoOpenPrs("me/lib", opts())).toMatchObject({ decision: { reason: "fresh" } });
    expect(gh.state.calls).toHaveLength(1);
  });

  it("refuses company and unlinked repos: no call, nothing stored", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    gh.state.calls = [];
    try {
      for (const force of [false, true]) {
        expect(await pullPr("corp/app#5", opts({ force }))).toMatchObject({ allowed: false, key: "pr:corp/app#5", refusal: "company" });
        expect(await pullRepoOpenPrs("github.com/corp/app", opts({ force }))).toMatchObject({ allowed: false, refusal: "company" });
        expect(await pullPr("stranger/repo#1", opts({ force }))).toMatchObject({ allowed: false, refusal: "not_linked" });
        expect(await pullRepoOpenPrs("stranger/repo", opts({ force }))).toMatchObject({ allowed: false, refusal: "not_linked" });
      }
      // Also without an injected fetch: the global one is never reached.
      expect(await pullPr("corp/app#5")).toMatchObject({ allowed: false });
      for (const bad of ["corp/app", "../x#1", "gitlab.com/me/app#1"]) expect(await pullPr(bad, opts())).toMatchObject({ allowed: false, refusal: "invalid" });
      expect(await pullRepoOpenPrs("gitlab.com/me/app", opts())).toMatchObject({ allowed: false, refusal: "invalid" });
      expect(gh.state.calls).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
      for (const key of ["pr:corp/app#5", "repo:corp/app", "pr:stranger/repo#1", "repo:stranger/repo"]) {
        expect(await repo.getGithubSnapshot(key)).toBeNull();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("checks the link when reading: a repo moved to a company project stops being fetched", async () => {
    await repo.createProject({ title: "Later", code: "LT", repos: ["github.com/me/later"] });
    gh.state.respond = (url) => (url.includes("/reviews") ? json([]) : json(pull(9)));
    tick(FRESH_MS);
    expect(await pullPr("me/later#9", opts())).toMatchObject({ allowed: true, sync: { sync: "synced" } });

    await repo.updateProject("LT", { context: "company" });
    gh.state.calls = [];
    tick(FRESH_MS);
    expect(await pullPr("me/later#9", opts({ force: true }))).toMatchObject({ allowed: false, refusal: "company" });
    await repo.updateProject("LT", { context: "personal", repos: [] });
    expect(await pullPr("me/later#9", opts({ force: true }))).toMatchObject({ allowed: false, refusal: "not_linked" });
    expect(gh.state.calls).toHaveLength(0);
  });
});
