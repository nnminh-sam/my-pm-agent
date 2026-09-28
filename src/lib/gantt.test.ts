import { describe, expect, it } from "vitest";
import { newId } from "./codes";
import { ganttRange, ganttRows, milestoneOptions, parseGanttQuery } from "./gantt";
import { schedule } from "./scheduler";
import { MilestoneMeta, ProjectMeta, Settings, TaskMeta } from "./types";

const settings = Settings.parse({ timezone: "UTC" }); // Mon–Fri 09–12, 13–17 (7h/day)
const MONDAY = "2026-09-28";
const TUESDAY = "2026-09-29";

const projects = [
  ProjectMeta.parse({ id: newId(), code: "ALP", title: "Alpha", priority: "P1", created: "2026-09-01" }),
  ProjectMeta.parse({ id: newId(), code: "BET", title: "Beta", priority: "P2", created: "2026-09-01" }),
];
const m = (code: string, title: string, project: ProjectMeta) =>
  MilestoneMeta.parse({ id: newId(), code, number: Number(code.split("-M")[1]), title, project: project.id, created: "2026-09-01" });
const milestones = [m("ALP-M1", "Login", projects[0]), m("ALP-M2", "Billing", projects[0]), m("BET-M1", "Docs", projects[1])];
const byCode = new Map(milestones.map((x) => [x.code, x]));
const t = (code: string, estimate: number, extra: Partial<TaskMeta> = {}) =>
  TaskMeta.parse({
    id: newId(),
    code,
    number: Number(code.split("-T")[1]),
    title: `Task ${code}`,
    milestone: byCode.get(code.split("-T")[0])?.id ?? newId(),
    estimate,
    created: "2026-09-01",
    ...extra,
  });

const tasks = [t("ALP-M1-T1", 4), t("ALP-M1-T2", 4), t("ALP-M2-T1", 3), t("BET-M1-T1", 2)];
const ws = { milestones, projects };
const plan = schedule({ tasks, milestones, projects, settings, now: { date: MONDAY, minutes: 8 * 60 } });
const codes = (rows: ReturnType<typeof ganttRows>) => rows.flatMap((p) => p.milestones.flatMap((x) => x.tasks.map((task) => task.code)));

describe("ganttRows", () => {
  it("groups Project → Milestone → Task and keeps the scheduler's order with no filters", () => {
    const rows = ganttRows(plan, ws);
    expect(rows.map((p) => [p.id, p.code, p.title])).toEqual([
      [projects[0].id, "ALP", "Alpha"],
      [projects[1].id, "BET", "Beta"],
    ]);
    expect(rows[0].milestones.map((x) => [x.code, x.title, x.tasks.map((task) => task.code)])).toEqual([
      ["ALP-M1", "Login", ["ALP-M1-T1", "ALP-M1-T2"]],
      ["ALP-M2", "Billing", ["ALP-M2-T1"]],
    ]);
    expect(codes(rows)).toEqual(plan.tasks.map((x) => x.code));
    expect(rows[0].milestones[0].tasks[0].id).toBe(tasks[0].id);
  });

  it("carries work blocks, span, priority and deadline flags straight from the schedule", () => {
    const late = t("BET-M1-T9", 10, { priority: "P0", deadline: MONDAY });
    const p = schedule({ tasks: [late], milestones, projects, settings, now: { date: MONDAY, minutes: 8 * 60 } });
    const [task] = ganttRows(p, ws)[0].milestones[0].tasks;
    expect(task.blocks).toEqual(p.days.flatMap((d) => d.blocks));
    expect(task.start).toEqual(p.tasks[0].start);
    expect(task.end).toEqual(p.tasks[0].end);
    expect(task.priority).toBe("P0");
    expect(task.deadline).toBe(MONDAY);
    expect(task.at_risk).toBe(true);
    expect(task.late_days).toBeGreaterThan(0);

    const ontime = ganttRows(plan, ws)[0].milestones[0].tasks[0];
    expect(ontime.at_risk).toBe(false);
    expect(ontime.late_days).toBe(0);
  });

  it("follows the scheduler when a later project's task goes first", () => {
    const urgent = [...tasks, t("BET-M1-T2", 1, { priority: "P0" })];
    const p = schedule({ tasks: urgent, milestones, projects, settings, now: { date: MONDAY, minutes: 8 * 60 } });
    const rows = ganttRows(p, ws);
    expect(rows.map((r) => r.code)).toEqual(["BET", "ALP"]);
    expect(rows[0].milestones[0].tasks.map((x) => x.code)).toEqual(["BET-M1-T2", "BET-M1-T1"]);
  });

  it("filters by project code", () => {
    expect(codes(ganttRows(plan, ws, { projects: ["BET"] }))).toEqual(["BET-M1-T1"]);
    expect(codes(ganttRows(plan, ws, { projects: ["ALP"] }))).toEqual(["ALP-M1-T1", "ALP-M1-T2", "ALP-M2-T1"]);
  });

  it("filters by milestone code (several at once)", () => {
    expect(codes(ganttRows(plan, ws, { milestones: ["ALP-M2"] }))).toEqual(["ALP-M2-T1"]);
    expect(codes(ganttRows(plan, ws, { milestones: ["ALP-M2", "BET-M1"] }))).toEqual(["ALP-M2-T1", "BET-M1-T1"]);
  });

  it("treats empty filter lists as no filter", () => {
    expect(codes(ganttRows(plan, ws, { projects: [], milestones: [] }))).toEqual(["ALP-M1-T1", "ALP-M1-T2", "ALP-M2-T1", "BET-M1-T1"]);
  });

  it("filters by date range, dropping tasks with no work in it", () => {
    // Monday holds ALP-M1-T1 (4h) and the first 3h of ALP-M1-T2; Tuesday holds the rest.
    expect(codes(ganttRows(plan, ws, { from: MONDAY, to: MONDAY }))).toEqual(["ALP-M1-T1", "ALP-M1-T2"]);
    expect(codes(ganttRows(plan, ws, { from: TUESDAY }))).toEqual(["ALP-M1-T2", "ALP-M2-T1", "BET-M1-T1"]);
    expect(ganttRows(plan, ws, { from: "2027-01-01" })).toEqual([]);
  });

  it("clips a task's blocks to the range but keeps its full scheduled span", () => {
    const all = ganttRows(plan, ws)[0].milestones[0].tasks[1]; // ALP-M1-T2 spans Mon + Tue
    expect(all.blocks.map((b) => b.date)).toEqual([MONDAY, TUESDAY]);

    const clipped = ganttRows(plan, ws, { from: TUESDAY })[0].milestones[0].tasks[0];
    expect(clipped.code).toBe("ALP-M1-T2");
    expect(clipped.blocks.map((b) => b.date)).toEqual([TUESDAY]);
    expect(clipped.start).toEqual(all.start);
    expect(clipped.end).toEqual(all.end);
  });

  it("combines filters with AND", () => {
    const f = { projects: ["ALP"], milestones: ["ALP-M1"], from: TUESDAY, to: TUESDAY };
    expect(codes(ganttRows(plan, ws, f))).toEqual(["ALP-M1-T2"]);
    // milestone outside the selected project → nothing
    expect(ganttRows(plan, ws, { projects: ["BET"], milestones: ["ALP-M1"] })).toEqual([]);
  });

  it("leaves out tasks whose milestone is missing (a workspace problem, reported elsewhere)", () => {
    const stray = t("ZZZ-M1-T1", 1);
    const p = schedule({ tasks: [stray, ...tasks], milestones, projects, settings, now: { date: MONDAY, minutes: 8 * 60 } });
    expect(codes(ganttRows(p, ws))).toEqual(["ALP-M1-T1", "ALP-M1-T2", "ALP-M2-T1", "BET-M1-T1"]);
  });

  it("omits tasks the scheduler left out", () => {
    const held = [projects[0], { ...projects[1], status: "on_hold" as const }];
    const p = schedule({ tasks, milestones, projects: held, settings, now: { date: MONDAY, minutes: 8 * 60 } });
    expect(codes(ganttRows(p, { milestones, projects: held }))).toEqual(["ALP-M1-T1", "ALP-M1-T2", "ALP-M2-T1"]);
  });
});

