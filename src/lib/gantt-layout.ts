import type { GanttMilestone, GanttProject, GanttTask } from "./gantt";
import { fmtDay, fmtHours } from "./time";
import type { TimePoint, TimeScale } from "./timescale";

/** Pure geometry for the chart: where bars and markers sit on a `TimeScale`. */

export interface Segment {
  x: number;
  width: number;
}

/** Narrowest bar that is still visible and clickable. */
export const MIN_BAR = 3;

/** Pixel span between two points, clipped to the axis; undefined when entirely outside it. */
export function segment(scale: TimeScale, from: TimePoint, to: TimePoint): Segment | undefined {
  const x0 = scale.toX(from);
  const x1 = scale.toX(to);
  if (x1 <= 0 || x0 >= scale.width) return undefined;
  const x = Math.max(0, x0);
  return { x, width: Math.min(Math.max(x1 - x, MIN_BAR), scale.width - x) };
}

/**
 * A task's bar: one span from start to end in the week/day views, one segment per work block in
 * the hour/minute views so the gaps outside working hours stay visible.
 */
export function taskSegments(task: GanttTask, scale: TimeScale): Segment[] {
  const span = () => segment(scale, task.start, task.end);
  if (scale.unit === "week" || scale.unit === "day" || task.blocks.length === 0) return [span()].filter((s) => s !== undefined);
  return task.blocks
    .map((b) => segment(scale, { date: b.date, time: b.start }, { date: b.date, time: b.end }))
    .filter((s) => s !== undefined);
}

/** Earliest start to latest end over some tasks (their full scheduled spans). */
export function groupSpan(tasks: GanttTask[]): { start: TimePoint; end: TimePoint } | undefined {
  const key = (p: { date: string; time: string }) => `${p.date}T${p.time}`;
  let start: GanttTask["start"] | undefined;
  let end: GanttTask["end"] | undefined;
  for (const t of tasks) {
    if (!start || key(t.start) < key(start)) start = t.start;
    if (!end || key(t.end) > key(end)) end = t.end;
  }
  return start && end ? { start, end } : undefined;
}

/** A deadline is due at the end of its day. Undefined when off the axis. */
export function deadlineX(deadline: string | undefined, scale: TimeScale): number | undefined {
  if (!deadline) return undefined;
  const x = scale.toX({ date: deadline, time: "23:59" });
  return x >= 0 && x <= scale.width ? x : undefined;
}

/** Where "now" falls on the axis; undefined when off it. */
export function nowX(now: { date: string; time: string }, scale: TimeScale): number | undefined {
  const x = scale.toX(now);
  return x >= 0 && x <= scale.width ? x : undefined;
}

export function taskTooltip(task: GanttTask): string {
  const when = (p: GanttTask["start"]) => `${fmtDay(p.date)} ${p.time}`;
  return [
    `${task.code} · ${task.title}`,
    `${task.priority} · ${task.estimate !== undefined ? `${fmtHours(task.estimate)} estimate` : `${fmtHours(task.hours)} scheduled`} · ${task.status.replace("_", " ")}`,
    `${when(task.start)} → ${when(task.end)}`,
    task.deadline ? `Due ${fmtDay(task.deadline)}${task.at_risk ? ` · ${task.late_days}d late` : ""}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export type VisibleRow =
  | { kind: "project"; key: string; project: GanttProject }
  | { kind: "milestone"; key: string; project: GanttProject; milestone: GanttMilestone }
  | { kind: "task"; key: string; task: GanttTask };

export const projectKey = (p: GanttProject) => `p:${p.id}`;
export const milestoneKey = (m: GanttMilestone) => `m:${m.id}`;

/** The rows on screen, top to bottom, honouring collapsed project/milestone keys. */
export function visibleRows(rows: GanttProject[], collapsed: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  for (const project of rows) {
    const pKey = projectKey(project);
    out.push({ kind: "project", key: pKey, project });
    if (collapsed.has(pKey)) continue;
    for (const milestone of project.milestones) {
      const mKey = milestoneKey(milestone);
      out.push({ kind: "milestone", key: mKey, project, milestone });
      if (collapsed.has(mKey)) continue;
      for (const task of milestone.tasks) out.push({ kind: "task", key: task.id, task });
    }
  }
  return out;
}

export interface Arrow {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Connectors from the end of each prerequisite's bar to the start of the task that waits on it.
 * Only drawn when both tasks are on screen (not filtered out, not collapsed, inside the axis).
 * `y` is the vertical centre of a row of height `rowHeight`, measured from the first row.
 */
export function dependencyArrows(rows: VisibleRow[], scale: TimeScale, rowHeight: number): Arrow[] {
  const bars = new Map<string, { first: Segment; last: Segment; y: number }>();
  rows.forEach((row, i) => {
    if (row.kind !== "task") return;
    const segs = taskSegments(row.task, scale);
    if (segs.length) bars.set(row.task.id, { first: segs[0], last: segs[segs.length - 1], y: i * rowHeight + rowHeight / 2 });
  });
  const arrows: Arrow[] = [];
  for (const row of rows) {
    if (row.kind !== "task") continue;
    const to = bars.get(row.task.id);
    if (!to) continue;
    for (const dep of row.task.depends_on) {
      const from = bars.get(dep);
      if (from) arrows.push({ from: dep, to: row.task.id, x1: from.last.x + from.last.width, y1: from.y, x2: to.first.x, y2: to.y });
    }
  }
  return arrows;
}
