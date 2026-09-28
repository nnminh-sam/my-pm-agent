import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { newId } from "./codes";
import { WIP_LIMIT, lifecycle, nextStages, statusForStage, type LifecycleInput } from "./lifecycle";
import { Playbook, type PlaybookVersion } from "./playbook";
import type { ScheduleResult } from "./scheduler";
import { MilestoneMeta, ProjectMeta, TaskMeta, type Milestone, type Project, type Task } from "./types";

const sdlc = Playbook.parse(YAML.parse(readFileSync(new URL("./playbooks/sdlc.yaml", import.meta.url), "utf8")));

const stored = (definition: Playbook): PlaybookVersion => ({
  ref: `${definition.name}@${definition.version}`,
  name: definition.name,
  version: definition.version,
  hash: "0".repeat(64),
  synced_at: "2026-09-28T00:00:00.000Z",
  definition,
});

/** A project playbook: sdlc compiled for dev → prod, with two project rules. */
const compiled = (name = "PMA", version = "1.0.0") =>
  stored(
    Playbook.parse({
      ...sdlc,
      name,
      version,
      layers: [{ name: "sdlc", version: "1.0.0" }],
      environments: [{ name: "dev" }, { name: "prod" }],
      rules: { project: 2, layers: 9 },
    }),
  );

const project = (code: string, fields: Partial<Project> = {}): Project => ({
  ...ProjectMeta.parse({ id: newId(), code, title: `${code} title`, created: "2026-09-01", playbook: `${code}@1.0.0`, ...fields }),
  body: "",
});
const milestone = (p: Project, n: number, fields: Partial<Milestone> = {}): Milestone => ({
  ...MilestoneMeta.parse({ id: newId(), code: `${p.code}-M${n}`, number: n, title: `Milestone ${n}`, project: p.id, created: "2026-09-01", ...fields }),
  body: "",
});
const task = (m: Milestone, n: number, fields: Partial<Task> = {}): Task => ({
  ...TaskMeta.parse({ id: newId(), code: `${m.code}-T${n}`, number: n, title: `Task ${n}`, milestone: m.id, created: "2026-09-01", ...fields }),
  body: "",
});
const passed = { status: "passed" as const, at: "2026-09-20" };

const run = (input: Partial<LifecycleInput>) =>
  lifecycle({ projects: [], milestones: [], tasks: [], playbooks: [compiled()], settings: { max_task_hours: 8 }, ...input });

/** The one milestone's view. */
function only(input: Partial<LifecycleInput>) {
  const [view] = run(input).projects.flatMap((p) => p.milestones);
  return view;
}

describe("stages", () => {
  it("keeps the status in step with the stage", () => {
    expect(["idea", "spec", "plan", "build", "release", "maintain"].map((s) => statusForStage(s as never))).toEqual([
      "idea",
      "planned",
      "planned",
      "in_progress",
      "in_progress",
      "in_progress",
    ]);
  });

  it("moves forward one stage, with maintain optional after learn", () => {
    expect(nextStages("spec")).toEqual(["design"]);
    expect(nextStages("release")).toEqual(["learn"]);
    expect(nextStages("learn")).toEqual(["done", "maintain"]);
    expect(nextStages("maintain")).toEqual(["done"]);
  });
});

