import { describe, expect, it } from "vitest";
import { newId } from "./codes";
import { schedule } from "./scheduler";
import { MilestoneMeta, ProjectMeta, Settings, TaskMeta } from "./types";

const settings = Settings.parse({ timezone: "UTC" }); // Mon–Fri 09–12, 13–17 (7h/day)
const MONDAY = "2026-09-28";
/** Tasks go in a milestone that isn't passed to the scheduler unless a test does, so they inherit nothing. */
const LOOSE = newId();

let n = 0;
function task(fields: Partial<TaskMeta> & { estimate?: number }): TaskMeta {
  n++;
  return TaskMeta.parse({ id: newId(), code: `TST-M1-T${n}`, number: n, title: `Task ${n}`, milestone: LOOSE, created: "2026-09-01", ...fields });
}

function project(fields: Partial<ProjectMeta>): ProjectMeta {
  return ProjectMeta.parse({ id: newId(), code: "PRJ", title: "Project", created: "2026-09-01", ...fields });
}

function milestone(number: number, fields: Partial<MilestoneMeta>): MilestoneMeta {
  return MilestoneMeta.parse({ id: newId(), code: `PRJ-M${number}`, number, title: `Milestone ${number}`, project: newId(), created: "2026-09-01", ...fields });
}

function run(
  tasks: TaskMeta[],
  opts: { now?: string; minutes?: number; settings?: Partial<Settings>; milestones?: MilestoneMeta[]; projects?: ProjectMeta[] } = {},
) {
  return schedule({
    tasks,
    milestones: opts.milestones,
    projects: opts.projects,
    settings: { ...settings, ...opts.settings },
    now: { date: opts.now ?? MONDAY, minutes: opts.minutes ?? 8 * 60 },
  });
}

