import { lineage, lookup } from "./hierarchy";
import { UNITS, type Unit } from "./timescale";
import type { Block, ScheduleResult, ScheduledTask } from "./scheduler";
import { DATE, type MilestoneMeta, type Priority, type ProjectMeta, type TaskMeta, type TaskStatus } from "./types";

/**
 * Pure mapping from a computed schedule to Gantt rows: Project → Milestone → Task.
 * It only filters, groups and clips what the scheduler already decided — never reschedules.
 */

export interface GanttFilters {
  /** Project codes; empty/undefined = all. */
  projects?: string[];
  /** Milestone codes; empty/undefined = all. Combined with `projects` as AND. */
  milestones?: string[];
  /** Inclusive YYYY-MM-DD bounds; blocks outside are dropped, tasks with no block left are hidden. */
  from?: string;
  to?: string;
}

export interface GanttTask {
  id: string;
  code: string;
  title: string;
  priority: Priority;
  /** "todo" when the workspace's tasks weren't passed in. */
  status: TaskStatus;
  /** Effective deadline (task, milestone or project, whichever is earliest). */
  deadline?: string;
  /** Ids of tasks this one waits on (empty when the workspace's tasks weren't passed in). */
  depends_on: string[];
  /** The task's own estimate, when known. */
  estimate?: number;
  /** Hours the scheduler placed. */
  hours: number;
  /** Full scheduled span (not clipped by the date range). */
  start: ScheduledTask["start"];
  end: ScheduledTask["end"];
  /** Work blocks inside the date range, in time order. */
  blocks: Block[];
  late_days: number;
  /** Ends after its (inherited) deadline. */
  at_risk: boolean;
  pulled_forward: boolean;
}

export interface GanttMilestone {
  id: string;
  code: string;
  title: string;
  /** The milestone's own deadline, for its group row. */
  deadline?: string;
  tasks: GanttTask[];
}

export interface GanttProject {
  id: string;
  code: string;
  title: string;
  /** The project's own deadline, for its group row. */
  deadline?: string;
  milestones: GanttMilestone[];
}

export function ganttRows(
  plan: ScheduleResult,
  ws: { milestones: MilestoneMeta[]; projects: ProjectMeta[]; tasks?: TaskMeta[] },
  filters: GanttFilters = {},
): GanttProject[] {
  const parents = lookup(ws.milestones, ws.projects);
  const meta = new Map((ws.tasks ?? []).map((t) => [t.id, t]));
  const projectCodes = filters.projects?.length ? new Set(filters.projects) : undefined;
  const milestoneCodes = filters.milestones?.length ? new Set(filters.milestones) : undefined;
  const { from, to } = filters;

  const blocksByTask = new Map<string, Block[]>();
  for (const day of plan.days) {
    if ((from && day.date < from) || (to && day.date > to)) continue;
    for (const block of day.blocks) {
      const list = blocksByTask.get(block.task);
      if (list) list.push(block);
      else blocksByTask.set(block.task, [block]);
    }
  }

  // Map preserves first-seen order, so groups follow the scheduler's task order.
  const projects = new Map<string, GanttProject>();
  const milestoneRows = new Map<string, GanttMilestone>();

  for (const t of plan.tasks) {
    const { milestone, project } = lineage(t, parents);
    // Only a task whose parents are missing (reported as a workspace problem) lacks them.
    if (!milestone || !project) continue;
    if (projectCodes && !projectCodes.has(project.code)) continue;
    if (milestoneCodes && !milestoneCodes.has(milestone.code)) continue;

    const blocks = blocksByTask.get(t.id) ?? [];
    if ((from || to) && blocks.length === 0) continue;

    let p = projects.get(project.id);
    if (!p) {
      p = { id: project.id, code: project.code, title: project.title, deadline: project.deadline, milestones: [] };
      projects.set(project.id, p);
    }
    let m = milestoneRows.get(milestone.id);
    if (!m) {
      m = { id: milestone.id, code: milestone.code, title: milestone.title, deadline: milestone.deadline, tasks: [] };
      milestoneRows.set(milestone.id, m);
      p.milestones.push(m);
    }

    m.tasks.push({
      id: t.id,
      code: t.code,
      title: t.title,
      priority: t.priority,
      status: meta.get(t.id)?.status ?? "todo",
      deadline: t.deadline,
      depends_on: meta.get(t.id)?.depends_on ?? [],
      estimate: meta.get(t.id)?.estimate,
      hours: t.hours,
      start: t.start,
      end: t.end,
      blocks,
      late_days: t.late_days,
      at_risk: t.late_days > 0,
      pulled_forward: t.pulled_forward,
    });
  }

  return [...projects.values()];
}

/** Default axis range: the whole plan plus today, unless the filters set the bounds. */
export function ganttRange(rows: GanttProject[], today: string, filters: Pick<GanttFilters, "from" | "to"> = {}) {
  let lo = today;
  let hi = today;
  for (const p of rows)
    for (const m of p.milestones)
      for (const t of m.tasks) {
        if (t.start.date < lo) lo = t.start.date;
        if (t.end.date > hi) hi = t.end.date;
      }
  const from = filters.from ?? lo;
  return { from, to: filters.to ?? (hi < from ? from : hi) };
}

/** Milestone choices for the filter UI, narrowed to the selected project codes (all when none). */
export function milestoneOptions(milestones: MilestoneMeta[], projects: ProjectMeta[], selectedProjects: string[]): MilestoneMeta[] {
  if (!selectedProjects.length) return milestones;
  const ids = new Set(projects.filter((p) => selectedProjects.includes(p.code)).map((p) => p.id));
  return milestones.filter((m) => ids.has(m.project));
}

type Query = Record<string, string | string[] | undefined>;
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const codes = (v: string | string[] | undefined) => many(v).map((c) => c.trim().toUpperCase());
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const date = (v: string | string[] | undefined) => {
  const d = one(v);
  return d && DATE.test(d) ? d : undefined;
};

/** Filters, unit and view centre from the page's query (`?project=PMA&milestone=PMA-M1&from=&to=&unit=&at=`). */
export function parseGanttQuery(query: Query, ws: { milestones: MilestoneMeta[]; projects: ProjectMeta[] } = { milestones: [], projects: [] }) {
  const projects = codes(query.project);
  // A milestone filter only makes sense inside the selected projects.
  const allowed = new Set(milestoneOptions(ws.milestones, ws.projects, projects).map((m) => m.code));
  const selected = codes(query.milestone).filter((code) => !ws.milestones.length || allowed.has(code));
  const unit = UNITS.find((u) => u === one(query.unit)) ?? ("day" satisfies Unit);
  const at = one(query.at)?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  return {
    filters: { projects, milestones: selected, from: date(query.from), to: date(query.to) } satisfies GanttFilters,
    unit,
    at: at ? { date: at[1], time: at[2] } : undefined,
  };
}
