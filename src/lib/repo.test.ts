import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@neondatabase/serverless";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "./codes";
import { neonDb, type Db, type Row } from "./db";
import { migrate, type MigrationSession } from "./migrate";
import { Playbook, PlaybookVersion } from "./playbook";
import * as repo from "./repo";
import { setRepository, type Repository } from "./repository";
import { FileRepository } from "./repository/file";
import { PgRepository } from "./repository/postgres";
import { FsStore } from "./store/fs";
import { todayIn } from "./time";
import { compareBackends, exportTo, importInto, readAll } from "./transfer";
import type { GithubSnapshot, Task, TaskComment } from "./types";

/** The seed sdlc playbook as a stored version. */
async function sdlcVersion(version = "1.0.0"): Promise<PlaybookVersion> {
  const definition = Playbook.parse({
    ...YAML.parse(await readFile(new URL("./playbooks/sdlc.yaml", import.meta.url), "utf8")),
    version,
  });
  return PlaybookVersion.parse({
    ref: `sdlc@${version}`,
    name: "sdlc",
    version,
    hash: "0".repeat(64),
    synced_at: "2026-09-28T10:00:00.000Z",
    definition,
  });
}

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "my-pm-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  setRepository(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pglite(): Promise<PgRepository> {
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

/** A real Neon database, only when TEST_DATABASE_URL points at a disposable branch. It is wiped first. */
async function neonTestDb(url: string): Promise<PgRepository> {
  const client = new Client(url);
  await client.connect();
  const session: MigrationSession = {
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async (text, params) => (await client.query(text, params)).rows,
  };
  try {
    const exists = await session.query("select to_regclass('public.projects') as exists");
    if (exists[0]?.exists) await session.exec("truncate task_comments, github_snapshots, tasks, milestones, projects, playbook_versions, settings, users, api_keys restart identity");
    await migrate(session);
    await session.exec("truncate task_comments, github_snapshots, tasks, milestones, projects, playbook_versions, settings, users, api_keys restart identity");
  } finally {
    await client.end();
  }
  return new PgRepository(neonDb(url));
}

const backends: { name: string; setup: () => Promise<Repository>; dir?: string }[] = [
  {
    name: "fs",
    async setup() {
      const dir = await tempDir();
      this.dir = dir;
      return new FileRepository(new FsStore(dir));
    },
  },
  { name: "postgres (pglite)", setup: pglite },
];
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) backends.push({ name: "postgres (neon)", setup: () => neonTestDb(testDatabaseUrl) });

