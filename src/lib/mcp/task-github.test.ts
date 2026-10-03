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
import { taskContext } from "./task-context";
import { taskGithub, tasksGithub } from "./task-github";

const tempDirs: string[] = [];
afterAll(async () => {
  setRepository(undefined);
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
        for (const s of statements)
          results.push((await tx.query<Row>(s.text, s.params)).rows);
        return results;
      }),
  };
  return new PgRepository(db);
}

const backends: { name: string; setup: () => Promise<Repository> }[] = [
  {
    name: "fs",
    async setup() {
      const dir = await mkdtemp(path.join(tmpdir(), "my-pm-taskgh-"));
      tempDirs.push(dir);
      return new FileRepository(new FsStore(dir));
    },
  },
  { name: "postgres (pglite)", setup: pglite },
];

const overview = (n: number) => ({
  repo: "me/app",
  number: n,
  title: `PR ${n}`,
  body: "raw **body**",
  state: "open",
  merged_at: null,
  milestone: "v1",
  reviewers: [{ login: "carol", state: "approved" }],
  assignees: ["alice"],
  author: "alice",
  base: "main",
  head: "feat",
  updated_at: "2026-09-29T09:00:00.000Z",
  // A snapshot's url is never used: entries link from the normalized ref.
  url: `https://snapshot.example/${n}`,
});

describe.each(backends)("taskGithub on the $name backend", (backend) => {
  beforeAll(async () => {
    setRepository(await backend.setup());
    await repo.createProject({
      title: "Mine",
      code: "ME",
      repos: ["github.com/me/app"],
    });
    await repo.createProject({
      title: "Corp",
      code: "CO",
      repos: ["github.com/corp/app"],
    });
    await repo.createMilestone({ title: "M", project: "ME" });
    await repo.createMilestone({ title: "M", project: "CO" });
    await repo.createTasks([
      { title: "Mixed", milestone: "ME-M1" },
      { title: "Plain", milestone: "ME-M1" },
      { title: "Corp task", milestone: "CO-M1" },
    ]);
    await repo.updateTask("ME-M1-T1", {
      prs: ["me/app#1", "me/app#2", "me/app#3"],
    });
    await repo.updateTask("CO-M1-T1", { prs: ["corp/app#9"] });
    await repo.updateProject("CO", { context: "company" }); // the PR is now stale
    await repo.upsertGithubSnapshot({
      key: "pr:me/app#1",
      data: overview(1),
      fetched_at: "2026-09-29T09:30:00.000Z",
      last_attempt_at: "2026-09-29T09:30:00.000Z",
    });
    await repo.upsertGithubSnapshot({
      key: "pr:me/app#2",
      data: overview(2),
      fetched_at: "2026-09-29T08:00:00.000Z",
      last_attempt_at: "2026-09-29T09:00:00.000Z",
      last_error: {
        reason: "rate_limited",
        status: 403,
        message: "rate limited",
        request_id: null,
      },
      retry_after: "2026-09-29T10:00:00.000Z",
    });
    await repo.upsertGithubSnapshot({
      key: "pr:corp/app#9",
      data: overview(9),
      fetched_at: "2026-09-29T08:00:00.000Z",
    });
  });

  const section = async (code: string) =>
    taskGithub(await repo.getTask(code), await repo.loadWorkspace());

  it("gives synced, out of sync and never-fetched PRs from snapshots, without calling GitHub", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const prs = await section("ME-M1-T1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(prs).toHaveLength(3);
    expect(prs![0]).toMatchObject({
      ref: "me/app#1",
      url: "https://github.com/me/app/pull/1",
      overview: {
        title: "PR 1",
        body: "raw **body**",
        state: "open",
        milestone: "v1",
        reviewers: [{ login: "carol", state: "approved" }],
        assignees: ["alice"],
      },
      sync: {
        sync: "synced",
        fetched_at: "2026-09-29T09:30:00.000Z",
        reason: null,
      },
    });
    expect(prs![1].overview?.title).toBe("PR 2");
    expect(prs![1].sync).toEqual({
      sync: "out_of_sync",
      fetched_at: "2026-09-29T08:00:00.000Z",
      reason: "rate_limited",
      message: "rate limited",
      retry_after: "2026-09-29T10:00:00.000Z",
    });
    expect(prs![2]).toEqual({
      ref: "me/app#3",
      url: "https://github.com/me/app/pull/3",
      overview: null,
      sync: { sync: "never", fetched_at: null, reason: null },
    });
  });

  it("PO-2.1 tasksGithub (list chips) reads snapshots for many tasks in one pass, with 0 fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ws = await repo.loadWorkspace();
    const map = await tasksGithub(ws.tasks, ws);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const mixed = await repo.getTask("ME-M1-T1");
    expect(map.get(mixed.id)?.map((e) => e.sync.sync)).toEqual(["synced", "out_of_sync", "never"]);
    // Tasks without PRs have no entry; tasks in formerly company projects are included.
    expect(new Set(map.keys())).toEqual(new Set([mixed.id, (await repo.getTask("CO-M1-T1")).id]));
  });

  it("leaves the section out for a task without PRs", async () => {
    expect(await section("ME-M1-T2")).toBeUndefined();
  });

  it("PO-2.2 serves an overview for a project that was company, but not for an unlinked repo", async () => {
    await repo.updateProject("ME", { context: "company" });
    expect((await section("ME-M1-T1"))![0].overview).not.toBeNull();
    await repo.updateProject("ME", { context: "personal" });

    await repo.updateProject("ME", { repos: [] });
    const prs = (await section("ME-M1-T1"))!;
    expect(prs.map((p) => p.overview)).toEqual([null, null, null]);
    expect(prs[0].sync).toEqual({
      sync: "never",
      fetched_at: null,
      reason: "not_linked",
    });
    expect(prs[0].url).toBe("https://github.com/me/app/pull/1");
  });

  it("taskContext stays free of GitHub data", async () => {
    const ws = await repo.loadWorkspace();
    expect(taskContext(await repo.getTask("ME-M1-T1"), ws)).not.toHaveProperty(
      "pull_requests",
    );
  });
});