describe("schedule", () => {
  it("packs tasks into working intervals in priority order, splitting across breaks and days", () => {
    n = 0;
    const low = task({ priority: "P2", estimate: 5 });
    const high = task({ priority: "P1", estimate: 4 });
    const plan = run([low, high]);

    expect(plan.days[0].blocks).toEqual([
      { task: high.id, date: MONDAY, start: "09:00", end: "12:00", hours: 3 },
      { task: high.id, date: MONDAY, start: "13:00", end: "14:00", hours: 1 },
      { task: low.id, date: MONDAY, start: "14:00", end: "17:00", hours: 3 },
    ]);
    expect(plan.days[1].blocks).toEqual([{ task: low.id, date: "2026-09-29", start: "09:00", end: "11:00", hours: 2 }]);
    expect(plan.finish).toEqual({ date: "2026-09-29", time: "11:00" });
    expect(plan.total_hours).toBe(9);
  });

  it("schedules prerequisites first and lets them inherit their dependents' priority", () => {
    n = 0;
    const prereq = task({ priority: "P3", estimate: 2 });
    const urgent = task({ priority: "P0", estimate: 2, depends_on: [prereq.id] });
    const medium = task({ priority: "P1", estimate: 2 });
    const plan = run([medium, urgent, prereq]);
    expect(plan.tasks.map((t) => t.id)).toEqual([prereq.id, urgent.id, medium.id]);
  });

  it("explains why tasks can't be scheduled", () => {
    n = 0;
    const blocked = task({ status: "blocked", estimate: 2 });
    const noEstimate = task({});
    const waiting = task({ estimate: 1, depends_on: [noEstimate.id] });
    const bId = newId();
    const a = task({ estimate: 1, depends_on: [bId] });
    const b = task({ id: bId, estimate: 1, depends_on: [a.id] });
    const plan = run([blocked, noEstimate, waiting, a, b]);
    const reasons = Object.fromEntries(plan.unscheduled.map((u) => [u.id, u.reason]));
    expect(reasons).toEqual({
      [blocked.id]: "status is blocked",
      [noEstimate.id]: "needs an estimate",
      [waiting.id]: "waiting on TST-M1-T2 (needs an estimate)",
      [a.id]: "dependency cycle",
      [b.id]: "dependency cycle",
    });
    expect(plan.tasks).toEqual([]);
  });

  it("ignores done dependencies and unknown ones (with a warning)", () => {
    n = 0;
    const done = task({ status: "done", estimate: 3 });
    const unknown = newId();
    const t = task({ estimate: 1, depends_on: [done.id, unknown] });
    const plan = run([done, t]);
    expect(plan.tasks.map((x) => x.id)).toEqual([t.id]);
    expect(plan.warnings).toContain(`TST-M1-T2 depends on unknown task ${unknown} (ignored).`);
  });

  it("pulls a lower-priority task forward when that avoids missing its deadline", () => {
    n = 0;
    const big = task({ priority: "P1", estimate: 14 });
    const due = task({ priority: "P3", estimate: 3, deadline: MONDAY });
    const plan = run([big, due]);
    expect(plan.tasks[0]).toMatchObject({ id: due.id, pulled_forward: true, late_days: 0 });
    expect(plan.at_risk).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("TST-M1-T2 was pulled ahead"))).toBe(true);
  });

  it("keeps priority order and reports the risk when pulling forward wouldn't help", () => {
    n = 0;
    const critical = task({ priority: "P0", estimate: 7, deadline: MONDAY });
    const other = task({ priority: "P3", estimate: 3, deadline: MONDAY });
    const plan = run([critical, other]);
    expect(plan.tasks.map((t) => t.id)).toEqual([critical.id, other.id]);
    expect(plan.at_risk).toEqual([
      { id: other.id, code: "TST-M1-T2", title: other.title, deadline: MONDAY, end: "2026-09-29", late_days: 1 },
    ]);
  });

  it("inherits milestone priority and deadline", () => {
    n = 0;
    const launch = milestone(1, { title: "Launch", priority: "P0", deadline: MONDAY });
    const plain = task({ estimate: 7 });
    const inMilestone = task({ estimate: 2, milestone: launch.id });
    const plan = run([plain, inMilestone], { milestones: [launch] });
    expect(plan.tasks[0]).toMatchObject({ id: inMilestone.id, code: "TST-M1-T2", milestone: launch.id, priority: "P0", deadline: MONDAY });
  });

  it("inherits priority and deadline through milestone → project", () => {
    n = 0;
    const launch = project({ title: "Launch", priority: "P0", deadline: MONDAY });
    const milestones = [
      milestone(1, { title: "Inherits", project: launch.id }),
      milestone(2, { title: "Own priority", project: launch.id, priority: "P3", deadline: "2026-10-30" }),
    ];
    const plain = task({ priority: "P1", estimate: 1 });
    const viaProject = task({ estimate: 1, milestone: milestones[0].id });
    const viaMilestone = task({ estimate: 1, milestone: milestones[1].id });
    const plan = run([plain, viaProject, viaMilestone], { milestones, projects: [launch] });
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    expect(byId[viaProject.id]).toMatchObject({ priority: "P0", deadline: MONDAY });
    // The milestone's own priority wins; the earliest deadline in the chain applies.
    expect(byId[viaMilestone.id]).toMatchObject({ priority: "P3", deadline: MONDAY });
    expect(plan.tasks[0].id).toBe(viaProject.id);
  });

  it("keeps tasks of on-hold projects off the schedule, and anything waiting on them", () => {
    n = 0;
    const paused = project({ code: "PSD", title: "Paused", status: "on_hold", priority: "P1" });
    const m = milestone(1, { project: paused.id });
    const inPaused = task({ estimate: 2, milestone: m.id });
    const waiting = task({ estimate: 1, depends_on: [inPaused.id] });
    const free = task({ estimate: 1 });
    const plan = run([inPaused, waiting, free], { milestones: [m], projects: [paused] });
    expect(plan.tasks.map((t) => t.id)).toEqual([free.id]);
    expect(Object.fromEntries(plan.unscheduled.map((u) => [u.code, u.reason]))).toEqual({
      "TST-M1-T1": "project PSD is on hold",
      "TST-M1-T2": "waiting on TST-M1-T1 (project PSD is on hold)",
    });
  });

  it("applies the buffer to the estimate and subtracts time already spent", () => {
    n = 0;
    const t = task({ estimate: 4, spent: 1, status: "in_progress" });
    const plan = run([t], { settings: { buffer: 1.5 } });
    expect(plan.tasks[0].hours).toBe(5);
  });

  it("warns when a task has used up its estimate and when it's too big", () => {
    n = 0;
    const over = task({ estimate: 2, spent: 3, status: "in_progress" });
    const huge = task({ estimate: 12 });
    const plan = run([over, huge]);
    expect(plan.tasks.find((t) => t.id === over.id)?.hours).toBe(0.5);
    expect(plan.warnings.join("\n")).toMatch(/TST-M1-T1 has used its estimate/);
    expect(plan.warnings.join("\n")).toMatch(/TST-M1-T2 is estimated at 12h/);
  });

  it("respects not_before, weekends, days off and overrides", () => {
    n = 0;
    const later = task({ estimate: 2, not_before: "2026-09-30" });
    const now = task({ estimate: 1, priority: "P3" });
    const plan = run([later, now], {
      settings: { days_off: ["2026-09-30"], overrides: { "2026-10-01": ["14:00-15:00"] } },
    });
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    expect(byId[now.id].start).toEqual({ date: MONDAY, time: "09:00" });
    // Wednesday is a day off and Thursday only has 14:00–15:00 → finishes Friday.
    expect(byId[later.id].start).toEqual({ date: "2026-10-01", time: "14:00" });
    expect(byId[later.id].end).toEqual({ date: "2026-10-02", time: "10:00" });

    const weekend = run([task({ estimate: 3 })], { now: "2026-10-02", minutes: 15 * 60 });
    expect(weekend.tasks[0].end).toEqual({ date: "2026-10-05", time: "10:00" });
  });

  it("starts from the current time and skips slivers shorter than min_block_hours", () => {
    n = 0;
    const plan = run([task({ estimate: 2 })], { minutes: 11 * 60 + 40 }); // 11:45 → only 15 min before lunch
    expect(plan.tasks[0].start).toEqual({ date: MONDAY, time: "13:00" });
    expect(plan.from).toEqual({ date: MONDAY, time: "11:45" });
  });

  it("finishes in-progress work before starting new work at the same priority", () => {
    n = 0;
    const fresh = task({ estimate: 1 });
    const started = task({ estimate: 1, status: "in_progress" });
    expect(run([fresh, started]).tasks[0].id).toBe(started.id);
  });

  it("uses manual order as a tie-breaker", () => {
    n = 0;
    const a = task({ estimate: 1, order: 2 });
    const b = task({ estimate: 1, order: 1 });
    const c = task({ estimate: 1 });
    expect(run([a, b, c]).tasks.map((t) => t.id)).toEqual([b.id, a.id, c.id]);
  });

  it("breaks the last tie by code, in natural order (T2 before T10), whatever the ids", () => {
    n = 0;
    const t10 = task({ estimate: 1, code: "TST-M1-T10", number: 10 });
    const m2 = task({ estimate: 1, code: "TST-M2-T1" });
    const t2 = task({ estimate: 1, code: "TST-M1-T2", number: 2 });
    expect(run([t10, m2, t2]).tasks.map((t) => t.code)).toEqual(["TST-M1-T2", "TST-M1-T10", "TST-M2-T1"]);
  });

  it("reports work beyond the horizon as unscheduled", () => {
    n = 0;
    const plan = run([task({ estimate: 50 })], { settings: { horizon_days: 3 } });
    expect(plan.unscheduled[0].reason).toBe("doesn't fit in the next 3 days");
  });
});
