import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@neondatabase/serverless";
import { revalidatePath } from "next/cache";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRecordAction } from "@/app/actions";
import { SESSION_COOKIE } from "./auth";
import { SESSION_TTL_SECONDS, signJwt } from "./auth/jwt";
import { neonDb, type Db, type Row } from "./db";
import { inheritedPriority } from "./hierarchy";
import { migrate, type MigrationSession } from "./migrate";
import { saveEditedRecord } from "./record-edit";
import { EDITABLE_KEYS, toEditable, type RecordKind } from "./record-markdown";
import * as repo from "./repo";
import { setRepository, type Repository } from "./repository";
import { FileRepository } from "./repository/file";
import { PgRepository } from "./repository/postgres";
import { FsStore } from "./store/fs";
import type { Milestone, Project, Task } from "./types";

/**
 * Markdown edits (record-markdown.ts) saved through saveEditedRecord and the repository, on every backend:
 * what's stored afterwards, and that a refused edit writes nothing. Then the same through the server action
 * (saveRecordAction in src/app/actions.ts), with Next's request APIs stubbed below.
 */

// The request saveRecordAction sees through next/headers; each test sets what it needs.
const request = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
  }),
  headers: async () => request.headers,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const tempDirs: string[] = [];
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

/**
 * A real Neon database, only when TEST_DATABASE_URL points at a disposable branch. vitest runs files in parallel and
 * repo.test.ts wipes and fills that URL's database meanwhile, so this suite uses a sibling database on the same
 * branch (created on first use, wiped first).
 */
async function neonTestDb(url: string): Promise<PgRepository> {
  const own = new URL(url);
  const name = `${decodeURIComponent(own.pathname.slice(1)) || "neondb"}_record_edit`;
  own.pathname = `/${encodeURIComponent(name)}`;
  const admin = new Client(url);
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rows.length === 0) await admin.query(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  const client = new Client(own.href);
  await client.connect();
  const session: MigrationSession = {
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async (text, params) => (await client.query(text, params)).rows,
  };
  try {
    await migrate(session);
    await session.exec("truncate tasks, milestones, projects, playbook_versions, settings, users, api_keys restart identity");
  } finally {
    await client.end();
  }
  return new PgRepository(neonDb(own.href));
}

const backends: { name: string; setup: () => Promise<Repository> }[] = [
  {
    name: "fs",
    async setup() {
      const dir = await mkdtemp(path.join(tmpdir(), "my-pm-edit-it-"));
      tempDirs.push(dir);
      return new FileRepository(new FsStore(dir));
    },
  },
  { name: "postgres (pglite)", setup: pglite },
];
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) backends.push({ name: "postgres (neon)", setup: () => neonTestDb(testDatabaseUrl) });

interface Records {
  task: Task;
  milestone: Milestone;
  project: Project;
}

const load = <K extends RecordKind>(kind: K, ref: string) =>
  (kind === "task" ? repo.getTask(ref) : kind === "milestone" ? repo.getMilestone(ref) : repo.getProject(ref)) as Promise<Records[K]>;

/** A record and the markdown an editor would open it with. */
async function opened<K extends RecordKind>(kind: K, ref: string) {
  const [record, ws] = await Promise.all([load(kind, ref), repo.loadWorkspace()]);
  return { record, text: toEditable(kind, record, ws) };
}

/** Everything a save could touch, codes and number counters included. */
async function snapshot() {
  const { projects, milestones, tasks } = await repo.loadWorkspace();
  return { projects, milestones, tasks };
}

/**
 * `text` with frontmatter fields set (`value` is the text after `key: `) or removed (null), kept in toEditable's key
 * order, and with the body replaced when `body` is given.
 */
function edit(kind: RecordKind, text: string, fields: Record<string, string | null>, body?: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`no frontmatter in:\n${text}`);
  const lines = new Map(match[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")), line]));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) lines.set(key, `${key}: ${value}`);
    else if (!lines.delete(key)) throw new Error(`no "${key}" to remove in:\n${text}`);
  }
  const frontmatter = EDITABLE_KEYS[kind].filter((key) => lines.has(key)).map((key) => lines.get(key));
  const rest = body === undefined ? text.slice(match[0].length) : body ? `\n${body}\n` : "";
  return `---\n${frontmatter.join("\n")}\n---\n${rest}`;
}