describe("checks", () => {
  const pma = project("PMA");

  it("computes auto checks from the milestone's tasks, ignoring cancelled ones", () => {
    const m = milestone(pma, 1, { stage: "plan" });
    const tasks = [
      task(m, 1, { estimate: 2 }),
      task(m, 2),
      task(m, 3, { estimate: 12 }),
      task(m, 4, { status: "cancelled" }),
    ];
    const view = only({ projects: [pma], milestones: [m], tasks });
    const check = (key: string) => view.checks.find((c) => c.key === key)!;
    expect(check("plan.estimated")).toMatchObject({ state: "open", detail: "1 of 3 tasks unestimated", source: "PMA@1.0.0" });
    expect(check("plan.small_tasks")).toMatchObject({ state: "open", detail: "over 8h: PMA-M1-T3" });
    expect(check("build.tasks_done")).toMatchObject({ state: "open", detail: "0 of 3 tasks done" });
    expect(check("learn.time_logged")).toMatchObject({ state: "open", detail: "no finished tasks" });
    expect(check("release.deployed")).toMatchObject({ state: "open", detail: "not on dev, prod yet" });
    expect(view.open).toEqual(["plan.estimated", "plan.small_tasks"]);
    expect(view.next).toEqual({ kind: "check", check: "plan.estimated", text: "plan.estimated: 1 of 3 tasks unestimated" });
  });

  it("lets a recorded result win: a waiver or pass unblocks, a failure blocks", () => {
    const planned = milestone(pma, 1, {
      stage: "plan",
      checks: { "plan.estimated": { status: "waived", at: "2026-09-20", note: "spike" }, "plan.small_tasks": passed },
    });
    expect(only({ projects: [pma], milestones: [planned] })).toMatchObject({ open: [], next: { kind: "advance", to: "build" } });

    const spec = milestone(pma, 2, { stage: "spec", checks: { "spec.accepted": { status: "failed", at: "2026-09-20", note: "no criteria" } } });
    const view = only({ projects: [pma], milestones: [spec] });
    expect(view.open).toEqual(["spec.accepted"]);
    expect(view.next).toEqual({ kind: "check", check: "spec.accepted", skill: "spec", text: "spec.accepted: failed: no criteria" });
  });

  it("adds a detector's checks once it has fired, after the playbook's own", () => {
    const m = milestone(pma, 1, { stage: "release" });
    const keys = (p: Project) => only({ projects: [p], milestones: [{ ...m, project: p.id }] }).checks.map((c) => c.key);
    expect(keys(pma)).not.toContain("release.migration_paired");
    const fired = { ...pma, detectors: ["migrations"] };
    expect(keys(fired).at(-1)).toBe("release.migration_paired");
    const view = only({ projects: [fired], milestones: [{ ...m, project: fired.id }] });
    expect(view.checks.at(-1)).toMatchObject({ source: "detector:migrations", env: "prod", principle: "reversible" });
  });

  it("leaves check text out for company projects", () => {
    const acme = project("ACME", { context: "company", playbook: "PMA@1.0.0" });
    const view = only({ projects: [acme], milestones: [milestone(acme, 1, { stage: "spec" })] });
    expect(view.checks.every((c) => c.text === undefined)).toBe(true);
    expect(view.next).toEqual({ kind: "check", check: "spec.accepted", skill: "spec", text: "spec.accepted: open" });
  });
});

describe("next actions", () => {
  const pma = project("PMA", { detectors: ["migrations"] });

  it("points at the first scheduled task while building", () => {
    const m = milestone(pma, 1, { stage: "build" });
    const [t1, t2, t3] = [task(m, 1, { status: "done", estimate: 1 }), task(m, 2, { estimate: 1 }), task(m, 3, { estimate: 1 })];
    const plan = { tasks: [{ id: t3.id, milestone: m.id }, { id: t2.id, milestone: m.id }], at_risk: [] } as unknown as ScheduleResult;
    expect(only({ projects: [pma], milestones: [m], tasks: [t1, t2, t3], plan }).next).toEqual({
      kind: "work",
      task: "PMA-M1-T3",
      text: "build.tasks_done: 1 of 3 tasks done; next PMA-M1-T3 Task 3",
    });
  });

  it("promotes a release through the environments in order", () => {
    const at = (checks: Milestone["checks"], deployments: Milestone["deployments"]) =>
      only({ projects: [pma], milestones: [milestone(pma, 1, { stage: "release", checks, deployments })] });
    const dev = { dev: { at: "2026-09-27" } };
    const both = { ...dev, prod: { at: "2026-09-29" } };

    // Prod's checks wait until dev is reached.
    expect(at({}, {}).next).toEqual({ kind: "deploy", env: "dev", text: "Deploy to dev and record it" });
    // Then prod's own checks come before deploying to it, in playbook order.
    expect(at({}, dev).next).toMatchObject({ kind: "check", check: "release.rollback_plan", env: "prod" });
    expect(at({ "release.rollback_plan": passed }, dev).next).toMatchObject({
      check: "release.migration_paired",
      text: "release.migration_paired (prod): Migration applied in the same cut-over as the deploy; rollback point recorded",
    });
    const ready = { "release.rollback_plan": passed, "release.migration_paired": passed };
    expect(at(ready, dev).next).toEqual({ kind: "deploy", env: "prod", text: "Deploy to prod and record it" });
    // A check for an environment already reached still counts.
    expect(at({ "release.rollback_plan": passed }, both).next).toMatchObject({ check: "release.migration_paired" });
    const done = at(ready, both);
    expect(done.open).toEqual([]);
    expect(done.next).toEqual({ kind: "advance", to: "learn", text: "Advance to learn" });
    expect(done.environments).toEqual([
      { name: "dev", reached: { at: "2026-09-27" } },
      { name: "prod", reached: { at: "2026-09-29" } },
    ]);
  });

  it("offers done or maintain after learn, and nothing once done", () => {
    const m = milestone(pma, 1, { stage: "learn", checks: { "learn.retro": passed } });
    const t = task(m, 1, { status: "done", estimate: 1, spent: 0.5 });
    expect(only({ projects: [pma], milestones: [m], tasks: [t] }).next).toEqual({
      kind: "advance",
      to: "done",
      text: "Advance to done, or to maintain if the retro proposed playbook changes",
    });
    expect(only({ projects: [pma], milestones: [{ ...m, status: "done" }], tasks: [t] }).next).toBeUndefined();
  });
});

