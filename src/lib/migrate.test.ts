import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "./codes";
import type { Db, Row } from "./db";
import { migrate, type MigrationSession } from "./migrate";
import * as repo from "./repo";
import { setRepository } from "./repository";
import { PgRepository } from "./repository/postgres";

const MIGRATIONS = path.resolve("migrations");
const tempDirs: string[] = [];
afterAll(async () => {
  setRepository(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A database migrated up to (not including) `before`, as it was when that migration was written. */
async function databaseBefore(before: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "my-pm-migrations-"));
  tempDirs.push(dir);
  for (const file of await readdir(MIGRATIONS)) if (file < before) await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
  const pg = new PGlite();
  const session: MigrationSession = {
    exec: async (sql) => {
      await pg.exec(sql);
    },
    query: async (text, params) => (await pg.query<Row>(text, params)).rows,
  };
  await migrate(session, dir);
  const db: Db = {
    query: async (text, params) => (await pg.query<Row>(text, params)).rows,
    transaction: (statements) =>
      pg.transaction(async (tx) => {
        const results: Row[][] = [];
        for (const s of statements) results.push((await tx.query<Row>(s.text, s.params)).rows);
        return results;
      }),
  };
  return { session, db, rows: (sql: string) => db.query(sql) };
}

// Each test boots its own PGlite and replays every migration, which can take a few seconds on a busy machine.
describe("005_milestones_and_codes", { timeout: 30_000 }, () => {
  it("turns features into milestones and gives every record a uuid and a code", async () => {
    const { session, db, rows } = await databaseBefore("005");
    await session.exec(`
      insert into settings (id, data) values (true, '{"timezone":"Asia/Ho_Chi_Minh"}');
      insert into projects (id, title, status, priority, created, body) values
        ('PRJ-1', 'My PM Agent', 'active', 'P1', '2026-09-27', 'See F-1 and F-2.'),
        ('PRJ-2', 'Side', 'on_hold', 'P3', '2026-09-27', '');
      insert into features (id, title, status, project, created, body) values
        ('F-1', 'Auth', 'done', 'PRJ-1', '2026-09-27', 'Then T-3.'),
        ('F-2', 'Gantt', 'planned', 'PRJ-1', '2026-09-28', ''),
        ('F-3', 'Other', 'idea', 'PRJ-2', '2026-09-28', '');
      insert into tasks (id, title, status, feature, estimate, estimate_range, depends_on, tags, "order", created, body) values
        ('T-1', 'a', 'done', 'F-1', 1.5, '{1,3}', '{}', '{auth}', null, '2026-09-27', 'Blocks T-2, not T-20.'),
        ('T-2', 'b', 'todo', 'F-2', 2, null, '{T-3,T-1}', '{}', 1, '2026-09-27', ''),
        ('T-3', 'c', 'todo', 'F-1', 1, null, '{}', '{}', null, '2026-09-27', ''),
        ('T-4', 'd', 'todo', 'F-3', null, null, '{T-99}', '{}', null, '2026-09-28', '');
    `);

    // Later migrations run too; this test is about 005.
    expect((await migrate(session, MIGRATIONS))[0]).toBe("005_milestones_and_codes");

    expect(await rows("select code, title, last_milestone_number, body from projects order by code")).toEqual([
      { code: "P1", title: "My PM Agent", last_milestone_number: 2, body: "See P1-M1 and P1-M2." },
      { code: "P2", title: "Side", last_milestone_number: 1, body: "" },
    ]);
    expect(await rows("select code, number, title, status, last_task_number, body from milestones order by code")).toEqual([
      { code: "P1-M1", number: 1, title: "Auth", status: "done", last_task_number: 2, body: "Then P1-M1-T2." },
      { code: "P1-M2", number: 2, title: "Gantt", status: "planned", last_task_number: 1, body: "" },
      { code: "P2-M1", number: 1, title: "Other", status: "idea", last_task_number: 1, body: "" },
    ]);
    // Tasks are numbered per feature in id order; dependencies keep their order and drop ids that never existed.
    expect(
      await rows(`
        select t.code, t.number, t.estimate, t.estimate_range, t.tags, t."order",
          array(select d.code from unnest(t.depends_on) with ordinality as x (id, ord) join tasks d on d.id = x.id order by x.ord) as deps,
          t.body
        from tasks t order by t.code`),
    ).toEqual([
      { code: "P1-M1-T1", number: 1, estimate: 1.5, estimate_range: [1, 3], tags: ["auth"], order: null, deps: [], body: "Blocks P1-M2-T1, not T-20." },
      { code: "P1-M1-T2", number: 2, estimate: 1, estimate_range: null, tags: [], order: null, deps: [], body: "" },
      { code: "P1-M2-T1", number: 1, estimate: 2, estimate_range: null, tags: [], order: 1, deps: ["P1-M1-T2", "P1-M1-T1"], body: "" },
      { code: "P2-M1-T1", number: 1, estimate: null, estimate_range: null, tags: [], order: null, deps: [], body: "" },
    ]);
    expect(await rows("select to_regclass('features') as features, to_regclass('task_id_seq') as seq")).toEqual([{ features: null, seq: null }]);
    expect(await rows("select data from settings")).toEqual([{ data: { timezone: "Asia/Ho_Chi_Minh" } }]);

    // The app picks up from there: no problems, numbering continues, and a code change cascades.
    setRepository(new PgRepository(db));
    expect((await repo.loadWorkspace()).problems).toEqual([]);
    const [next] = await repo.createTasks([{ title: "e", milestone: "p1-m1", depends_on: ["P1-M2-T1"] }]);
    expect(next.code).toBe("P1-M1-T3");
    expect((await repo.createMilestone({ title: "Next", project: "P1" })).code).toBe("P1-M3");
    await repo.updateProject("P1", { code: "PMA" });
    const ws = await repo.loadWorkspace();
    expect(ws.tasks.map((t) => t.code)).toEqual(["P2-M1-T1", "PMA-M1-T1", "PMA-M1-T2", "PMA-M1-T3", "PMA-M2-T1"]);
    // Mentions the migration wrote follow the rename; the bare project code is left alone.
    expect(ws.tasks.find((t) => t.code === "PMA-M1-T1")?.body).toBe("Blocks PMA-M2-T1, not T-20.");
    expect(ws.milestones.find((m) => m.code === "PMA-M1")?.body).toBe("Then PMA-M1-T2.");
    expect(ws.projects.find((p) => p.code === "PMA")?.body).toBe("See PMA-M1 and PMA-M2.");
    expect(ws.problems).toEqual([]);
  });

  it("refuses features without a project and tasks without a feature, changing nothing", async () => {
    const { session, rows } = await databaseBefore("005");
    await session.exec(`
      insert into features (id, title, created) values ('F-1', 'Loose', '2026-09-27');
    `);
    await expect(migrate(session, MIGRATIONS)).rejects.toThrow("Every feature needs a project before it can become a milestone (features without one: F-1)");
    expect(await rows("select version from schema_migrations order by version")).toHaveLength(4);
    expect(await rows("select id from features")).toEqual([{ id: "F-1" }]);

    await session.exec(`
      insert into projects (id, title, created) values ('PRJ-1', 'P', '2026-09-27');
      update features set project = 'PRJ-1';
      insert into tasks (id, title, created) values ('T-1', 'Loose', '2026-09-27');
    `);
    await expect(migrate(session, MIGRATIONS)).rejects.toThrow("Every task needs a feature before it can get a code (tasks without one: T-1)");
    expect(await rows("select id from tasks")).toEqual([{ id: "T-1" }]);
  });
});

describe("006_lifecycle", { timeout: 30_000 }, () => {
  it("gives existing projects and milestones lifecycle defaults", async () => {
    const { session, db, rows } = await databaseBefore("006");
    const project = newId();
    await session.exec(`
      insert into projects (id, code, title, created, last_milestone_number) values ('${project}', 'PMA', 'My PM Agent', '2026-09-27', 1);
      insert into milestones (id, code, number, title, status, project, created) values ('${newId()}', 'PMA-M1', 1, 'Auth', 'done', '${project}', '2026-09-27');
    `);
    expect((await migrate(session, MIGRATIONS))[0]).toBe("006_lifecycle");
    expect(await rows("select playbook, repos, detectors from projects")).toEqual([
      { playbook: null, repos: [], detectors: [] },
    ]);
    expect(await rows("select stage, checks, deployments from milestones")).toEqual([{ stage: null, checks: {}, deployments: {} }]);

    setRepository(new PgRepository(db));
    const ws = await repo.loadWorkspace();
    expect(ws.projects[0]).toMatchObject({ code: "PMA", repos: [], detectors: [] });
    expect(ws.milestones[0]).toMatchObject({ code: "PMA-M1", status: "done", checks: {}, deployments: {} });
    expect(ws.milestones[0].stage).toBeUndefined();
    expect(ws.playbooks).toEqual([]);
    expect(ws.problems).toEqual([]);
  });
});

describe("007_github", { timeout: 30_000 }, () => {
  it("gives existing tasks no PRs, and takes snapshots and comments that go with their task", async () => {
    const { session, db, rows } = await databaseBefore("007");
    const [project, milestone, task, other] = [newId(), newId(), newId(), newId()];
    await session.exec(`
      insert into projects (id, code, title, created, last_milestone_number) values ('${project}', 'PMA', 'My PM Agent', '2026-09-27', 1);
      insert into milestones (id, code, number, title, project, created, last_task_number) values ('${milestone}', 'PMA-M1', 1, 'Auth', '${project}', '2026-09-27', 2);
      insert into tasks (id, code, number, title, milestone, created) values
        ('${task}', 'PMA-M1-T1', 1, 'Review', '${milestone}', '2026-09-27'),
        ('${other}', 'PMA-M1-T2', 2, 'Other', '${milestone}', '2026-09-27');
    `);
    expect((await migrate(session, MIGRATIONS))[0]).toBe("007_github");
    expect(await rows("select prs from tasks order by code")).toEqual([{ prs: [] }, { prs: [] }]);

    setRepository(new PgRepository(db));
    const ws = await repo.loadWorkspace();
    expect(ws.tasks.map((t) => t.prs)).toEqual([[], []]);
    expect(ws.problems).toEqual([]);

    const pg = new PgRepository(db);
    const comment = { task_id: task, author: "you" as const, created_at: "2026-09-29T01:00:00.000Z", body: "check the migration" };
    await pg.insertComment({ id: newId(), ...comment });
    await pg.insertComment({ id: newId(), ...comment, task_id: other });
    await expect(pg.insertComment({ id: newId(), ...comment, task_id: newId() })).rejects.toThrow();
    await expect(pg.insertComment({ id: newId(), ...comment, author: "bot" as "you" })).rejects.toThrow();
    await expect(pg.insertComment({ id: newId(), ...comment, body: "" })).rejects.toThrow();
    await expect(pg.upsertGithubSnapshot({ key: "pr:acme/api" })).rejects.toThrow();
    await expect(pg.upsertGithubSnapshot({ key: "pr:acme/api#1", last_error: [] as unknown as Record<string, never> })).rejects.toThrow();

    // Deleting a task (repo.ts never does yet) takes its comments with it.
    await session.exec(`delete from tasks where id = '${task}'`);
    expect(await rows("select task_id from task_comments")).toEqual([{ task_id: other }]);
  });
});

describe("008_drop_project_context", { timeout: 30_000 }, () => {
  it("PO-1.2 refuses to run if any project is company, leaving the column", async () => {
    const { session, rows } = await databaseBefore("008");
    const project = newId();
    await session.exec(`insert into projects (id, code, title, created, context) values ('${project}', 'PMA', 'My PM Agent', '2026-09-27', 'company');`);
    await expect(migrate(session, MIGRATIONS)).rejects.toThrow(/company/i);
    const cols = await rows("select column_name from information_schema.columns where table_name = 'projects' and column_name = 'context'");
    expect(cols.length).toBe(1);
    
    // Now delete it so we can test success
    await session.exec(`delete from projects where id = '${project}';`);
    await migrate(session, MIGRATIONS);
    const colsAfter = await rows("select column_name from information_schema.columns where table_name = 'projects' and column_name = 'context'");
    expect(colsAfter.length).toBe(0);
  });
});