describe.each(backends)("$name backend", (backend) => {
  let backendRepo: Repository;
  beforeAll(async () => {
    backendRepo = await backend.setup();
    setRepository(backendRepo);
  });

  describe("project → milestone → task", () => {
    it("creates the hierarchy with codes and loads it back", async () => {
      const project = await repo.createProject({ title: "Website relaunch", code: "web", priority: "P1", description: "## Goal\nShip v2." });
      expect(project).toMatchObject({ code: "WEB", last_milestone_number: 0 });
      expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      const milestone = await repo.createMilestone({ title: "Login", project: "WEB" });
      expect(milestone).toMatchObject({ code: "WEB-M1", number: 1, project: project.id, priority: undefined });

      const [task] = await repo.createTasks([{ title: "POST /login", milestone: "WEB-M1", estimate: 2 }]);
      expect(task).toMatchObject({ code: "WEB-M1-T1", number: 1, milestone: milestone.id });

      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, `projects/${project.id}.md`), "utf8");
        expect(text).toContain(`id: ${project.id}\ncode: WEB\ntitle: Website relaunch\nstatus: active\npriority: P1`);
        expect(text).toContain("## Goal\nShip v2.");
      }

      const ws = await repo.loadWorkspace();
      expect(ws.projects.map((p) => [p.code, p.last_milestone_number])).toEqual([["WEB", 1]]);
      expect(ws.projects[0].body).toBe("## Goal\nShip v2.");
      expect(ws.milestones.map((m) => [m.code, m.project, m.last_task_number])).toEqual([["WEB-M1", project.id, 1]]);
      expect(ws.tasks).toEqual([task]);
      expect(ws.problems).toEqual([]);
    });

    it("finds records by code (any case) or id", async () => {
      const project = await repo.getProject("web");
      expect(await repo.getProject(project.id)).toEqual(project);
      const milestone = await repo.getMilestone("Web-m1");
      expect(await repo.getMilestone(milestone.id.toUpperCase())).toEqual(milestone);
      const task = await repo.getTask(" web-m1-t1 ");
      expect(await repo.getTask(task.id)).toEqual(task);
    });

    it("explains unknown, malformed and old-style references", async () => {
      await expect(repo.getTask("WEB-M1-T9")).rejects.toThrow("Task WEB-M1-T9 not found");
      await expect(repo.getTask("WEB-M1")).rejects.toThrow('"WEB-M1" is not a task code');
      await expect(repo.getTask("T-1")).rejects.toThrow("T-1 is an id from before milestones; use a task code like PMA-M1-T3");
      await expect(repo.getMilestone("f-1")).rejects.toThrow("F-1 is an id from before milestones");
      await expect(repo.getProject("PRJ-1")).rejects.toBeInstanceOf(repo.NotFoundError);
      await expect(repo.getTask("../projects/x")).rejects.toBeInstanceOf(repo.NotFoundError);
      await expect(repo.createMilestone({ title: "Orphan", project: "NOPE" })).rejects.toThrow("Project NOPE not found");
    });

    it("validates project codes", async () => {
      await expect(repo.createProject({ title: "Dup", code: "Web" })).rejects.toThrow('Project code WEB is already used by "Website relaunch"');
      for (const code of ["W", "TOOLONG", "1AB", "A-B", ""]) {
        await expect(repo.createProject({ title: "Bad", code })).rejects.toThrow("Project code must be");
      }
      expect((await repo.loadWorkspace()).projects).toHaveLength(1);
    });

    it("puts a project on hold", async () => {
      const project = await repo.updateProject("WEB", { status: "on_hold", deadline: "2026-12-01" });
      expect(project).toMatchObject({ status: "on_hold", deadline: "2026-12-01" });
      expect((await repo.getProject("web")).status).toBe("on_hold");
      await repo.updateProject("WEB", { status: "active", deadline: null });
    });
  });

  describe("tasks", () => {
    it("resolves backward and forward refs within a batch", async () => {
      const t1 = await repo.getTask("WEB-M1-T1");
      const created = await repo.createTasks([
        { ref: "api", title: "API", milestone: "WEB-M1", depends_on: ["ui", "web-m1-t1"], pert: { optimistic: 1, likely: 2, pessimistic: 6 } },
        { ref: "ui", title: "UI", milestone: "web-m1", tags: ["frontend"], deadline: "2026-11-01" },
        { title: "Docs", milestone: "WEB-M1", depends_on: ["api"] },
      ]);
      expect(created.map((t) => t.code)).toEqual(["WEB-M1-T2", "WEB-M1-T3", "WEB-M1-T4"]);
      // Ids, in the order given.
      expect(created[0].depends_on).toEqual([created[1].id, t1.id]);
      expect(created[2].depends_on).toEqual([created[0].id]);
      expect(created[0]).toMatchObject({ estimate: 2.5, estimate_range: [1, 6] });
      expect(await repo.getTask("WEB-M1-T2")).toEqual(created[0]);
      expect(await repo.getTask(created[1].id)).toEqual(created[1]);
    });

    it("rejects a batch with a bad dependency, milestone or cycle, and writes nothing (not even numbers)", async () => {
      const before = await repo.loadWorkspace();
      await expect(
        repo.createTasks([{ title: "ok", milestone: "WEB-M1" }, { title: "bad", milestone: "WEB-M1", depends_on: ["WEB-M1-T99"] }]),
      ).rejects.toThrow("WEB-M1-T99");
      await expect(repo.createTasks([{ title: "lost", milestone: "WEB-M9" }])).rejects.toThrow('Milestone WEB-M9 not found (task "lost")');
      await expect(
        repo.createTasks([
          { ref: "a", title: "a", milestone: "WEB-M1", depends_on: ["b"] },
          { ref: "b", title: "b", milestone: "WEB-M1", depends_on: ["a"] },
        ]),
      ).rejects.toThrow("Dependency cycle: a would depend on itself");
      const after = await repo.loadWorkspace();
      expect(after.tasks.length).toBe(before.tasks.length);
      expect(after.milestones[0].last_task_number).toBe(before.milestones[0].last_task_number);
    });

    it("updates fields, completes and reopens a task", async () => {
      const updated = await repo.updateTask("WEB-M1-T3", { estimate: 4, priority: "P0", not_before: "2026-10-01", append_note: "hi" });
      expect(updated).toMatchObject({ estimate: 4, estimate_range: undefined, priority: "P0", not_before: "2026-10-01" });
      expect(updated.body).toMatch(/### Note · \d{4}-\d{2}-\d{2}\n\nhi$/);
      const done = await repo.updateTask("WEB-M1-T3", { status: "done" });
      expect(done.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const reopened = await repo.updateTask("WEB-M1-T3", { status: "todo", priority: null, not_before: null });
      expect(reopened).toMatchObject({ completed: undefined, priority: undefined, not_before: undefined });
      expect(await repo.getTask("WEB-M1-T3")).toEqual(reopened);
      await expect(repo.updateTask("WEB-M1-T1", { depends_on: ["WEB-M1-T2"] })).rejects.toThrow(
        "Dependency cycle: WEB-M1-T1 would depend on itself",
      );
      await expect(repo.updateTask("WEB-M1-T1", { depends_on: ["WEB-M1-T99"] })).rejects.toThrow("Task WEB-M1-T99 not found");
    });

    it("logs time into the ## Log section", async () => {
      const first = await repo.logTime("WEB-M1-T1", 1.5, "skeleton");
      expect(first).toMatchObject({ spent: 1.5, status: "in_progress" });
      const second = await repo.logTime("web-m1-t1", 0.25, undefined, true);
      expect(second).toMatchObject({ spent: 1.75, status: "done" });
      expect(second.body).toMatch(/## Log\n\n- \d{4}-\d{2}-\d{2}: 1.5h — skeleton\n- \d{4}-\d{2}-\d{2}: 0.25h$/);
      expect(await repo.getTask("WEB-M1-T1")).toEqual(second);
    });

    it("reorders tasks", async () => {
      const reordered = await repo.reorderTasks(["WEB-M1-T4", "WEB-M1-T2"]);
      expect(reordered.map((t) => [t.code, t.order])).toEqual([["WEB-M1-T4", 0], ["WEB-M1-T2", 1]]);
      expect((await repo.getTask("WEB-M1-T2")).order).toBe(1);
      await expect(repo.reorderTasks(["WEB-M1-T2", "WEB-M1-T99"])).rejects.toThrow("Task WEB-M1-T99 not found");
      expect((await repo.getTask("WEB-M1-T2")).order).toBe(1);
    });

    it("saves settings without resetting unmentioned fields", async () => {
      await repo.updateSettings({ timezone: "Asia/Ho_Chi_Minh", buffer: 1.2 });
      const settings = await repo.updateSettings({ days_off: ["2026-12-25"] });
      expect(settings).toMatchObject({ timezone: "Asia/Ho_Chi_Minh", buffer: 1.2, days_off: ["2026-12-25"] });
      expect(await repo.getSettings()).toEqual(settings);
    });
  });

  describe("codes follow moves and renames", () => {
    it("moves a task to another milestone: new number and code, same id and dependencies", async () => {
      await repo.createMilestone({ title: "Signup", project: "web" });
      const docs = await repo.getTask("WEB-M1-T4");
      const moved = await repo.updateTask("WEB-M1-T4", { milestone: "WEB-M2" });
      expect(moved).toMatchObject({ id: docs.id, code: "WEB-M2-T1", number: 1, depends_on: docs.depends_on });
      expect(await repo.getTask(docs.id)).toEqual(moved);
      await expect(repo.getTask("WEB-M1-T4")).rejects.toThrow("Task WEB-M1-T4 not found");
      // Its old number isn't handed out again.
      const [next] = await repo.createTasks([{ title: "after the move", milestone: "WEB-M1" }]);
      expect(next.code).toBe("WEB-M1-T5");
      // Moving to its own milestone changes nothing.
      expect(await repo.updateTask("WEB-M2-T1", { milestone: "web-m2" })).toEqual(moved);
    });

    it("numbers each milestone's tasks separately within one batch", async () => {
      const created = await repo.createTasks([
        { title: "a", milestone: "WEB-M2" },
        { title: "b", milestone: "WEB-M1" },
        { title: "c", milestone: "WEB-M2" },
      ]);
      expect(created.map((t) => t.code)).toEqual(["WEB-M2-T2", "WEB-M1-T6", "WEB-M2-T3"]);
    });

    it("moves a milestone to another project: renumbered, its tasks recoded", async () => {
      const other = await repo.createProject({ title: "Operations", code: "OTH" });
      await repo.createMilestone({ title: "Existing", project: "OTH" });
      const signup = await repo.getMilestone("WEB-M2");
      const moved = await repo.updateMilestone("WEB-M2", { project: "oth", title: "Sign-up" });
      expect(moved).toMatchObject({ id: signup.id, code: "OTH-M2", number: 2, project: other.id, title: "Sign-up" });

      const ws = await repo.loadWorkspace();
      const tasks = ws.tasks.filter((t) => t.milestone === signup.id);
      expect(tasks.map((t) => t.code)).toEqual(["OTH-M2-T1", "OTH-M2-T2", "OTH-M2-T3"]);
      expect(tasks[0].depends_on).toEqual([(await repo.getTask("WEB-M1-T2")).id]);
      expect(ws.problems).toEqual([]);
      expect((await repo.createMilestone({ title: "Next", project: "WEB" })).code).toBe("WEB-M3");
    });

    it("renames every code in a project when its code changes", async () => {
      const renamed = await repo.updateProject("OTH", { code: "ops" });
      expect(renamed).toMatchObject({ code: "OPS", last_milestone_number: 2 });
      const ws = await repo.loadWorkspace();
      expect(ws.milestones.filter((m) => m.project === renamed.id).map((m) => m.code)).toEqual(["OPS-M1", "OPS-M2"]);
      expect(ws.tasks.filter((t) => t.code.startsWith("OPS-")).map((t) => t.code)).toEqual(["OPS-M2-T1", "OPS-M2-T2", "OPS-M2-T3"]);
      expect(ws.tasks.filter((t) => t.code.startsWith("OTH-"))).toEqual([]);
      expect(ws.problems).toEqual([]);
      await expect(repo.getProject("OTH")).rejects.toThrow("Project OTH not found");
      await expect(repo.updateProject("OPS", { code: "WEB" })).rejects.toThrow("Project code WEB is already used");
      expect((await repo.getProject("OPS")).last_milestone_number).toBe(2);
    });

    it("updates mentions of changed codes in markdown, leaving priorities and other text alone", async () => {
      const notes = await repo.createMilestone({
        title: "Notes",
        project: "WEB",
        description: "Follows WEB-M1-T2 and OPS-M2-T1 (see OPS-M2). Priority P1, not OPS-M20.",
      });
      await repo.updateProject("OPS", { code: "OPX" });
      expect((await repo.getMilestone(notes.id)).body).toBe("Follows WEB-M1-T2 and OPX-M2-T1 (see OPX-M2). Priority P1, not OPS-M20.");

      const moved = await repo.updateTask("OPX-M2-T1", { milestone: "WEB-M1", description: "Moved; I am OPX-M2-T1." });
      expect(moved.body).toBe(`Moved; I am ${moved.code}.`);
      expect((await repo.getMilestone(notes.id)).body).toContain(`Follows WEB-M1-T2 and ${moved.code} (see OPX-M2)`);

      const back = await repo.updateMilestone("OPX-M2", { project: "WEB" });
      expect((await repo.getMilestone(notes.id)).body).toContain(`(see ${back.code})`);
      expect((await repo.loadWorkspace()).problems).toEqual([]);
    });

    it("keeps counters when a stale copy is saved", async () => {
      const stale = await repo.getMilestone("WEB-M1");
      await repo.createTasks([{ title: "bumps the counter", milestone: "WEB-M1" }]);
      await backendRepo.save({ milestones: [{ ...stale, title: "Log in" }] });
      expect(await repo.getMilestone("WEB-M1")).toMatchObject({ title: "Log in", last_task_number: stale.last_task_number + 1 });
    });

    it("reports stored codes that don't match their parents", async () => {
      const task = await repo.getTask("WEB-M1-T1");
      await backendRepo.save({ tasks: [{ ...task, code: "WEB-M1-T99" }] });
      expect((await repo.loadWorkspace()).problems).toEqual(["task WEB-M1-T99: code should be WEB-M1-T1"]);
      await backendRepo.save({ tasks: [task] });
      expect((await repo.loadWorkspace()).problems).toEqual([]);
    });
  });

  describe("lifecycle fields", () => {
    it("stores playbook versions once and never overwrites them", async () => {
      const v1 = await sdlcVersion();
      expect(await backendRepo.insertPlaybookVersion(v1)).toBe(true);
      expect(await backendRepo.insertPlaybookVersion({ ...v1, hash: "1".repeat(64) })).toBe(false);
      expect(await backendRepo.getPlaybookVersion("sdlc@1.0.0")).toEqual(v1);
      expect(await backendRepo.getPlaybookVersion("sdlc@9.9.9")).toBeNull();
      expect(await backendRepo.getPlaybookVersion("../projects/x")).toBeNull();

      // Newer versions sort after older ones by number, not as text.
      const v10 = await sdlcVersion("1.10.0");
      const v2 = await sdlcVersion("1.2.0");
      await backendRepo.insertPlaybookVersion(v10);
      await backendRepo.insertPlaybookVersion(v2);
      const ws = await repo.loadWorkspace();
      expect(ws.playbooks.map((v) => v.ref)).toEqual(["sdlc@1.0.0", "sdlc@1.2.0", "sdlc@1.10.0"]);
      // Key order survives (the order checks are listed in).
      expect(Object.keys(ws.playbooks[0].definition.checks)).toEqual(Object.keys(v1.definition.checks));
      expect(ws.problems).toEqual([]);
    });

    it("persists a project's pin, repos and detectors, and a milestone's stage, checks and deployments", async () => {
      const project = await repo.createProject({ title: "Lifecycle", code: "LC" });
      expect(project).toMatchObject({ repos: [], detectors: [] });
      expect(project.playbook).toBeUndefined();
      const milestone = await repo.createMilestone({ title: "Core", project: "LC" });
      expect(milestone).toMatchObject({ checks: {}, deployments: {} });
      expect(milestone.stage).toBeUndefined();
      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, `milestones/${milestone.id}.md`), "utf8");
        expect(text).not.toMatch(/checks|deployments|stage/);
      }

      const pinned = {
        ...project,
        playbook: "sdlc@1.0.0",
        repos: ["github.com/acme/api", "github.com/acme/web"],
        detectors: ["migrations"],
      };
      const staged = {
        ...milestone,
        status: "in_progress" as const,
        stage: "release" as const,
        checks: {
          "spec.accepted": { status: "passed" as const, at: "2026-09-20", by: "claude", note: "https://docs.lc.test/spec" },
          "design.decisions_recorded": { status: "waived" as const, at: "2026-09-21", note: "No hard-to-reverse decisions" },
        },
        deployments: { dev: { at: "2026-09-27", ref: "a1b2c3d" }, staging: { at: "2026-09-28", url: "https://staging.lc.test" } },
      };
      await backendRepo.save({ projects: [pinned], milestones: [staged] });
      // The counter moved when LC-M1 was created; a save from the earlier read keeps it.
      expect(await repo.getProject("LC")).toEqual({ ...pinned, last_milestone_number: 1 });
      expect(await repo.getMilestone("LC-M1")).toEqual(staged);

      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, `milestones/${milestone.id}.md`), "utf8");
        expect(text).toContain("status: in_progress\nstage: release\nproject:");
        expect(text).toContain("checks:\n  spec.accepted:\n    status: passed\n    at: 2026-09-20");
        expect(text).toContain("deployments:\n  dev:\n    at: 2026-09-27\n    ref: a1b2c3d");
      }
      const ws = await repo.loadWorkspace();
      expect(ws.problems).toEqual([]);
    });
  });

  describe("GitHub snapshots, PR references and comments", () => {
    let task: Task;
    let other: Task;
    beforeAll(async () => {
      await repo.createProject({ title: "GitHub", code: "GH" });
      await repo.createMilestone({ title: "PRs", project: "GH" });
      [task, other] = await repo.createTasks([
        { title: "Review", milestone: "GH-M1" },
        { title: "Other", milestone: "GH-M1" },
      ]);
    });

    it("stores a task's PR references", async () => {
      expect(task.prs).toEqual([]);
      if (backend.dir) expect(await readFile(path.join(backend.dir, `tasks/${task.id}.md`), "utf8")).not.toContain("prs");
      await backendRepo.save({ tasks: [{ ...task, prs: ["nnminh-sam/my-pm-agent#12", "acme/web.site#3"] }] });
      expect((await repo.getTask("GH-M1-T1")).prs).toEqual(["nnminh-sam/my-pm-agent#12", "acme/web.site#3"]);
      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, `tasks/${task.id}.md`), "utf8");
        expect(text).toContain("prs: [nnminh-sam/my-pm-agent#12, acme/web.site#3]");
      }
      expect((await repo.loadWorkspace()).problems).toEqual([]);
    });

    it("sets a task's PRs through updateTask: normalized, de-duplicated, replaced, cleared", async () => {
      await repo.updateProject("GH", { repos: ["https://github.com/GH/Site.git"] });
      const set = await repo.updateTask(other.id, {
        prs: ["https://github.com/GH/Site/pull/7/files", "gh/site#7", "GH/Site#9"],
      });
      expect(set.prs).toEqual(["gh/site#7", "gh/site#9"]);
      expect((await repo.getTask(other.id)).prs).toEqual(["gh/site#7", "gh/site#9"]);
      // Other patches leave the list alone; a new list replaces it; [] clears it.
      expect((await repo.updateTask(other.id, { title: "Other!" })).prs).toEqual(["gh/site#7", "gh/site#9"]);
      expect((await repo.updateTask(other.id, { prs: ["gh/site#11"] })).prs).toEqual(["gh/site#11"]);
      expect((await repo.updateTask(other.id, { prs: [] })).prs).toEqual([]);
    });

    it("rejects malformed PRs and repos the project doesn't link, changing nothing", async () => {
      await repo.updateTask(other.id, { prs: ["gh/site#1"] });
      await expect(repo.updateTask(other.id, { title: "Nope", prs: ["gh/site#2", "gh/other#3"] })).rejects.toThrow(
        /gh\/other#3 is in gh\/other, which isn't linked to project GH.*Linked repos: github.com\/gh\/site.*update_project/,
      );
      await expect(repo.updateTask(other.id, { prs: ["https://gitlab.com/gh/site/pull/2"] })).rejects.toThrow(/^prs: Only GitHub PRs/);
      await expect(repo.updateTask(other.id, { prs: ["not a pr"] })).rejects.toBeInstanceOf(repo.PrReferenceError);
      expect(await repo.getTask(other.id)).toMatchObject({ title: "Other!", prs: ["gh/site#1"] });
      // A project with no linked repos says so.
      await repo.createProject({ title: "Bare", code: "BR" });
      await repo.createMilestone({ title: "M", project: "BR" });
      const [bare] = await repo.createTasks([{ title: "Bare task", milestone: "BR-M1" }]);
      await expect(repo.updateTask(bare.id, { prs: ["gh/site#1"] })).rejects.toThrow("It has no linked repos");
    });

    it("PO-2.1 accepts PRs on a project whose repo is linked", async () => {
      await repo.createProject({ title: "Corp", code: "CO", repos: ["github.com/corp/app"] });
      await repo.createMilestone({ title: "M", project: "CO" });
      const [corp] = await repo.createTasks([{ title: "Review", milestone: "CO-M1" }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      expect((await repo.updateTask(corp.id, { prs: ["corp/app#5"] })).prs).toEqual(["corp/app#5"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("re-checks PRs when a task moves to another milestone", async () => {
      await repo.createProject({ title: "Mv", code: "MV", repos: ["github.com/mv/one"] });
      await repo.createProject({ title: "Mv2", code: "MW", repos: ["github.com/mv/two"] });
      await repo.createMilestone({ title: "A", project: "MV" });
      await repo.createMilestone({ title: "B", project: "MV" });
      await repo.createMilestone({ title: "C", project: "MW" });
      const [moved] = await repo.createTasks([{ title: "Mover", milestone: "MV-M1" }]);
      await repo.updateTask(moved.id, { prs: ["mv/one#4"] });
      // Same project: fine. Another project that doesn't link the repo: refused, nothing moves.
      expect(await repo.updateTask(moved.id, { milestone: "MV-M2" })).toMatchObject({ code: "MV-M2-T1", prs: ["mv/one#4"] });
      await expect(repo.updateTask(moved.id, { milestone: "MW-M1" })).rejects.toThrow(/Can't move MV-M2-T1 to MW-M1: PR mv\/one#4 is in mv\/one, which isn't linked to project MW/);
      expect((await repo.getTask(moved.id)).code).toBe("MV-M2-T1");
      // Clearing the PRs in the same patch lets the move through; so does listing ones the destination links.
      expect(await repo.updateTask(moved.id, { milestone: "MW-M1", prs: ["mv/two#8"] })).toMatchObject({ code: "MW-M1-T1", prs: ["mv/two#8"] });
      expect(await repo.updateTask(moved.id, { milestone: "MV-M1", prs: [] })).toMatchObject({ code: "MV-M1-T2", prs: [] });
    });

    it("keeps one snapshot per key and replaces it whole", async () => {
      const key = "pr:nnminh-sam/my-pm-agent#12";
      expect(await backendRepo.getGithubSnapshot(key)).toBeNull();
      // Never synced: the first attempt failed.
      const never = {
        key,
        last_attempt_at: "2026-09-29T01:00:00.000Z",
        last_error: { reason: "github_down", status: 503, message: "Service Unavailable" },
      };
      await backendRepo.upsertGithubSnapshot(never);
      expect(await backendRepo.getGithubSnapshot(key)).toEqual(never);

      const synced = {
        key,
        data: {
          title: "Add <script>",
          body: "Line 1\n\nLine 2\n",
          state: "open",
          merged_at: null,
          reviewers: [{ login: "octo", state: "approved" }],
          number: 12,
          draft: false,
        },
        fetched_at: "2026-09-29T01:05:00.123Z",
        last_attempt_at: "2026-09-29T01:05:00.000Z",
      };
      await backendRepo.upsertGithubSnapshot(synced);
      expect(await backendRepo.getGithubSnapshot(key)).toEqual(synced);

      // Rate-limited: the caller keeps the data and records the failure.
      const limited = {
        ...synced,
        last_attempt_at: "2026-09-29T01:10:00.000Z",
        last_error: { reason: "rate_limited", status: 429, request_id: "ABCD:1234" },
        retry_after: "2026-09-29T02:00:00.000Z",
      };
      await backendRepo.upsertGithubSnapshot(limited);
      expect(await backendRepo.getGithubSnapshot(key)).toEqual(limited);

      // A repo's open-PR list is an array.
      const list = { key: "repo:nnminh-sam/my-pm-agent", data: [{ number: 12, title: "Add" }], fetched_at: "2026-09-29T01:00:00.000Z" };
      await backendRepo.upsertGithubSnapshot(list);
      expect(await backendRepo.getGithubSnapshot(list.key)).toEqual(list);

      for (const bad of ["pr:acme/api", "issue:acme/api#1", "../tasks/x", "repo:acme"]) {
        expect(await backendRepo.getGithubSnapshot(bad)).toBeNull();
        await expect(backendRepo.upsertGithubSnapshot({ key: bad })).rejects.toThrow();
      }
      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, "github_snapshots/pr%3Annminh-sam%2Fmy-pm-agent%2312.yaml"), "utf8");
        expect(text).toMatch(/^key: pr:nnminh-sam\/my-pm-agent#12\ndata:\n/);
      }
    });

    it("validates snapshots and stores timestamps as toISOString() on every backend", async () => {
      const key = "pr:acme/api#1";
      await backendRepo.upsertGithubSnapshot({
        key,
        data: { title: "x" },
        fetched_at: "2026-09-29T01:05:00Z",
        last_attempt_at: "2026-09-29T01:05:00.1Z",
        retry_after: "2026-09-29T02:00:00.123456Z",
      });
      expect(await backendRepo.getGithubSnapshot(key)).toEqual({
        key,
        data: { title: "x" },
        fetched_at: "2026-09-29T01:05:00.000Z",
        last_attempt_at: "2026-09-29T01:05:00.100Z",
        retry_after: "2026-09-29T02:00:00.123Z",
      });
      for (const bad of [{ key, fetched_at: "yesterday" }, { key, fetched_at: "2026-09-29T01:05:00+07:00" }, { key, data: "text" }, { key: "PR:Acme/Api#1" }]) {
        await expect(backendRepo.upsertGithubSnapshot(bad as GithubSnapshot)).rejects.toThrow();
      }
      expect((await backendRepo.getGithubSnapshot(key))?.fetched_at).toBe("2026-09-29T01:05:00.000Z");
    });

    it("PO-2.2 finds the projects linking a repo, and whether GitHub may be contacted for it", async () => {
      expect((await backendRepo.findProjectsByRepo("github.com/gh/site")).map((p) => p.code)).toEqual(["GH"]);
      expect((await backendRepo.findProjectsByRepo("github.com/corp/app")).map((p) => p.code)).toEqual(["CO"]);
      expect(await backendRepo.findProjectsByRepo("github.com/nobody/here")).toEqual([]);
      expect(await repo.githubRepoAccess("gh/site")).toEqual({ allowed: true });
      expect(await repo.githubRepoAccess("corp/app")).toEqual({ allowed: true });
    });

    it("PO-2.3 refuses a repo linked to no project", async () => {
      expect(await repo.githubRepoAccess("nobody/here")).toMatchObject({ allowed: false, refusal: "not_linked" });
    });

    it("keeps a task's comments oldest first and deletes them one at a time", async () => {
      const at = (minute: number) => `2026-09-29T01:${String(minute).padStart(2, "0")}:00.000Z`;
      const second = { id: newId(), task_id: task.id, author: "agent" as const, created_at: at(2), body: "Opened PR 12.\n\n  <script>alert(1)</script>\n" };
      const first = { id: newId(), task_id: task.id, author: "you" as const, created_at: at(1), body: "review PR 412, check the migration" };
      const elsewhere = { id: newId(), task_id: other.id, author: "you" as const, created_at: at(0), body: "other" };
      for (const c of [second, first, elsewhere]) await backendRepo.insertComment(c);
      expect(await backendRepo.listComments(task.id)).toEqual([first, second]);
      expect(await backendRepo.listComments(other.id)).toEqual([elsewhere]);
      expect(await backendRepo.listComments(newId())).toEqual([]);
      expect(await backendRepo.listComments("../tasks")).toEqual([]);

      await expect(backendRepo.insertComment(first)).rejects.toThrow();
      await expect(backendRepo.insertComment({ ...first, id: newId(), task_id: newId() })).rejects.toThrow();
      await expect(backendRepo.insertComment({ ...first, id: newId(), body: "" })).rejects.toThrow();
      await expect(backendRepo.insertComment({ ...first, id: newId(), author: "bot" as "you" })).rejects.toThrow();

      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, `comments/${task.id}/${second.id}.yaml`), "utf8");
        expect(text).toMatch(new RegExp(`^id: ${second.id}\ntask_id: ${task.id}\nauthor: agent\ncreated_at: ${second.created_at}\nbody: `));
      }

      expect(await backendRepo.deleteComment(other.id, first.id)).toBe(false);
      expect(await backendRepo.deleteComment(task.id, first.id)).toBe(true);
      expect(await backendRepo.deleteComment(task.id, first.id)).toBe(false);
      expect(await backendRepo.deleteComment(task.id, "../x")).toBe(false);
      expect(await backendRepo.listComments(task.id)).toEqual([second]);

      const all = await backendRepo.loadSnapshotsAndComments();
      expect(all.comments).toEqual([second, elsewhere].sort((a, b) => (a.task_id < b.task_id ? -1 : 1)));
      expect(all.snapshots.map((s) => s.key)).toEqual(["pr:acme/api#1", "pr:nnminh-sam/my-pm-agent#12", "repo:nnminh-sam/my-pm-agent"]);
      expect(all.problems).toEqual([]);
    });

    it("ignores the comments of a task whose file is gone (files have no cascade)", async () => {
      if (!backend.dir) return; // Postgres: the foreign key cascades (migrate.test.ts).
      const [gone] = await repo.createTasks([{ title: "Gone", milestone: "GH-M1" }]);
      await backendRepo.insertComment({ id: newId(), task_id: gone.id, author: "you", created_at: "2026-09-29T03:00:00.000Z", body: "bye" });
      const before = (await backendRepo.loadSnapshotsAndComments()).comments.length;
      await rm(path.join(backend.dir, `tasks/${gone.id}.md`));
      const after = await backendRepo.loadSnapshotsAndComments();
      expect(after.comments).toHaveLength(before - 1);
      expect(after.comments.some((c) => c.task_id === gone.id)).toBe(false);
      expect(after.problems).toEqual([]);
    });
  });

  describe("task comments", () => {
    let a: Task;
    let b: Task;
    let c: Task;
    beforeAll(async () => {
      await repo.createProject({ title: "Comments", code: "CMT" });
      await repo.createMilestone({ title: "One", project: "CMT" });
      await repo.createMilestone({ title: "Two", project: "CMT" });
      [a, b] = await repo.createTasks([
        { title: "A", milestone: "CMT-M1" },
        { title: "B", milestone: "CMT-M1" },
      ]);
      [c] = await repo.createTasks([{ title: "C", milestone: "CMT-M2" }]);
    });

    it("adds comments and lists them oldest first, by code or id", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-29T01:00:00.000Z"));
        const first = await repo.addComment("cmt-m1-t1", "first", "you");
        vi.setSystemTime(new Date("2026-09-29T02:00:00.000Z"));
        const second = await repo.addComment(a.id, "second", "agent");
        expect(first).toMatchObject({ task_id: a.id, author: "you", created_at: "2026-09-29T01:00:00.000Z", body: "first" });
        expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(await repo.listComments("CMT-M1-T1")).toEqual([first, second]);
        expect(await repo.listComments(a.id)).toEqual([first, second]);
        expect(await repo.listComments("CMT-M1-T2")).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
      await expect(repo.addComment("CMT-M1-T99", "x", "you")).rejects.toBeInstanceOf(repo.NotFoundError);
      await expect(repo.listComments("CMT-M1-T99")).rejects.toBeInstanceOf(repo.NotFoundError);
    });

    it("trims the body, and rejects an empty or over-long one", async () => {
      expect((await repo.addComment(b.id, "  \n line 1\n\n  line 2 \n", "you")).body).toBe("line 1\n\n  line 2");
      await expect(repo.addComment(b.id, " \n\t ", "you")).rejects.toThrow("Comment body is empty");
      await expect(repo.addComment(b.id, "x".repeat(repo.MAX_COMMENT_LENGTH + 1), "you")).rejects.toThrow("too long");
      expect((await repo.addComment(b.id, "x".repeat(repo.MAX_COMMENT_LENGTH), "you")).body).toHaveLength(repo.MAX_COMMENT_LENGTH);
      await expect(repo.addComment(b.id, "hi", "bot" as "you")).rejects.toThrow();
      expect(await repo.listComments(b.id)).toHaveLength(2);
    });

    it("stores markup and references verbatim", async () => {
      const body = "<script>alert(1)</script> **bold** see CMT-M1-T1 and [x](http://a.b)";
      const comment = await repo.addComment(c.id, body, "agent");
      expect(comment.body).toBe(body);
      expect((await repo.listComments(c.code))[0].body).toBe(body);
    });

    it("deletes a comment, and says when it or the task is missing", async () => {
      const [keep, drop] = [await repo.addComment(c.id, "keep", "you"), await repo.addComment(c.id, "drop", "you")];
      await repo.deleteComment(c.code, drop.id);
      expect((await repo.listComments(c.id)).map((x) => x.id)).toContain(keep.id);
      expect((await repo.listComments(c.id)).map((x) => x.id)).not.toContain(drop.id);
      await expect(repo.deleteComment(c.code, drop.id)).rejects.toThrow(`Comment ${drop.id} not found on task CMT-M2-T1`);
      await expect(repo.deleteComment(c.code, "../x")).rejects.toBeInstanceOf(repo.NotFoundError);
      await expect(repo.deleteComment("CMT-M2-T9", keep.id)).rejects.toThrow("Task CMT-M2-T9 not found");
    });

    it("won't delete a comment through another task (even in a different milestone)", async () => {
      const mine = await repo.addComment(a.id, "mine", "you");
      await expect(repo.deleteComment(c.code, mine.id)).rejects.toThrow(/not found on task CMT-M2-T1/);
      await expect(repo.deleteComment(b.code, mine.id)).rejects.toThrow(/not found on task CMT-M1-T2/);
      expect((await repo.listComments(a.id)).map((x) => x.id)).toContain(mine.id);
    });

    it("works on a project", async () => {
      await repo.createProject({ title: "Corp comments", code: "CCM", repos: ["github.com/corp/ccm"] });
      await repo.createMilestone({ title: "M", project: "CCM" });
      const [t] = await repo.createTasks([{ title: "T", milestone: "CCM-M1" }]);
      const comment = await repo.addComment(t.code, "internal note", "agent");
      expect(await repo.listComments(t.id)).toEqual([comment]);
      await repo.deleteComment(t.id, comment.id);
      expect(await repo.listComments(t.id)).toEqual([]);
    });
  });

  describe("lifecycle writes", () => {
    let seed: Record<string, unknown>;
    beforeAll(async () => {
      seed = YAML.parse(await readFile(new URL("./playbooks/sdlc.yaml", import.meta.url), "utf8"));
    });
    /** A project playbook for LW, compiled from sdlc. */
    const lw = (extra: Record<string, unknown> = {}) => ({
      ...seed,
      name: "LW",
      version: "1.0.0",
      layers: [{ name: "sdlc", version: "1.0.0" }],
      ...extra,
    });

    it("syncs a playbook version once, whatever its key order, and refuses changed content", async () => {
      const first = await repo.syncPlaybook(lw(), new Date("2026-09-28T09:00:00Z"));
      expect(first.created).toBe(true);
      expect(first.version).toMatchObject({ ref: "LW@1.0.0", name: "LW", version: "1.0.0", synced_at: "2026-09-28T09:00:00.000Z" });
      expect(first.version.hash).toMatch(/^[0-9a-f]{64}$/);
      const reordered = lw({ checks: Object.fromEntries(Object.entries(seed.checks as object).reverse()) });
      expect(await repo.syncPlaybook(reordered)).toEqual({ version: first.version, created: false });
      await expect(repo.syncPlaybook(lw({ software: "something else" }))).rejects.toThrow(
        "LW@1.0.0 is already stored with different content; versions never change, so release it as a new version",
      );
      await expect(repo.syncPlaybook({ name: "LW" })).rejects.toThrow();
    });

    it.each([
      { name: "company", layers: [{ name: "sdlc", version: "1.0.0" }] },
      { name: "ACME", layers: [{ name: "sdlc", version: "1.0.0" }, { name: "company", version: "1.0.0" }] },
    ])("PO-3.1 A playbook named company or with a layer named company is stored with its text ($name)", async ({ name, layers }) => {
      const input = lw({
        name,
        layers,
        environments: [{ name: "dev", db: "acme-dev", url: "https://dev.acme.test" }, { name: "prod" }],
      });
      const expected = Playbook.parse(input);
      const { version, created } = await repo.syncPlaybook(input);
      expect(created).toBe(true);
      expect(version.definition).toEqual(expected);
      expect(await backendRepo.getPlaybookVersion(`${name}@1.0.0`)).toEqual(version);

      const second = await repo.syncPlaybook(input);
      expect(second.created).toBe(false);
      expect(second.version).toEqual(version);
    });

    it("pins a project to a stored version and places its milestones on the lifecycle", async () => {
      await repo.createProject({ title: "LW", code: "LW" });
      expect((await repo.createMilestone({ title: "Old", project: "LW" })).stage).toBeUndefined();
      await expect(repo.setPlaybookVersion("LW", "LW@9.0.0")).rejects.toThrow("Playbook LW@9.0.0 isn't stored; sync it first");
      await expect(repo.setPlaybookVersion("LW", "LW")).rejects.toThrow(`"LW" isn't a playbook version like PMA@1.2.0`);
      await expect(repo.setPlaybookVersion("LW", "LW@1.0.0", { "LC-M1": "build" })).rejects.toThrow("LC-M1 isn't a milestone of LW");

      const { project, milestones } = await repo.setPlaybookVersion("LW", "LW@1.0.0", { "lw-m1": "release" });
      expect(project.playbook).toBe("LW@1.0.0");
      expect(milestones).toEqual([expect.objectContaining({ code: "LW-M1", stage: "release", status: "in_progress" })]);
      expect(await repo.getMilestone("LW-M1")).toMatchObject({ stage: "release", status: "in_progress" });
      expect((await repo.getProject("LW")).playbook).toBe("LW@1.0.0");
      // New milestones start at spec, or at idea when that's all they are.
      expect(await repo.createMilestone({ title: "Next", project: "LW" })).toMatchObject({ code: "LW-M2", stage: "spec", status: "planned" });
      expect(await repo.createMilestone({ title: "Maybe", project: "LW", status: "idea" })).toMatchObject({ stage: "idea", status: "idea" });
    });

    it("advances only when the current stage's checks pass, and moves back freely", async () => {
      await expect(repo.advanceStage("LW-M2")).rejects.toThrow(
        "LW-M2 can't leave spec yet. Open: spec.accepted. Pass them, or waive them with a reason.",
      );
      await expect(repo.advanceStage("LW-M2", "build")).rejects.toThrow("LW-M2 is in spec: it can move on to design, or back to an earlier stage");
      await expect(repo.setCheck("LW-M2", "spec.nope", "passed")).rejects.toThrow("spec.nope isn't a check of LW's playbook LW@1.0.0");
      await expect(repo.setCheck("LW-M2", "spec.accepted", "waived", "  ")).rejects.toThrow("A waiver needs a reason");

      const passed = await repo.setCheck("LW-M2", "spec.accepted", "passed", " https://docs.lw.test/spec ", "claude");
      expect(passed.checks["spec.accepted"]).toEqual({
        status: "passed",
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        by: "claude",
        note: "https://docs.lw.test/spec",
      });
      expect(await repo.advanceStage("LW-M2")).toMatchObject({ stage: "design", status: "planned" });
      await repo.setCheck("LW-M2", "design.decisions_recorded", "waived", "Nothing hard to reverse");
      expect(await repo.advanceStage("LW-M2")).toMatchObject({ stage: "plan" });
      await expect(repo.advanceStage("LW-M2")).rejects.toThrow("Open: plan.estimated: no tasks yet; plan.small_tasks: no tasks yet.");

      // Back to spec needs nothing; clearing a result reopens its check.
      expect(await repo.advanceStage("LW-M2", "spec")).toMatchObject({ stage: "spec", status: "planned" });
      expect((await repo.setCheck("LW-M2", "spec.accepted", "open")).checks["spec.accepted"]).toBeUndefined();
      expect(Object.keys((await repo.getMilestone("LW-M2")).checks)).toEqual(["design.decisions_recorded"]);
    });

    it("finishes after learn, through maintain when there are playbook changes", async () => {
      await repo.setPlaybookVersion("LW", "LW@1.0.0", { "LW-M3": "learn" });
      await repo.createTasks([{ title: "t", milestone: "LW-M3", estimate: 1 }]);
      await repo.logTime("LW-M3-T1", 0.5, undefined, true);
      await expect(repo.advanceStage("LW-M3")).rejects.toThrow("Open: learn.retro.");
      await repo.setCheck("LW-M3", "learn.retro", "passed");
      expect(await repo.advanceStage("LW-M3", "maintain")).toMatchObject({ stage: "maintain", status: "in_progress" });
      await expect(repo.advanceStage("LW-M3")).rejects.toThrow("Open: maintain.applied.");
      await repo.setCheck("LW-M3", "maintain.applied", "waived", "No changes after all");
      expect(await repo.advanceStage("LW-M3")).toMatchObject({ stage: "maintain", status: "done" });
      await expect(repo.advanceStage("LW-M3")).rejects.toThrow("LW-M3 is done");
    });

    it("records deployments in promotion order, or out of order with a reason", async () => {
      await expect(repo.recordDeployment("LW-M1", "qa")).rejects.toThrow("qa isn't an environment of LW (dev → staging → prod)");
      await expect(repo.recordDeployment("LW-M1", "prod")).rejects.toThrow("LW-M1 hasn't reached dev, staging yet");
      const hotfix = await repo.recordDeployment("LW-M1", "prod", { at: "2026-09-26", ref: "abc123", note: "hotfix" });
      expect(hotfix.deployments).toEqual({ prod: { at: "2026-09-26", ref: "abc123", note: "hotfix" } });
      const dev = await repo.recordDeployment("LW-M1", "dev", { url: "https://dev.lw.test" });
      expect(dev.deployments.dev).toEqual({ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), url: "https://dev.lw.test" });
      expect((await repo.getMilestone("LW-M1")).deployments).toEqual(dev.deployments);
      await expect(repo.recordDeployment("LC-M2", "dev")).rejects.toThrow("Milestone LC-M2 not found");
      await expect(repo.recordDeployment("WEB-M1", "dev")).rejects.toThrow("WEB has no playbook yet; pin one first");
    });

    it("stores normalized, unique repos and detectors on projects", async () => {
      const project = await repo.createProject({
        title: "Repos",
        code: "RP",
        repos: ["git@github.com:Acme/Billing.git", "https://github.com/acme/billing"],
      });
      expect(project).toMatchObject({ repos: ["github.com/acme/billing"] });
      await expect(repo.createProject({ title: "Dup", code: "RQ", repos: ["ssh://git@github.com/acme/billing"] })).rejects.toThrow(
        "github.com/acme/billing already belongs to project RP",
      );
      // LC took github.com/acme/api earlier.
      await expect(repo.updateProject("RP", { repos: ["github.com/acme/api"] })).rejects.toThrow("already belongs to project LC");
      const updated = await repo.updateProject("RP", {
        repos: ["https://token@github.com/acme/shop/"],
        detectors: ["Migrations", "migrations", "docker"],
      });
      expect(updated).toMatchObject({ repos: ["github.com/acme/shop"], detectors: ["migrations", "docker"] });
      await expect(repo.updateProject("RP", { detectors: ["no spaces"] })).rejects.toThrow("Detector names are lowercase");
      await expect(repo.updateProject("RP", { repos: ["not a remote"] })).rejects.toThrow(`"not a remote" isn't a git remote`);
    });
  });

  describe("users", () => {
    const hash = "scrypt$16384$8$1$c2FsdA$aGFzaA";

    it("creates a user and finds it by email, case-insensitively", async () => {
      expect(await repo.countUsers()).toBe(0);
      const user = await repo.createUser({ email: "  Me@Example.COM ", password_hash: hash });
      const today = todayIn((await repo.getSettings()).timezone);
      expect(user).toEqual({ id: "U-1", email: "me@example.com", password_hash: hash, created: today });
      expect(await repo.findUserByEmail("ME@example.com")).toEqual(user);
      expect(await repo.findUserByEmail(" me@example.com")).toEqual(user);
      expect(await repo.findUserByEmail("other@example.com")).toBeNull();
      expect(await repo.getUser("U-1")).toEqual(user);
      expect(await repo.getUser("u-1")).toEqual(user);
      expect(await repo.getUser("U-9")).toBeNull();
      expect(await repo.countUsers()).toBe(1);
      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, "users/U-1.md"), "utf8");
        expect(text).toBe(`---\nid: U-1\nemail: me@example.com\npassword_hash: ${hash}\ncreated: ${today}\n---\n`);
      }
    });

    it("returns null for a duplicate email and keeps the original", async () => {
      expect(await repo.createUser({ email: "ME@EXAMPLE.com", password_hash: "other" })).toBeNull();
      expect(await repo.countUsers()).toBe(1);
      expect((await repo.findUserByEmail("me@example.com"))?.password_hash).toBe(hash);
    });

    it("throws on an invalid email and writes nothing", async () => {
      for (const email of ["", "   ", "me", "me@example", "@example.com", "me@.com", "me @example.com", "me@exa mple.com", "a@b@c.com"]) {
        await expect(repo.createUser({ email, password_hash: hash })).rejects.toThrow("Invalid email address");
      }
      await expect(repo.createUser({ email: `${"a".repeat(250)}@b.co`, password_hash: hash })).rejects.toThrow("Invalid email address");
      expect(await repo.countUsers()).toBe(1);
    });

    it("increments ids", async () => {
      const two = await repo.createUser({ email: "two@example.com", password_hash: hash });
      const three = await repo.createUser({ email: "three@example.com", password_hash: hash });
      expect([two?.id, three?.id]).toEqual(["U-2", "U-3"]);
      expect(await repo.countUsers()).toBe(3);
      expect(await repo.getUser("3")).toEqual(three);
    });

    it("rejects a duplicate at the backend too", async () => {
      const draft = { email: "two@example.com", password_hash: "x", created: "2026-09-27" };
      expect(await backendRepo.insertUser(draft)).toBeNull();
      expect(await backendRepo.countUsers()).toBe(3);
    });

    it("keeps users out of the workspace", async () => {
      const records = await backendRepo.loadAll();
      expect(Object.keys(records).sort()).toEqual(["milestones", "playbooks", "problems", "projects", "tasks"]);
      expect(records.problems).toEqual([]);
      const ws = await repo.loadWorkspace();
      const ids = [...ws.tasks, ...ws.milestones, ...ws.projects].map((r) => r.id);
      expect(ids.filter((id) => id.startsWith("U-"))).toEqual([]);
      expect(JSON.stringify(await readAll(backendRepo))).not.toContain("example.com");
    });
  });

  describe("api keys", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const [h1, h2, h3] = [sha("one"), sha("two"), sha("three")];

    it("creates keys by hash and finds them by hash", async () => {
      expect(await repo.listApiKeys()).toEqual([]);
      const key = await repo.createApiKey({ label: "  laptop ", hash: h1 });
      const today = todayIn((await repo.getSettings()).timezone);
      expect(key).toEqual({ id: "K-1", label: "laptop", hash: h1, created: today });
      expect(await repo.findApiKeyByHash(h1)).toEqual(key);
      expect(await repo.findApiKeyByHash(h2)).toBeNull();
      expect(await repo.findApiKeyByHash("not-a-hash")).toBeNull();
      expect(await repo.getApiKey("k-1")).toEqual(key);
      expect(await repo.getApiKey("K-9")).toBeNull();
      expect(await repo.getApiKey("../users/U-1")).toBeNull();
      if (backend.dir) {
        const text = await readFile(path.join(backend.dir, "api_keys/K-1.md"), "utf8");
        expect(text).toBe(`---\nid: K-1\nlabel: laptop\nhash: ${h1}\ncreated: ${today}\n---\n`);
      }
    });

    it("rejects anything but a lowercase hex SHA-256 and writes nothing", async () => {
      for (const hash of ["", "abc", h2.toUpperCase(), `${h2}0`, h2.replace(/./, "g")]) {
        await expect(repo.createApiKey({ label: "x", hash })).rejects.toThrow("SHA-256");
      }
      expect((await repo.listApiKeys()).map((k) => k.id)).toEqual(["K-1"]);
    });

    it("lists keys by id number, with empty labels", async () => {
      const two = await repo.createApiKey({ label: "", hash: h2 });
      const three = await repo.createApiKey({ hash: h3 });
      expect([two.id, three.id, two.label, three.label]).toEqual(["K-2", "K-3", "", ""]);
      expect((await repo.listApiKeys()).map((k) => k.id)).toEqual(["K-1", "K-2", "K-3"]);
      expect(await repo.findApiKeyByHash(h3)).toEqual(three);
    });

    it("touches last_used_at", async () => {
      const at = new Date("2026-09-27T02:03:04.567Z");
      const touched = await repo.touchApiKey("K-2", at);
      expect(touched).toMatchObject({ id: "K-2", last_used_at: "2026-09-27T02:03:04.567Z" });
      expect(touched?.revoked_at).toBeUndefined();
      expect(await repo.findApiKeyByHash(h2)).toEqual(touched);
      expect(await repo.touchApiKey("K-99")).toBeNull();
    });

    it("revokes idempotently and keeps revoked keys listed", async () => {
      const at = new Date("2026-09-27T03:00:00.000Z");
      const revoked = await repo.revokeApiKey("2", at);
      expect(revoked).toMatchObject({ id: "K-2", last_used_at: "2026-09-27T02:03:04.567Z", revoked_at: at.toISOString() });
      expect(await repo.revokeApiKey("K-2", new Date("2026-10-01T00:00:00.000Z"))).toEqual(revoked);
      expect(await repo.getApiKey("K-2")).toEqual(revoked);
      expect(await repo.findApiKeyByHash(h2)).toEqual(revoked);
      expect(await repo.revokeApiKey("K-99")).toBeNull();
      expect(await repo.revokeApiKey("nope")).toBeNull();
      const list = await repo.listApiKeys();
      expect(list.map((k) => [k.id, Boolean(k.revoked_at)])).toEqual([["K-1", false], ["K-2", true], ["K-3", false]]);
    });

    it("touches only last_used_at, so a touch after a revoke keeps revoked_at", async () => {
      const revoked = (await repo.getApiKey("K-2"))!;
      expect(revoked.revoked_at).toBe("2026-09-27T03:00:00.000Z");
      const at = new Date("2026-09-27T04:05:06.789Z");
      const touched = await repo.touchApiKey("K-2", at);
      expect(touched).toEqual({ ...revoked, last_used_at: at.toISOString() });
      expect(await repo.getApiKey("K-2")).toEqual(touched);
      expect(await repo.findApiKeyByHash(h2)).toEqual(touched);
      // Straight to the repository too, and junk ids never reach it.
      expect(await backendRepo.touchApiKey("K-99", at.toISOString())).toBeNull();
      expect(await repo.touchApiKey("../users/U-1", at)).toBeNull();
    });

    it("stores the owning user and lists an account's keys", async () => {
      const [u1, u2] = [(await repo.findUserByEmail("me@example.com"))!, (await repo.findUserByEmail("two@example.com"))!];
      const mine = await repo.createApiKey({ label: "web", hash: sha("mine"), user_id: u1.id });
      const theirs = await repo.createApiKey({ hash: sha("theirs"), user_id: u2.id.toLowerCase() });
      expect(mine.user_id).toBe(u1.id);
      expect(theirs.user_id).toBe(u2.id);
      expect(await repo.findApiKeyByHash(sha("mine"))).toEqual(mine);
      expect((await repo.listUserApiKeys(u1.id)).map((k) => k.id)).toEqual([mine.id]);
      expect((await repo.listUserApiKeys(u2.id)).map((k) => k.id)).toEqual([theirs.id]);
      // CLI keys (no owner) belong to no account.
      expect((await repo.getApiKey("K-1"))?.user_id).toBeUndefined();
      // Revoking and touching keep the owner.
      const revoked = await repo.revokeApiKey(mine.id, new Date("2026-09-27T05:00:00.000Z"));
      expect(revoked?.user_id).toBe(u1.id);
      expect((await repo.touchApiKey(mine.id))?.user_id).toBe(u1.id);
    });

    it("keeps API keys out of the workspace", async () => {
      const records = await backendRepo.loadAll();
      expect(Object.keys(records).sort()).toEqual(["milestones", "playbooks", "problems", "projects", "tasks"]);
      expect(records.problems).toEqual([]);
      const dump = JSON.stringify(await readAll(backendRepo));
      for (const hash of [h1, h2, h3]) expect(dump).not.toContain(hash);
      expect(dump).not.toContain('"K-');
    });
  });
});