describe("across projects", () => {
  it("ranks deadline risk, then priority, then later stages, then deadline, then code", () => {
    const a = project("AAA", { priority: "P1", playbook: "PMA@1.0.0" });
    const b = project("BBB", { playbook: "PMA@1.0.0" });
    const held = project("CCC", { status: "on_hold", playbook: "PMA@1.0.0" });
    const milestones = [
      milestone(b, 1, { stage: "spec" }),
      milestone(b, 2, { stage: "verify" }),
      milestone(b, 3, { stage: "spec", deadline: "2026-10-10" }),
      milestone(b, 4, { stage: "spec", deadline: "2026-10-05" }),
      milestone(b, 5, { stage: "spec" }),
      milestone(a, 1, { stage: "spec" }),
      milestone(b, 6, { stage: "idea" }),
      milestone(b, 7, { stage: "verify", status: "done" }),
      milestone(held, 1, { stage: "release" }),
    ];
    const late = task(milestones[4], 1, { estimate: 1 });
    const plan = { tasks: [], at_risk: [{ id: late.id }] } as unknown as ScheduleResult;
    const result = run({ projects: [a, b, held], milestones, tasks: [late], plan });
    expect(result.next.map((n) => n.milestone)).toEqual(["BBB-M5", "AAA-M1", "BBB-M2", "BBB-M4", "BBB-M3", "BBB-M1"]);
    expect(result.next[0]).toMatchObject({ at_risk: true, priority: "P2", stage: "spec" });
    expect(result.projects.map((p) => p.code)).toEqual(["AAA", "BBB"]);
    // Ideas and done milestones are listed on their project, just not as next actions.
    expect(result.projects[1].milestones.map((m) => m.code)).toContain("BBB-M6");
  });

  it("warns about projects without a (stored) playbook, without project rules, or behind a newer version", () => {
    const layerOnly = stored(Playbook.parse({ ...sdlc, version: "1.0.0" }));
    const playbooks = [compiled("PMA", "1.0.0"), compiled("PMA", "1.1.0"), layerOnly, stored(Playbook.parse({ ...sdlc, version: "1.2.0" }))];
    const projects = [
      project("PMA"),
      project("PLAY", { playbook: undefined }),
      project("GONE", { playbook: "GONE@2.0.0" }),
      project("LAYER", { playbook: "sdlc@1.0.0" }),
      project("DONE", { status: "done", playbook: undefined }),
    ];
    const { warnings, projects: views } = run({ projects, playbooks });
    expect(warnings).toEqual([
      { code: "no_playbook", project: "GONE", message: "GONE is pinned to GONE@2.0.0, which isn't stored" },
      { code: "no_project_rules", project: "LAYER", message: "LAYER's playbook sdlc@1.0.0 has no project rules; add some" },
      { code: "playbook_update", project: "LAYER", message: "sdlc@1.2.0 is available (pinned sdlc@1.0.0)" },
      { code: "no_playbook", project: "PLAY", message: "PLAY has no playbook yet; adopt one" },
      { code: "playbook_update", project: "PMA", message: "PMA@1.1.0 is available (pinned PMA@1.0.0)" },
      { code: "playbook_update", project: "PMA", message: "sdlc@1.2.0 is available (PMA@1.0.0 was compiled with 1.0.0)" },
    ]);
    expect(views.map((p) => p.code)).toEqual(["LAYER", "PMA"]);
    expect(views[1]).toMatchObject({ playbook: "PMA@1.0.0", environments: ["dev", "prod"] });
  });

  it("flags too many milestones in build at once", () => {
    const pma = project("PMA");
    const building = Array.from({ length: WIP_LIMIT + 1 }, (_, i) => milestone(pma, i + 1, { stage: "build" }));
    expect(run({ projects: [pma], milestones: building.slice(0, WIP_LIMIT) }).wip).toMatchObject({ over: false });
    expect(run({ projects: [pma], milestones: building }).wip).toEqual({
      in_build: ["PMA-M1", "PMA-M2", "PMA-M3", "PMA-M4"],
      limit: WIP_LIMIT,
      over: true,
    });
  });

  it("treats a milestone without a stage as an idea", () => {
    const pma = project("PMA");
    const result = run({ projects: [pma], milestones: [milestone(pma, 1)] });
    expect(result.projects[0].milestones[0]).toMatchObject({ stage: "idea", next: { kind: "advance", to: "spec" } });
    expect(result.next).toEqual([]);
  });
});