describe("ganttRange", () => {
  const rows = ganttRows(plan, ws);
  it("spans the plan and today, unless the filters set the bounds", () => {
    const r = ganttRange(rows, "2026-09-20");
    expect(r.from).toBe("2026-09-20");
    expect(r.to).toBe(TUESDAY);
    expect(ganttRange(rows, "2026-10-30")).toEqual({ from: MONDAY, to: "2026-10-30" });
    expect(ganttRange(rows, MONDAY, { from: "2026-10-01", to: "2026-10-05" })).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(ganttRange(rows, MONDAY, { from: "2026-12-01" })).toEqual({ from: "2026-12-01", to: "2026-12-01" });
    expect(ganttRange([], MONDAY)).toEqual({ from: MONDAY, to: MONDAY });
  });
});

describe("milestoneOptions / parseGanttQuery", () => {
  it("narrows milestone choices by the selected project codes", () => {
    expect(milestoneOptions(milestones, projects, []).map((x) => x.code)).toEqual(["ALP-M1", "ALP-M2", "BET-M1"]);
    expect(milestoneOptions(milestones, projects, ["ALP"]).map((x) => x.code)).toEqual(["ALP-M1", "ALP-M2"]);
    expect(milestoneOptions(milestones, projects, ["ALP", "BET"]).map((x) => x.code)).toEqual(["ALP-M1", "ALP-M2", "BET-M1"]);
  });

  it("parses repeated params (any case), validates dates and unit, and drops milestones outside the projects", () => {
    const q = parseGanttQuery(
      { project: "alp", milestone: ["ALP-M1", "bet-m1"], from: "2026-10-01", to: "nope", unit: "hour", at: "2026-09-29T09:30" },
      ws,
    );
    expect(q.filters).toEqual({ projects: ["ALP"], milestones: ["ALP-M1"], from: "2026-10-01", to: undefined });
    expect(q.unit).toBe("hour");
    expect(q.at).toEqual({ date: TUESDAY, time: "09:30" });
  });

  it("defaults to the day unit and no filters", () => {
    const q = parseGanttQuery({ unit: "decade", at: "garbage" }, ws);
    expect(q).toEqual({ filters: { projects: [], milestones: [], from: undefined, to: undefined }, unit: "day", at: undefined });
  });

  it("round-trips: the parsed filters select the same rows as the raw ones", () => {
    const { filters } = parseGanttQuery({ project: "ALP", milestone: "ALP-M2" }, ws);
    expect(codes(ganttRows(plan, ws, filters))).toEqual(["ALP-M2-T1"]);
  });
});
