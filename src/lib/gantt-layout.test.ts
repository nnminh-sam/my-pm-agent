import { describe, expect, it } from "vitest";
import { newId } from "./codes";
import { ganttRows, type GanttTask } from "./gantt";
import { dependencyArrows, deadlineX, groupSpan, milestoneKey, MIN_BAR, nowX, projectKey, segment, taskSegments, taskTooltip, visibleRows } from "./gantt-layout";
import { schedule } from "./scheduler";
import { makeScale, UNITS } from "./timescale";
import { MilestoneMeta, ProjectMeta, Settings, TaskMeta } from "./types";

const settings = Settings.parse({ timezone: "UTC" }); // Mon–Fri 09–12, 13–17
const MONDAY = "2026-09-28";
const projects = [ProjectMeta.parse({ id: newId(), code: "ALP", title: "Alpha", created: "2026-09-01" })];
const milestones = [MilestoneMeta.parse({ id: newId(), code: "ALP-M1", number: 1, title: "Login", project: projects[0].id, created: "2026-09-01" })];
const task = (number: number, fields: Partial<TaskMeta>) =>
  TaskMeta.parse({ id: newId(), code: `ALP-M1-T${number}`, number, milestone: milestones[0].id, created: "2026-09-01", ...fields });
const tasks = [
  task(1, { title: "Spans lunch", estimate: 5, deadline: MONDAY, status: "in_progress" }),
  task(2, { title: "Next day", estimate: 4 }),
];
const plan = schedule({ tasks, milestones, projects, settings, now: { date: MONDAY, minutes: 8 * 60 } });
const [t1, t2] = ganttRows(plan, { milestones, projects, tasks })[0].milestones[0].tasks;

describe("taskSegments", () => {
  it("draws one span per work block in hour view, leaving the lunch gap", () => {
    const s = makeScale("hour", MONDAY, "2026-09-29");
    // ALP-M1-T1: 09:00–12:00 and 13:00–15:00 → two segments 1 hour apart.
    expect(taskSegments(t1, s)).toEqual([
      { x: 9 * 64, width: 3 * 64 },
      { x: 13 * 64, width: 2 * 64 },
    ]);
  });

  it("draws one span in day and week view", () => {
    const day = makeScale("day", MONDAY, "2026-09-29");
    expect(taskSegments(t1, day)).toEqual([{ x: day.toX({ date: MONDAY, time: "09:00" }), width: day.spanWidth({ date: MONDAY, time: "09:00" }, { date: MONDAY, time: "15:00" }) }]);
    const week = makeScale("week", MONDAY, MONDAY);
    expect(taskSegments(t1, week)).toHaveLength(1);
  });

  it("aligns to the ticks: a block starting on the hour begins exactly on a minor tick", () => {
    const s = makeScale("hour", MONDAY, MONDAY);
    const [first] = taskSegments(t1, s);
    expect(s.minor.find((t) => t.label === "09:00")!.x).toBe(first.x);
    const m = makeScale("minute", MONDAY, MONDAY);
    expect(m.minor.find((t) => t.label === "09:00")!.x).toBe(taskSegments(t1, m)[0].x);
  });

  it("clips to the axis, drops what is fully outside and keeps tiny bars visible", () => {
    const m = makeScale("minute", MONDAY, MONDAY);
    const next = makeScale("hour", "2026-09-29", "2026-09-29");
    expect(taskSegments(t1, next)).toEqual([]); // ALP-M1-T1 is all Monday
    expect(taskSegments(t2, m)).toEqual([{ x: 900 * 8, width: 120 * 8 }]); // only its Monday 15:00–17:00 block; Tuesday is off this axis
    const week = makeScale("week", MONDAY, MONDAY);
    expect(taskSegments(t1, week)[0].width).toBe(5); // 6h at 20px/day
    expect(segment(week, { date: MONDAY, time: "09:00" }, { date: MONDAY, time: "10:00" })!.width).toBe(MIN_BAR); // 1h is under 3px
    const cut = segment(makeScale("hour", MONDAY, MONDAY), { date: "2026-09-27", time: "20:00" }, { date: MONDAY, time: "01:00" });
    expect(cut).toEqual({ x: 0, width: 64 });
  });

  it.each(UNITS)("%s: every segment lies inside the axis", (unit) => {
    const s = makeScale(unit, MONDAY, "2026-09-29");
    for (const t of [t1, t2]) for (const seg of taskSegments(t, s)) expect(seg.x >= 0 && seg.x + seg.width <= s.width).toBe(true);
  });
});