describe("normalizeRepo", () => {
  it("reads every common remote form as host/owner/repo", () => {
    for (const remote of [
      "https://github.com/Owner/Repo.git",
      "http://github.com/owner/repo/",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo",
      "https://user:token@github.com/owner/repo",
      "github.com/owner/repo",
      "https://www.github.com/Owner/Repo.git",
      "www.github.com/owner/repo",
      "git@www.github.com:owner/repo.git",
    ]) {
      expect(repo.normalizeRepo(remote)).toBe("github.com/owner/repo");
    }
    expect(repo.normalizeRepo("ssh://git@gitlab.acme.test:2222/team/app.git")).toBe("gitlab.acme.test:2222/team/app");
    expect(repo.normalizeRepo("https://dev.azure.com/org/project/_git/repo")).toBe("dev.azure.com/org/project/_git/repo");
    expect(repo.normalizeRepo("https://www.gitlab.com/o/r")).toBe("www.gitlab.com/o/r"); // only github.com drops www.
    for (const bad of ["", "repo", "https://", "not a remote"]) expect(() => repo.normalizeRepo(bad)).toThrow();
  });
});

describe("normalizePr", () => {
  it("accepts short form owner/repo#number", () => {
    expect(repo.normalizePr("owner/repo#123")).toBe("owner/repo#123");
    expect(repo.normalizePr("Owner/Repo#456")).toBe("owner/repo#456");
    expect(repo.normalizePr("my-owner/my-repo#1")).toBe("my-owner/my-repo#1");
    expect(repo.normalizePr("  owner/repo#789  \n")).toBe("owner/repo#789");
  });

  it("accepts full GitHub PR URLs with various schemes and formats", () => {
    for (const url of [
      "https://github.com/owner/repo/pull/123",
      "https://github.com/Owner/Repo/pull/456",
      "http://github.com/owner/repo/pull/789",
      "github.com/owner/repo/pull/123",
      "www.github.com/owner/repo/pull/456",
      "https://www.github.com/owner/repo/pull/789",
    ]) {
      expect(repo.normalizePr(url)).toMatch(/^owner\/repo#\d+$/);
    }
  });

  it("handles PR URLs with trailing paths, query strings, and fragments", () => {
    expect(repo.normalizePr("https://github.com/owner/repo/pull/123/files")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://github.com/owner/repo/pull/123/commits")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://github.com/owner/repo/pull/123?tab=files")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://github.com/owner/repo/pull/123#discussion_123")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://github.com/owner/repo/pull/123/")).toBe("owner/repo#123");
  });

  it("handles user credentials in URLs", () => {
    expect(repo.normalizePr("https://user:password@github.com/owner/repo/pull/123")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://token@github.com/owner/repo/pull/123")).toBe("owner/repo#123");
  });

  it("lowercases owner/repo but preserves number", () => {
    expect(repo.normalizePr("Owner/Repo#123")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://github.com/MyOwner/MyRepo/pull/999")).toBe("myowner/myrepo#999");
  });

  it("handles uppercase scheme and host", () => {
    expect(repo.normalizePr("HTTPS://GITHUB.COM/owner/repo/pull/123")).toBe("owner/repo#123");
    expect(repo.normalizePr("https://GitHub.Com/owner/repo/pull/456")).toBe("owner/repo#456");
    expect(repo.normalizePr("HTTP://github.com/owner/repo/pull/789")).toBe("owner/repo#789");
  });

  it("handles .git suffix in short form (normalizeRepo strips it)", () => {
    expect(repo.normalizePr("owner/repo.git#123")).toBe("owner/repo#123");
  });

  it("rejects empty strings", () => {
    expect(() => repo.normalizePr("")).toThrow("cannot be empty");
    expect(() => repo.normalizePr("  \n  ")).toThrow("cannot be empty");
  });

  it("rejects non-numeric PR numbers", () => {
    expect(() => repo.normalizePr("owner/repo#abc")).toThrow();
    expect(() => repo.normalizePr("owner/repo#")).toThrow();
    expect(() => repo.normalizePr("https://github.com/owner/repo/pull/abc")).toThrow();
  });

  it("rejects PR numbers with leading zeros", () => {
    expect(() => repo.normalizePr("owner/repo#0123")).toThrow();
    expect(() => repo.normalizePr("owner/repo#00")).toThrow();
  });

  it("rejects PR number zero", () => {
    expect(() => repo.normalizePr("owner/repo#0")).toThrow();
    expect(() => repo.normalizePr("https://github.com/owner/repo/pull/0")).toThrow();
  });

  it("rejects PR numbers longer than 9 digits", () => {
    expect(() => repo.normalizePr("owner/repo#1234567890")).toThrow();
    expect(() => repo.normalizePr("owner/repo#9999999999")).toThrow();
    expect(() => repo.normalizePr("https://github.com/owner/repo/pull/1234567890")).toThrow();
  });

  it("rejects GitHub issues (not pull requests)", () => {
    expect(() => repo.normalizePr("https://github.com/owner/repo/issues/123")).toThrow(/issues/);
    expect(() => repo.normalizePr("https://github.com/owner/repo/issues/456/")).toThrow(/issues/);
  });

  it("rejects /pulls/ instead of /pull/", () => {
    expect(() => repo.normalizePr("https://github.com/owner/repo/pulls/123")).toThrow();
  });

  it("rejects non-github.com hosts", () => {
    expect(() => repo.normalizePr("https://gitlab.com/owner/repo/pull/123")).toThrow(/GitHub/);
    expect(() => repo.normalizePr("https://github.example.com/owner/repo/pull/123")).toThrow(/GitHub/);
    expect(() => repo.normalizePr("https://github.com.evil.com/owner/repo/pull/123")).toThrow(/GitHub/);
    expect(() => repo.normalizePr("https://bitbucket.org/owner/repo/pull/123")).toThrow(/GitHub/);
  });

  it("rejects host smuggling via query string (?@)", () => {
    expect(() => repo.normalizePr("https://evil.com?x=@github.com/a/b/pull/1")).toThrow();
  });

  it("rejects host smuggling via fragment (#@)", () => {
    expect(() => repo.normalizePr("https://evil.com#@github.com/a/b/pull/1")).toThrow();
  });

  it("rejects ports", () => {
    expect(() => repo.normalizePr("https://github.com:8080/owner/repo/pull/123")).toThrow(/port/i);
    expect(() => repo.normalizePr("github.com:2222/owner/repo/pull/123")).toThrow();
  });

  it("rejects non-HTTP(S) schemes", () => {
    expect(() => repo.normalizePr("ssh://git@github.com/owner/repo/pull/123")).toThrow(/HTTP/);
    expect(() => repo.normalizePr("git://github.com/owner/repo/pull/123")).toThrow(/HTTP/);
    expect(() => repo.normalizePr("ftp://github.com/owner/repo/pull/123")).toThrow(/HTTP/);
  });

  it("rejects extra path segments before /pull/", () => {
    expect(() => repo.normalizePr("https://github.com/x/a/b/pull/1")).toThrow(); // 3 segments instead of 2
    expect(() => repo.normalizePr("https://github.com/a/b/blob/x/pull/1")).toThrow(); // /blob/ before /pull/
  });

  it("rejects malformed PR path numbers (pull/1abc)", () => {
    expect(() => repo.normalizePr("https://github.com/owner/repo/pull/1abc")).toThrow();
    expect(() => repo.normalizePr("owner/repo#1abc")).toThrow();
  });

  it("rejects multiple hash symbols", () => {
    expect(() => repo.normalizePr("a/b#1#2")).toThrow(); // only first # counts in regex
    // Technically this might match as a/b#1 due to regex, let's verify
  });

  it("rejects invalid owner/repo formats", () => {
    expect(() => repo.normalizePr("owner#123")).toThrow(); // missing repo
    expect(() => repo.normalizePr("owner/repo/extra#123")).toThrow(); // too many segments
    expect(() => repo.normalizePr("https://github.com/owner/repo")).toThrow(); // missing /pull/number
    expect(() => repo.normalizePr("https://github.com/owner/repo/pull")).toThrow(); // missing number
  });

  it("rejects junk input", () => {
    expect(() => repo.normalizePr("not a pr")).toThrow();
    expect(() => repo.normalizePr("owner/repo/pull/123")).toThrow(); // missing github.com
    expect(() => repo.normalizePr("random text #123")).toThrow();
  });
});

describe("email helpers", () => {
  it("normalizes and validates", () => {
    expect(repo.normalizeEmail("  Me@Example.COM\n")).toBe("me@example.com");
    expect(repo.isValidEmail("a@b.co")).toBe(true);
    expect(repo.isValidEmail("first.last+tag@sub.example.com")).toBe(true);
    expect(repo.isValidEmail(" a@b.co")).toBe(false);
    expect(repo.isValidEmail("a@b")).toBe(false);
    expect(repo.isValidEmail(`${"a".repeat(249)}@b.com`)).toBe(false);
    expect(repo.isValidEmail(`${"a".repeat(248)}@b.com`)).toBe(true);
  });
});

describe("postgres specifics", () => {
  const task = (milestone: string, number: number, code = `PP-M1-T${number}`): Task => ({
    id: newId(),
    code,
    number,
    title: code,
    status: "todo",
    milestone,
    spent: 0,
    depends_on: [],
    tags: [],
    prs: [],
    created: "2026-09-27",
    body: "",
  });

  it("rolls back a whole task batch when the database rejects one row", async () => {
    const pg = await pglite();
    setRepository(pg);
    await repo.createProject({ title: "P", code: "PP" });
    const milestone = await repo.createMilestone({ title: "M", project: "PP" });
    await expect(pg.insert({ tasks: [task(milestone.id, 1), task(newId(), 2)] })).rejects.toThrow();
    expect((await pg.loadAll()).tasks).toEqual([]);
  });

  it("only pins projects to stored playbook versions, and only takes lifecycle stages", async () => {
    const pg = await pglite();
    setRepository(pg);
    const project = await repo.createProject({ title: "P", code: "PP" });
    const milestone = await repo.createMilestone({ title: "M", project: "PP" });
    await expect(pg.save({ projects: [{ ...project, playbook: "sdlc@1.0.0" }] })).rejects.toThrow();
    await pg.insertPlaybookVersion(await sdlcVersion());
    await pg.save({ projects: [{ ...project, playbook: "sdlc@1.0.0" }] });
    expect((await repo.getProject("PP")).playbook).toBe("sdlc@1.0.0");
    const bad = { ...milestone, stage: "shipping" } as unknown as typeof milestone;
    await expect(pg.save({ milestones: [bad] })).rejects.toThrow();
  });

  it("enforces unique codes and unique numbers per milestone", async () => {
    const pg = await pglite();
    setRepository(pg);
    await repo.createProject({ title: "P", code: "PP" });
    const milestone = await repo.createMilestone({ title: "M", project: "PP" });
    await pg.insert({ tasks: [task(milestone.id, 1)] });
    await expect(pg.insert({ tasks: [task(milestone.id, 1, "PP-M1-T7")] })).rejects.toThrow();
    await expect(pg.insert({ tasks: [task(milestone.id, 2, "PP-M1-T1")] })).rejects.toThrow();
    await expect(pg.insert({ tasks: [task(milestone.id, 3, "pp-m1-t3")] })).rejects.toThrow();
    expect((await pg.loadAll()).tasks.map((t) => t.code)).toEqual(["PP-M1-T1"]);
  });
});

describe("import / export", () => {
  let source: FileRepository;
  let comments: TaskComment[];
  const SNAPSHOTS: GithubSnapshot[] = [
    {
      key: "pr:acme/px#7",
      data: { title: "Add", body: "Body\n\n- [ ] item", state: "merged", merged_at: "2026-09-28T10:00:00Z", milestone: null, reviewers: [] },
      fetched_at: "2026-09-28T10:00:01.000Z",
      last_attempt_at: "2026-09-29T00:00:00.000Z",
      last_error: { reason: "github_down", status: 502, message: "Bad Gateway", request_id: null },
    },
    { key: "pr:acme/px#8", last_attempt_at: "2026-09-29T00:00:00.000Z", last_error: { reason: "rate_limited" }, retry_after: "2026-09-29T01:00:00.000Z" },
    { key: "repo:acme/px", data: [], fetched_at: "2026-09-29T00:00:00.000Z" },
  ];

  beforeAll(async () => {
    const dir = await tempDir();
    source = new FileRepository(new FsStore(dir));
    setRepository(source);
    await repo.updateSettings({ timezone: "Asia/Ho_Chi_Minh" });
    await repo.createProject({ title: "P", code: "PX", deadline: "2026-12-01", description: "Goal" });
    await repo.createMilestone({ title: "F", project: "PX", priority: "P1" });
    await repo.createTasks([
      { ref: "a", title: "A", milestone: "PX-M1", pert: { optimistic: 1, likely: 2, pessimistic: 4 }, tags: ["x"], depends_on: ["b"] },
      { ref: "b", title: "B", milestone: "PX-M1", estimate: 3, not_before: "2026-10-01" },
      { title: "C", milestone: "PX-M1", estimate: 1, status: "blocked" },
    ]);
    await repo.logTime("PX-M1-T2", 1, "started");
    await repo.reorderTasks(["PX-M1-T3", "PX-M1-T1"]);
    // Leave a gap in the numbers: T-5 moves to another milestone, T-4 and T-6 stay.
    await repo.createMilestone({ title: "G", project: "PX" });
    await repo.createTasks(["D", "E", "F"].map((title) => ({ title, milestone: "PX-M1" })));
    await repo.updateTask("PX-M1-T5", { milestone: "PX-M2" });
    // Lifecycle data travels with everything else.
    await source.insertPlaybookVersion(await sdlcVersion());
    await source.insertPlaybookVersion(await sdlcVersion("1.1.0"));
    const px = await repo.getProject("PX");
    await source.save({ projects: [{ ...px, context: "legacy", playbook: "sdlc@1.0.0", repos: ["github.com/acme/px"], detectors: ["migrations"] } as unknown as import("./types").Project] });
    const m1 = await repo.getMilestone("PX-M1");
    await source.save({
      milestones: [
        {
          ...m1,
          stage: "release",
          checks: { "spec.accepted": { status: "passed", at: "2026-09-20" }, "verify.review": { status: "failed", at: "2026-09-25", note: "2 findings" } },
          deployments: { dev: { at: "2026-09-27", ref: "abc" } },
        },
      ],
    });
    // So do PR references, GitHub snapshots and comments.
    // Write a manual legacy context to simulate an old expor
    const pxFile = path.join((source as unknown as { store: { root: string } }).store.root, `projects/${px.id}.md`);
    const oldContent = await readFile(pxFile, "utf8");
    await writeFile(pxFile, oldContent.replace("code: PX\n", "code: PX\ncontext: personal\n"));

    const t1 = await repo.getTask("PX-M1-T1");
    await source.save({ tasks: [{ ...t1, prs: ["acme/px#7", "acme/px#8"] }] });
    for (const snapshot of SNAPSHOTS) await source.upsertGithubSnapshot(snapshot);
    const t2 = await repo.getTask("PX-M1-T2");
    comments = [
      { id: newId(), task_id: t1.id, author: "you", created_at: "2026-09-29T01:00:00.000Z", body: "review PR 412,\ncheck the migration\n" },
      { id: newId(), task_id: t1.id, author: "agent", created_at: "2026-09-29T01:00:00.500Z", body: "  <b>done</b>" },
      { id: newId(), task_id: t2.id, author: "you", created_at: "2026-09-28T23:59:59.999Z", body: "#1 first" },
    ];
    for (const comment of comments) await source.insertComment(comment);
    // Users are never transferred.
    await repo.createUser({ email: "me@example.com", password_hash: "hash" });
    // Nor are API keys.
    await repo.createApiKey({ label: "agent", hash: "a".repeat(64) });
  });

  it("PO-1.4 imports markdown into Postgres with identical workspace and schedule, and continues numbering", async () => {
    const pg = await pglite();
    await importInto(pg, source);
    expect(await compareBackends(source, pg)).toEqual([]);
    expect((await pg.loadAll()).playbooks.map((v) => v.ref).sort()).toEqual(["sdlc@1.0.0", "sdlc@1.1.0"]);
    expect((await pg.getProject({ code: "PX" }))?.playbook).toBe("sdlc@1.0.0");
    expect(await pg.countUsers()).toBe(0);
    expect(await pg.listApiKeys()).toEqual([]);
    expect("context" in (await pg.getProject({ code: "PX" }))!).toBe(false);
    expect(await readFile(path.join((source as unknown as { store: { root: string } }).store.root, `projects/${(await pg.getProject({ code: "PX" }))!.id}.md`), "utf8")).toContain("context: personal");

    await expect(importInto(pg, source)).rejects.toThrow("not empty");
    const user = await pg.insertUser({ email: "pg@example.com", password_hash: "hash", created: "2026-09-27" });
    const key = await pg.insertApiKey({ label: "pg", hash: "b".repeat(64), created: "2026-09-27" });
    await importInto(pg, source, { replace: true });
    expect(await compareBackends(source, pg)).toEqual([]);
    expect(await pg.getUser("U-1")).toEqual(user);
    expect(await pg.listApiKeys()).toEqual([key]);
    expect(await pg.countUsers()).toBe(1);

    setRepository(pg);
    const [next] = await repo.createTasks([{ title: "after import", milestone: "px-m1" }]);
    expect(next.code).toBe("PX-M1-T7");
    expect((await repo.createMilestone({ title: "F2", project: "PX" })).code).toBe("PX-M3");
    expect((await repo.createProject({ title: "P2", code: "PY" })).code).toBe("PY");
  });

  it("round-trips: markdown → Postgres → markdown", async () => {
    const pg = await pglite();
    await importInto(pg, source);
    const exported = new FileRepository(new FsStore(await tempDir()));
    await exportTo(exported, pg);
    expect(await compareBackends(source, exported)).toEqual([]);
    // PR references, snapshots and comments made it both ways.
    expect((await exported.getTask({ code: "PX-M1-T1" }))?.prs).toEqual(["acme/px#7", "acme/px#8"]);
    const carried = await exported.loadSnapshotsAndComments();
    expect(carried.snapshots).toEqual(SNAPSHOTS);
    expect(carried.comments).toEqual((await source.loadSnapshotsAndComments()).comments);
    expect(carried.comments).toHaveLength(3);
    expect(await exported.listComments(comments[0].task_id)).toEqual([comments[0], comments[1]]);
    expect(await pg.getGithubSnapshot("pr:acme/px#8")).toEqual(SNAPSHOTS[1]);
    // And the comparison notices when they differ.
    await exported.deleteComment(comments[2].task_id, comments[2].id);
    await exported.upsertGithubSnapshot({ ...SNAPSHOTS[1], retry_after: undefined });
    expect(await compareBackends(source, exported)).toEqual(["snapshot pr:acme/px#8: retry_after differ", "comment: ids or order differ"]);
    expect(await exported.getPlaybookVersion("sdlc@1.1.0")).toEqual(await source.getPlaybookVersion("sdlc@1.1.0"));
    expect(await exported.countUsers()).toBe(0);
    expect(await exported.listApiKeys()).toEqual([]);
  });
});


describe("PO-1.1 and PO-1.3", () => {
  it("PO-1.1 createProject and updateProject have no context, loadWorkspace returns none", async () => {
    const pg = await pglite();
    setRepository(pg);
    const p = await repo.createProject({ title: "PO11", code: "PO11" });
    expect("context" in p).toBe(false);
    const p2 = await repo.updateProject("PO11", { title: "PO11b" });
    expect("context" in p2).toBe(false);
    const l = await repo.loadWorkspace().then(w => w.projects);
    expect(l.some(proj => "context" in proj)).toBe(false);
  });

  it("PO-1.3 a project file with a leftover context key loads, and loses the key on next write", async () => {
    const dir = await tempDir();
    const store = new FsStore(dir);
    const fileRepo = new FileRepository(store);
    setRepository(fileRepo);
    await mkdir(path.join(dir, "projects"), { recursive: true });

    const pid = newId();
    await writeFile(
      path.join(dir, "projects", `${pid}.md`),
      `---\nid: ${pid}\ncode: PO13\ntitle: PO13\ncontext: legacy\ncreated: 2026-09-01\nrepos: []\ndetectors: []\n---\n\n`
    );

    const p = await repo.getProject("PO13");
    expect(p).toBeDefined();
    expect("context" in p!).toBe(false);
    await repo.updateProject("PO13", { title: "Updated" });

    const raw = await readFile(path.join(dir, "projects", `${pid}.md`), "utf8");
    expect(raw).not.toContain("context:");
  });
});