/**
 * Opens `ref`, applies `edit` to its markdown and saves it; expects the save to succeed and the reloaded record to
 * serialize back to exactly the saved text (edits here are written in toEditable's own form).
 */
async function roundTrip<K extends RecordKind>(kind: K, ref: string, edit: (text: string) => string) {
  const { record, text } = await opened(kind, ref);
  const edited = edit(text);
  expect(edited).not.toBe(text);
  const result = await saveEditedRecord(kind, record.id, text, edited);
  const after = await opened(kind, record.id);
  expect(result).toEqual({ ok: true, code: after.record.code, changed: true });
  expect(after.text).toBe(edited);
  return { before: record, saved: after.record, code: result.ok ? result.code : "" };
}

/** Opens `ref`, saves `edit(text)` (against `base` if given) and expects a refusal that writes nothing. */
async function refused<K extends RecordKind>(kind: K, ref: string, edit: (text: string) => string, base?: string) {
  const { record, text } = await opened(kind, ref);
  const before = await snapshot();
  const result = await saveEditedRecord(kind, record.id, base ?? text, edit(text));
  expect(result.ok).toBe(false);
  expect(await snapshot()).toEqual(before);
  return result.ok ? "" : result.errors.join("\n");
}

describe.each(backends)("saving edited markdown, $name backend", (backend) => {
  beforeAll(async () => {
    setRepository(await backend.setup());
    await repo.createProject({ title: "Editing", code: "ED", priority: "P1", description: "Goal: edit as markdown." });
    await repo.createProject({ title: "Other", code: "OTH", priority: "P3" });
    await repo.createMilestone({ title: "One", project: "ED", priority: "P2" });
    await repo.createMilestone({ title: "Two", project: "ED" });
    await repo.createMilestone({ title: "Existing", project: "OTH" });
    await repo.createTasks([
      { ref: "a", title: "Write it", milestone: "ED-M1", pert: { optimistic: 1, likely: 2, pessimistic: 3 }, tags: ["docs"] },
      { ref: "b", title: "Test it", milestone: "ED-M1", estimate: 1, depends_on: ["a"] },
      { title: "Ship it", milestone: "ED-M1", estimate: 1, depends_on: ["b"] },
    ]);
  });

  describe("round trips", () => {
    it("task: title, status, priority (set, then removed → inherited), deadline (set, then cleared), body", async () => {
      const first = await roundTrip("task", "ED-M1-T1", (text) =>
        edit("task", text, { title: "Write the docs", status: "in_progress", priority: "P0", deadline: "2026-11-30" }, "## Done when\n\n- [ ] README"),
      );
      expect(first.saved).toMatchObject({ code: "ED-M1-T1", title: "Write the docs", status: "in_progress", priority: "P0", deadline: "2026-11-30", body: "## Done when\n\n- [ ] README" });
      expect(first.saved.completed).toBeUndefined();

      const second = await roundTrip("task", "ED-M1-T1", (text) => edit("task", text, { priority: null, deadline: null, status: "done" }, ""));
      expect(second.saved).toMatchObject({ status: "done", body: "" });
      expect(second.saved.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(second.saved.priority).toBeUndefined();
      expect(second.saved.deadline).toBeUndefined();
      const [milestone, project] = await Promise.all([repo.getMilestone("ED-M1"), repo.getProject("ED")]);
      expect(inheritedPriority(second.saved.priority, milestone.priority, project.priority)).toBe("P2");
      // Untouched fields stay as they were, the three-point range included.
      expect(second.saved).toMatchObject({ estimate: 2, estimate_range: [1, 3], tags: ["docs"], spent: 0 });

      const reopened = await roundTrip("task", "ED-M1-T1", (text) => edit("task", text, { status: "todo" }));
      expect(reopened.saved.completed).toBeUndefined();
    });

    it("task: estimate, tags, depends_on by codes, not_before", async () => {
      const { saved } = await roundTrip("task", "ED-M1-T3", (text) =>
        edit("task", text, { estimate: "4.5", tags: "[release, ops]", depends_on: "[ED-M1-T2, ED-M1-T1]", not_before: "2026-10-05" }),
      );
      const [t1, t2] = await Promise.all([repo.getTask("ED-M1-T1"), repo.getTask("ED-M1-T2")]);
      expect(saved).toMatchObject({ estimate: 4.5, tags: ["release", "ops"], depends_on: [t2.id, t1.id], not_before: "2026-10-05" });

      // A changed estimate replaces a three-point range.
      const ranged = await roundTrip("task", "ED-M1-T1", (text) => edit("task", text, { estimate: "3" }));
      expect(ranged.saved.estimate).toBe(3);
      expect(ranged.saved.estimate_range).toBeUndefined();

      const cleared = await roundTrip("task", "ED-M1-T3", (text) => edit("task", text, { tags: null, depends_on: "[ED-M1-T2]", not_before: null }));
      expect(cleared.saved).toMatchObject({ tags: [], depends_on: [t2.id] });
      expect(cleared.saved.not_before).toBeUndefined();
    });

    it("milestone: title, status, priority (set, then removed → inherited), deadline (set, then cleared), spec", async () => {
      const first = await roundTrip("milestone", "ED-M2", (text) =>
        edit("milestone", text, { title: "Second", status: "in_progress", priority: "P0", deadline: "2026-12-15" }, "## Spec\n\nThe second half."),
      );
      expect(first.saved).toMatchObject({ code: "ED-M2", title: "Second", status: "in_progress", priority: "P0", deadline: "2026-12-15", body: "## Spec\n\nThe second half." });

      const second = await roundTrip("milestone", "ED-M2", (text) => edit("milestone", text, { priority: null, deadline: null }));
      expect(second.saved.priority).toBeUndefined();
      expect(second.saved.deadline).toBeUndefined();
      expect(inheritedPriority(second.saved.priority, (await repo.getProject("ED")).priority)).toBe("P1");
      expect(second.saved).toMatchObject({ number: 2, last_task_number: 0, body: "## Spec\n\nThe second half." });
    });

    it("project: title, status, priority, deadline (set, then cleared), description", async () => {
      const first = await roundTrip("project", "ED", (text) =>
        edit("project", text, { title: "Editing records", status: "on_hold", priority: "P0", deadline: "2027-01-31" }, "Goal: edit anything as markdown."),
      );
      expect(first.saved).toMatchObject({ code: "ED", title: "Editing records", status: "on_hold", priority: "P0", deadline: "2027-01-31", body: "Goal: edit anything as markdown." });

      const second = await roundTrip("project", "ED", (text) => edit("project", text, { status: "active", priority: "P1", deadline: null }));
      expect(second.saved).toMatchObject({ status: "active", priority: "P1", last_milestone_number: 2 });
      expect(second.saved.deadline).toBeUndefined();

      // A project always has a priority: its milestones and tasks inherit it.
      expect(await refused("project", "ED", (text) => edit("project", text, { priority: null }))).toContain(`"priority" can't be removed from a project`);
    });
  });

  describe("moves and renames", () => {
    it("task → another milestone: renumbered there, the new code returned and stored, dependents follow", async () => {
      const { before, saved, code } = await roundTrip("task", "ED-M1-T2", (text) => edit("task", text, { milestone: "ED-M2" }));
      expect(code).toBe("ED-M2-T1");
      const target = await repo.getMilestone("ED-M2");
      expect(saved).toMatchObject({ id: before.id, code: "ED-M2-T1", number: 1, milestone: target.id, depends_on: before.depends_on });
      expect(target.last_task_number).toBe(1);
      await expect(repo.getTask("ED-M1-T2")).rejects.toThrow("Task ED-M1-T2 not found");
      expect((await opened("task", "ED-M1-T3")).text).toContain("depends_on: [ED-M2-T1]");
      // The old number isn't handed out again.
      const [next] = await repo.createTasks([{ title: "After the move", milestone: "ED-M1" }]);
      expect(next.code).toBe("ED-M1-T4");
    });

    it("milestone → another project: renumbered there, its tasks' codes follow", async () => {
      const { before, saved, code } = await roundTrip("milestone", "ED-M2", (text) => edit("milestone", text, { project: "OTH" }));
      expect(code).toBe("OTH-M2");
      expect(saved).toMatchObject({ id: before.id, code: "OTH-M2", number: 2, project: (await repo.getProject("OTH")).id });
      const ws = await repo.loadWorkspace();
      expect(ws.tasks.filter((t) => t.milestone === before.id).map((t) => t.code)).toEqual(["OTH-M2-T1"]);
      expect((await opened("task", "ED-M1-T3")).text).toContain("depends_on: [OTH-M2-T1]");
      await expect(repo.getMilestone("ED-M2")).rejects.toThrow("Milestone ED-M2 not found");
      expect(ws.problems).toEqual([]);
    });

    it("project code: every milestone and task code in it is renamed", async () => {
      const { saved, code } = await roundTrip("project", "OTH", (text) => edit("project", text, { code: "OPS" }));
      expect(code).toBe("OPS");
      const ws = await repo.loadWorkspace();
      expect(ws.milestones.filter((m) => m.project === saved.id).map((m) => m.code).sort()).toEqual(["OPS-M1", "OPS-M2"]);
      expect(ws.tasks.filter((t) => t.code.startsWith("OPS-")).map((t) => t.code)).toEqual(["OPS-M2-T1"]);
      expect([...ws.milestones, ...ws.tasks].filter((x) => x.code.startsWith("OTH-"))).toEqual([]);
      expect((await opened("task", "ED-M1-T3")).text).toContain("depends_on: [OPS-M2-T1]");
      await expect(repo.getProject("OTH")).rejects.toThrow("Project OTH not found");
      expect(ws.problems).toEqual([]);
    });

    it("refuses a project code that's already used", async () => {
      expect(await refused("project", "OPS", (text) => edit("project", text, { code: "ed" }))).toContain('"code": ED is already used by "Editing records"');
    });
  });

  describe("refused edits write nothing", () => {
    it("a dependency cycle", async () => {
      // ED-M1-T3 depends on OPS-M2-T1, which depends on ED-M1-T1.
      const errors = await refused("task", "ED-M1-T1", (text) => edit("task", text, { title: "Changed too", depends_on: "[ED-M1-T3]" }));
      expect(errors).toContain('"depends_on": dependency cycle, ED-M1-T3 already depends on ED-M1-T1');
      expect(await refused("task", "ED-M1-T1", (text) => edit("task", text, { depends_on: "[ED-M1-T1]" }))).toContain("ED-M1-T1 can't depend on itself");
    });

    it("a stale base (the record changed through the repository after the editor opened)", async () => {
      const { record, text } = await opened("task", "ED-M1-T3");
      const agent = await repo.updateTask(record.id, { estimate: 6, append_note: "An agent was here." });
      const before = await snapshot();
      const result = await saveEditedRecord("task", record.id, text, edit("task", text, { title: "Mine" }));
      expect(result).toMatchObject({ ok: false, stale: true });
      expect(await snapshot()).toEqual(before);
      expect(await repo.getTask(record.id)).toEqual(agent);
    });

    it("a stale base for a milestone or a project, and a base that isn't what the record serializes to", async () => {
      const milestone = await opened("milestone", "ED-M1");
      const agentMilestone = await repo.updateMilestone(milestone.record.id, { deadline: "2027-03-01" });
      const project = await opened("project", "ED");
      const agentProject = await repo.updateProject(project.record.id, { deadline: "2027-04-01" });
      const before = await snapshot();
      expect(await saveEditedRecord("milestone", milestone.record.id, milestone.text, edit("milestone", milestone.text, { title: "Mine" }))).toMatchObject({ ok: false, stale: true });
      expect(await saveEditedRecord("project", project.record.id, project.text, edit("project", project.text, { title: "Mine" }))).toMatchObject({ ok: false, stale: true });
      expect(await snapshot()).toEqual(before);
      expect(await repo.getMilestone(milestone.record.id)).toEqual(agentMilestone);
      expect(await repo.getProject(project.record.id)).toEqual(agentProject);

      // A base the client altered (or an empty one) is refused as stale too, even when the new text is valid.
      const current = await opened("task", "ED-M1-T3");
      for (const base of [edit("task", current.text, { title: "Something else" }), ""]) {
        const result = await saveEditedRecord("task", current.record.id, base, edit("task", current.text, { title: "Mine" }));
        expect(result).toMatchObject({ ok: false, stale: true });
      }
      expect(await snapshot()).toEqual(before);
    });

    it("invalid markdown: bad YAML, a bad status, an unknown parent, no frontmatter", async () => {
      expect(await refused("task", "ED-M1-T3", (text) => edit("task", text, { title: "[unclosed", estimate: "9" }))).toContain("isn't valid YAML");
      expect(await refused("task", "ED-M1-T3", (text) => edit("task", text, { title: "Renamed", status: "someday" }))).toContain('"status" must be one of');
      expect(await refused("task", "ED-M1-T3", (text) => edit("task", text, { title: "Renamed", milestone: "ED-M9" }))).toContain('"milestone": Milestone ED-M9 not found');
      expect(await refused("milestone", "ED-M1", (text) => edit("milestone", text, { title: "Renamed", project: "NOPE" }))).toContain('"project": Project NOPE not found');
      expect(await refused("project", "ED", () => "title: Renamed\n")).toContain("must start with frontmatter");
    });
  });

  it("a save without changes returns changed: false and writes nothing", async () => {
    const before = await snapshot();
    for (const [kind, ref] of [
      ["task", "ED-M1-T3"],
      ["milestone", "OPS-M2"],
      ["project", "ED"],
    ] as const) {
      const { record, text } = await opened(kind, ref);
      expect(await saveEditedRecord(kind, record.id, text, text)).toEqual({ ok: true, code: ref, changed: false });
      // Formatting alone (CRLF line breaks, trailing blank lines) isn't a change either.
      const reformatted = `${text.replace(/\n/g, "\r\n")}\r\n\r\n`;
      expect(await saveEditedRecord(kind, record.id, text, reformatted)).toEqual({ ok: true, code: ref, changed: false });
    }
    expect(await snapshot()).toEqual(before);
  });
});

const JWT_SECRET = "record-edit-test-jwt-secret-".padEnd(48, "0");
const revalidated = vi.mocked(revalidatePath);

/** The FormData the record editor posts. */
function form(fields: Partial<Record<"kind" | "id" | "base" | "text", string>>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe.each(backends)("saveRecordAction, $name backend", (backend) => {
  beforeAll(async () => {
    setRepository(await backend.setup());
    await repo.createProject({ title: "Action", code: "ACT", priority: "P2" });
    await repo.createMilestone({ title: "First", project: "ACT" });
    await repo.createMilestone({ title: "Second", project: "ACT" });
    await repo.createTasks([{ title: "Edit me", milestone: "ACT-M1", estimate: 2 }]);
  });
  beforeEach(() => {
    // "open" auth mode (local, no JWT_SECRET) unless a test says otherwise; no credentials on the request.
    for (const key of ["JWT_SECRET", "PM_SECRET", "VERCEL"]) vi.stubEnv(key, undefined);
    request.cookies.clear();
    request.headers = new Headers();
    revalidated.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("saves each kind, returns its (new) code and revalidates only when something changed", async () => {
    const task = await opened("task", "ACT-M1-T1");
    const saved = await saveRecordAction(null, form({ kind: "task", id: task.record.id, base: task.text, text: edit("task", task.text, { title: "Edited", milestone: "ACT-M2" }) }));
    expect(saved).toEqual({ ok: true, code: "ACT-M2-T1", changed: true });
    expect(await repo.getTask(task.record.id)).toMatchObject({ code: "ACT-M2-T1", title: "Edited" });
    expect(revalidated.mock.calls).toEqual([["/", "layout"]]);

    const milestone = await opened("milestone", "ACT-M1");
    expect(await saveRecordAction(null, form({ kind: "milestone", id: milestone.record.id, base: milestone.text, text: edit("milestone", milestone.text, {}, "The spec.") }))).toEqual({ ok: true, code: "ACT-M1", changed: true });
    expect((await repo.getMilestone("ACT-M1")).body).toBe("The spec.");

    const project = await opened("project", "ACT");
    expect(await saveRecordAction(null, form({ kind: "project", id: project.record.id, base: project.text, text: edit("project", project.text, { code: "ACX" }) }))).toEqual({ ok: true, code: "ACX", changed: true });
    expect((await repo.getTask(task.record.id)).code).toBe("ACX-M2-T1");
    expect(revalidated).toHaveBeenCalledTimes(3);

    // Unchanged text (as a browser posts it, CRLF): ok, but nothing to revalidate.
    revalidated.mockClear();
    const current = await opened("task", "ACX-M2-T1");
    const crlf = current.text.replace(/\n/g, "\r\n");
    expect(await saveRecordAction(null, form({ kind: "task", id: current.record.id, base: crlf, text: crlf }))).toEqual({ ok: true, code: "ACX-M2-T1", changed: false });
    expect(revalidated).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind, missing fields, a stale base and invalid markdown without writing or revalidating", async () => {
    const { record, text } = await opened("task", "ACX-M2-T1");
    const changed = edit("task", text, { title: "Refused" });
    const before = await snapshot();
    const cases: [Parameters<typeof form>[0], string][] = [
      [{ kind: "user", id: record.id, base: text, text: changed }, 'Unknown record kind "user"'],
      [{ id: record.id, base: text, text: changed }, 'Unknown record kind ""'],
      [{ kind: "task", base: text, text: changed }, "This task no longer exists."],
      [{ kind: "milestone", id: record.id, base: text, text: changed }, "This milestone no longer exists."],
      [{ kind: "task", id: record.id, text: changed }, "was changed elsewhere"],
      [{ kind: "task", id: record.id, base: text }, "must start with frontmatter"],
      [{ kind: "task", id: record.id, base: text, text: edit("task", text, { status: "someday" }) }, '"status" must be one of'],
    ];
    for (const [fields, error] of cases) {
      const result = await saveRecordAction(null, form(fields));
      expect(result).toMatchObject({ ok: false });
      expect(result?.ok === false && result.errors.join("\n")).toContain(error);
    }
    expect(revalidated).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("requires a session when auth is on, and nothing gets past a locked app", async () => {
    const { record, text } = await opened("task", "ACX-M2-T1");
    const fields = { kind: "task", id: record.id, base: text, text: edit("task", text, { title: "Signed in" }) };
    const before = await snapshot();

    vi.stubEnv("JWT_SECRET", JWT_SECRET);
    await expect(saveRecordAction(null, form(fields))).rejects.toThrow("Unauthorized");
    request.cookies.set(SESSION_COOKIE, "not-a-jwt");
    await expect(saveRecordAction(null, form(fields))).rejects.toThrow("Unauthorized");
    const expired = signJwt({ sub: "U-1", email: "me@example.com" }, JWT_SECRET, { ttlSeconds: 60, now: Math.floor(Date.now() / 1000) - 3600 });
    request.cookies.set(SESSION_COOKIE, expired);
    await expect(saveRecordAction(null, form(fields))).rejects.toThrow("Unauthorized");
    request.cookies.clear();
    request.headers = new Headers({ authorization: `Bearer ${signJwt({ sub: "U-1", email: "me@example.com" }, "some-other-secret".padEnd(48, "x"), { ttlSeconds: 60 })}` });
    await expect(saveRecordAction(null, form(fields))).rejects.toThrow("Unauthorized");

    // Locked: no JWT_SECRET on Vercel refuses everyone, whatever they send.
    vi.stubEnv("JWT_SECRET", undefined);
    vi.stubEnv("VERCEL", "1");
    request.headers = new Headers();
    request.cookies.set(SESSION_COOKIE, signJwt({ sub: "U-1", email: "me@example.com" }, JWT_SECRET, { ttlSeconds: SESSION_TTL_SECONDS }));
    await expect(saveRecordAction(null, form(fields))).rejects.toThrow("Unauthorized");

    expect(revalidated).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);

    // With a valid session cookie the same save goes through.
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("JWT_SECRET", JWT_SECRET);
    expect(await saveRecordAction(null, form(fields))).toEqual({ ok: true, code: "ACX-M2-T1", changed: true });
    expect((await repo.getTask(record.id)).title).toBe("Signed in");
    expect(revalidated).toHaveBeenCalledOnce();
  });
});