describe("group span, markers and tooltip", () => {
  it("groupSpan covers earliest start to latest end", () => {
    expect(groupSpan([t1, t2])).toEqual({ start: t1.start, end: t2.end });
    expect(groupSpan([])).toBeUndefined();
  });

  it("deadlineX is the end of the deadline day; nowX is the exact moment; both are undefined off-axis", () => {
    const s = makeScale("hour", MONDAY, "2026-09-29");
    expect(deadlineX(MONDAY, s)).toBe(s.toX({ date: MONDAY, time: "23:59" }));
    expect(deadlineX(undefined, s)).toBeUndefined();
    expect(deadlineX("2026-12-01", s)).toBeUndefined();
    expect(nowX({ date: MONDAY, time: "10:30" }, s)).toBe(10.5 * 64);
    expect(nowX({ date: "2026-10-30", time: "10:30" }, s)).toBeUndefined();
  });

  it("tooltip carries code, title, estimate, span and lateness", () => {
    const late: GanttTask = { ...t1, deadline: "2026-09-25", late_days: 3, at_risk: true };
    expect(taskTooltip(late).split("\n")).toEqual([
      "ALP-M1-T1 · Spans lunch",
      "P2 · 5h estimate · in progress",
      "Mon 28 Sep 09:00 → Mon 28 Sep 15:00",
      "Due Fri 25 Sep · 3d late",
    ]);
    expect(taskTooltip({ ...t1, deadline: undefined, estimate: undefined }).split("\n")[1]).toBe("P2 · 5h scheduled · in progress");
  });
});

describe("visibleRows / dependencyArrows", () => {
  const dep = task(3, { title: "Waits", estimate: 1, depends_on: [tasks[0].id, tasks[1].id, newId()] });
  const all = [...tasks, dep];
  const p = schedule({ tasks: all, milestones, projects, settings, now: { date: MONDAY, minutes: 8 * 60 } });
  const rows = ganttRows(p, { milestones, projects, tasks: all });
  const [prj] = rows;
  const scale = makeScale("day", MONDAY, "2026-09-30");

  it("lists project, milestone and task rows, dropping collapsed children", () => {
    const mKey = milestoneKey(prj.milestones[0]);
    expect(visibleRows(rows, new Set()).map((r) => r.key)).toEqual([projectKey(prj), mKey, ...all.map((t) => t.id)]);
    expect(visibleRows(rows, new Set([mKey])).map((r) => r.key)).toEqual([projectKey(prj), mKey]);
    expect(visibleRows(rows, new Set([projectKey(prj)])).map((r) => r.key)).toEqual([projectKey(prj)]);
  });

  it("draws end-of-prerequisite → start-of-dependent arrows, ignoring unknown ids", () => {
    const list = visibleRows(rows, new Set());
    const arrows = dependencyArrows(list, scale, 32);
    expect(arrows.map((a) => [a.from, a.to])).toEqual([
      [tasks[0].id, dep.id],
      [tasks[1].id, dep.id],
    ]);
    const [a] = arrows;
    const t1Bar = taskSegments(rows[0].milestones[0].tasks[0], scale)[0];
    const t3Bar = taskSegments(rows[0].milestones[0].tasks[2], scale)[0];
    expect(a.x1).toBe(t1Bar.x + t1Bar.width);
    expect(a.x2).toBe(t3Bar.x);
    // Rows 2, 3, 4 (after the project and milestone rows): centres are row * height + half.
    expect([a.y1, a.y2]).toEqual([2 * 32 + 16, 4 * 32 + 16]);
  });

  it("hides an arrow when either end is collapsed away or off the axis", () => {
    expect(dependencyArrows(visibleRows(rows, new Set([milestoneKey(prj.milestones[0])])), scale, 32)).toEqual([]);
    const tuesdayOnly = makeScale("hour", "2026-09-30", "2026-09-30");
    expect(dependencyArrows(visibleRows(rows, new Set()), tuesdayOnly, 32)).toEqual([]);
  });
});
