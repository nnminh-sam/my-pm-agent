import { compareCodes } from "./codes";
import { earliestDate, inheritedPriority, lineage, lookup, projectHold } from "./hierarchy";
import { addDays, daysBetween, fmtTime, parseInterval, weekday } from "./time";
import type { MilestoneMeta, Priority, ProjectMeta, Settings, TaskMeta } from "./types";

/**
 * Single-person scheduler.
 *
 * Tasks are laid out back-to-back into working intervals, one at a time
 * (list scheduling), picking the best *ready* task each time:
 *   1. tasks pulled forward to meet a deadline (see below), earliest deadline first
 *   2. priority (P0 first) — inherited from anything that depends on the task
 *   3. in-progress before not started
 *   4. earliest deadline (task's own, its milestone's or its project's)
 *   5. manual `order`, then code (PMA-M1-T2 before PMA-M1-T10)
 * A task is ready when its open dependencies are scheduled and `not_before` has passed.
 * Results carry task ids (for joining) and codes; messages name tasks by code.
 * Tasks in projects that are on hold, done or cancelled aren't scheduled.
 *
 * Deadline repair: after a pass, each late task is tried "pulled forward" ahead of the
 * priority order; the change is kept only if it reduces total priority-weighted lateness.
 */

export interface Block {
  task: string;
  date: string;
  start: string;
  end: string;
  hours: number;
}

export interface ScheduledTask {
  id: string;
  code: string;
  title: string;
  milestone: string;
  priority: Priority;
  deadline?: string;
  hours: number;
  start: { date: string; time: string };
  end: { date: string; time: string };
  late_days: number;
  pulled_forward: boolean;
}

export interface DayPlan {
  date: string;
  capacity_hours: number;
  planned_hours: number;
  blocks: Block[];
}

export interface ScheduleResult {
  from: { date: string; time: string };
  days: DayPlan[];
  tasks: ScheduledTask[];
  at_risk: { id: string; code: string; title: string; deadline: string; end: string; late_days: number }[];
  unscheduled: { id: string; code: string; title: string; reason: string }[];
  warnings: string[];
  total_hours: number;
  finish?: { date: string; time: string };
}

export interface ScheduleInput {
  tasks: TaskMeta[];
  milestones?: MilestoneMeta[];
  projects?: ProjectMeta[];
  settings: Settings;
  now: { date: string; minutes: number };
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const LATENESS_WEIGHT: Record<Priority, number> = { P0: 8, P1: 4, P2: 2, P3: 1 };
const OPEN = new Set(["todo", "in_progress", "blocked"]);
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Prepared {
  id: string;
  task: TaskMeta;
  priority: Priority;
  rank: number; // inherited priority rank
  deadline?: string; // own, milestone or project deadline
  inheritedDeadline?: string; // earliest deadline among itself and dependents
  minutes: number;
  deps: string[]; // open, schedulable prerequisites
  dependents: string[];
}

export function schedule(input: ScheduleInput): ScheduleResult {
  const { settings, now } = input;
  const parents = lookup(input.milestones, input.projects);
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const warnings: string[] = [];
  const unscheduled: ScheduleResult["unscheduled"] = [];

  // --- 1. Decide which open tasks can be scheduled at all -------------------
  const open = input.tasks.filter((t) => OPEN.has(t.status));
  const blockedReason = new Map<string, string | null>();
  const visiting = new Set<string>();

  const reasonFor = (task: TaskMeta): string | null => {
    if (blockedReason.has(task.id)) return blockedReason.get(task.id)!;
    if (visiting.has(task.id)) return "dependency cycle";
    visiting.add(task.id);
    let reason: string | null = null;
    const hold = projectHold(lineage(task, parents).project);
    if (hold) reason = hold;
    else if (task.status === "blocked") reason = "status is blocked";
    else if (task.estimate === undefined) reason = "needs an estimate";
    else {
      for (const depId of task.depends_on) {
        const dep = byId.get(depId);
        if (!dep) continue;
        if (!OPEN.has(dep.status)) continue;
        const depReason = reasonFor(dep);
        if (depReason) {
          reason = depReason === "dependency cycle" ? depReason : `waiting on ${dep.code} (${depReason})`;
          break;
        }
      }
    }
    visiting.delete(task.id);
    blockedReason.set(task.id, reason);
    return reason;
  };

  for (const task of open) {
    for (const depId of task.depends_on) {
      if (!byId.has(depId)) warnings.push(`${task.code} depends on unknown task ${depId} (ignored).`);
    }
  }

  const prepared = new Map<string, Prepared>();
  const buffer = settings.buffer;
  const minBlock = Math.round(settings.min_block_hours * 60);
  for (const task of open) {
    const reason = reasonFor(task);
    if (reason) {
      unscheduled.push({ id: task.id, code: task.code, title: task.title, reason });
      continue;
    }
    const { milestone, project } = lineage(task, parents);
    const priority = inheritedPriority(task.priority, milestone?.priority, project?.priority);
    const estimate = task.estimate!;
    let remaining = estimate * buffer - task.spent;
    if (remaining <= 0) {
      warnings.push(
        `${task.code} has used its estimate (${round2(task.spent)}h spent of ${estimate}h) but isn't done — re-estimate the remaining work.`,
      );
      remaining = settings.min_block_hours;
    }
    if (estimate > settings.max_task_hours) {
      warnings.push(`${task.code} is estimated at ${estimate}h — consider breaking it down (max ${settings.max_task_hours}h).`);
    }
    prepared.set(task.id, {
      id: task.id,
      task,
      priority,
      rank: PRIORITY_RANK[priority],
      deadline: earliestDate(task.deadline, milestone?.deadline, project?.deadline),
      minutes: Math.max(1, Math.round(remaining * 60)),
      deps: [],
      dependents: [],
    });
  }
  for (const p of prepared.values()) {
    for (const depId of p.task.depends_on) {
      const dep = prepared.get(depId);
      if (dep && depId !== p.id) {
        p.deps.push(depId);
        dep.dependents.push(p.id);
      }
    }
  }

  // --- 2. Prerequisites inherit urgency from what depends on them ------------
  const inherited = new Map<string, { rank: number; deadline?: string }>();
  const inherit = (id: string): { rank: number; deadline?: string } => {
    const cached = inherited.get(id);
    if (cached) return cached;
    const p = prepared.get(id)!;
    let rank = p.rank;
    let deadline = p.deadline;
    inherited.set(id, { rank, deadline }); // guards against residual cycles
    for (const d of p.dependents) {
      const up = inherit(d);
      rank = Math.min(rank, up.rank);
      deadline = earliestDate(deadline, up.deadline);
    }
    const result = { rank, deadline };
    inherited.set(id, result);
    return result;
  };
  for (const p of prepared.values()) {
    const up = inherit(p.id);
    p.rank = up.rank;
    p.inheritedDeadline = up.deadline;
  }

  // --- 3. Working calendar ---------------------------------------------------
  const startMinute = Math.ceil(now.minutes / 15) * 15;
  const calendar: { date: string; intervals: [number, number][] }[] = [];
  for (let i = 0; i < settings.horizon_days; i++) {
    const date = addDays(now.date, i);
    const specs =
      settings.overrides[date] ?? (settings.days_off.includes(date) ? [] : (settings.work_hours[weekday(date)] ?? []));
    const intervals = specs
      .map(parseInterval)
      .map(([s, e]): [number, number] => (i === 0 ? [Math.max(s, startMinute), e] : [s, e]))
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    calendar.push({ date, intervals });
  }

  // --- 4. Simulate, then repair deadlines ------------------------------------
  const pullDeadline = (boosted: Set<string>) => {
    // A boosted task pulls its whole prerequisite chain forward with it.
    const result = new Map<string, string>();
    const visit = (id: string, deadline: string) => {
      const current = result.get(id);
      if (current && current <= deadline) return;
      result.set(id, deadline);
      for (const dep of prepared.get(id)!.deps) visit(dep, deadline);
    };
    for (const id of boosted) {
      const p = prepared.get(id);
      if (p?.deadline) visit(id, p.deadline);
    }
    return result;
  };

  const simulate = (boosted: Set<string>) => {
    const pulled = pullDeadline(boosted);
    const compare = (a: Prepared, b: Prepared) => {
      const pa = pulled.get(a.id);
      const pb = pulled.get(b.id);
      if (pa !== pb) {
        if (pa === undefined) return 1;
        if (pb === undefined) return -1;
        return pa < pb ? -1 : 1;
      }
      if (a.rank !== b.rank) return a.rank - b.rank;
      const ia = a.task.status === "in_progress" ? 0 : 1;
      const ib = b.task.status === "in_progress" ? 0 : 1;
      if (ia !== ib) return ia - ib;
      const da = a.inheritedDeadline ?? "9999-99-99";
      const db = b.inheritedDeadline ?? "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      const oa = a.task.order ?? Number.MAX_SAFE_INTEGER;
      const ob = b.task.order ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return compareCodes(a.task.code, b.task.code);
    };

    const blocks: Block[] = [];
    const placed = new Map<string, ScheduledTask>();
    const overflow: string[] = [];
    let day = 0;
    let slot = 0;
    let minute = calendar[0]?.intervals[0]?.[0] ?? 0;

    const advanceSlot = () => {
      slot++;
      while (day < calendar.length && slot >= calendar[day].intervals.length) {
        day++;
        slot = 0;
      }
      if (day < calendar.length) minute = calendar[day].intervals[slot][0];
    };
    if (day < calendar.length && calendar[0].intervals.length === 0) {
      slot = -1;
      advanceSlot();
    }

    const pending = new Set(prepared.keys());
    while (pending.size && day < calendar.length) {
      const date = calendar[day].date;
      const ready = [...pending]
        .map((id) => prepared.get(id)!)
        .filter((p) => p.deps.every((d) => placed.has(d)) && (!p.task.not_before || p.task.not_before <= date));
      if (!ready.length) {
        // Everything left is waiting for a not_before date: jump to the next day.
        slot = calendar[day].intervals.length - 1;
        advanceSlot();
        continue;
      }
      const next = ready.sort(compare)[0];
      pending.delete(next.id);

      let remaining = next.minutes;
      let first: Block | undefined;
      let last: Block | undefined;
      while (remaining > 0 && day < calendar.length) {
        const [, end] = calendar[day].intervals[slot];
        const free = end - minute;
        if (free < Math.min(minBlock, remaining)) {
          advanceSlot();
          continue;
        }
        const take = Math.min(free, remaining);
        last = {
          task: next.id,
          date: calendar[day].date,
          start: fmtTime(minute),
          end: fmtTime(minute + take),
          hours: round2(take / 60),
        };
        first ??= last;
        blocks.push(last);
        minute += take;
        remaining -= take;
        if (minute >= end) advanceSlot();
      }
      if (remaining > 0 || !first || !last) {
        overflow.push(next.id);
        continue;
      }
      const lateDays = next.deadline && last.date > next.deadline ? daysBetween(next.deadline, last.date) : 0;
      placed.set(next.id, {
        id: next.id,
        code: next.task.code,
        title: next.task.title,
        milestone: next.task.milestone,
        priority: next.priority,
        deadline: next.deadline,
        hours: round2(next.minutes / 60),
        start: { date: first.date, time: first.start },
        end: { date: last.date, time: last.end },
        late_days: lateDays,
        pulled_forward: pulled.has(next.id),
      });
    }
    overflow.push(...pending);
    const lateness = [...placed.values()].reduce((sum, t) => sum + t.late_days * LATENESS_WEIGHT[t.priority], 0);
    return { blocks, placed, overflow, lateness };
  };

  let boosted = new Set<string>();
  let run = simulate(boosted);
  let budget = 60; // simulations; keeps big backlogs fast
  while (run.lateness > 0 && budget > 0) {
    const late = [...run.placed.values()]
      .filter((t) => t.late_days > 0 && !boosted.has(t.id))
      .sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1));
    let improved = false;
    for (const t of late) {
      if (budget-- <= 0) break;
      const trial = new Set(boosted).add(t.id);
      const candidate = simulate(trial);
      if (candidate.lateness < run.lateness && candidate.overflow.length <= run.overflow.length) {
        boosted = trial;
        run = candidate;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }

  // --- 5. Shape the result ---------------------------------------------------
  for (const id of run.overflow) {
    const p = prepared.get(id)!;
    unscheduled.push({ id, code: p.task.code, title: p.task.title, reason: `doesn't fit in the next ${settings.horizon_days} days` });
  }
  const tasks = [...run.placed.values()];
  for (const t of tasks) {
    if (t.pulled_forward && boosted.has(t.id)) {
      warnings.push(`${t.code} was pulled ahead of higher-priority work to meet its ${t.deadline} deadline.`);
    }
  }

  const lastDate = run.blocks.at(-1)?.date ?? now.date;
  const days: DayPlan[] = [];
  for (const { date, intervals } of calendar) {
    if (date > lastDate) break;
    const capacity = intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
    const dayBlocks = run.blocks.filter((b) => b.date === date);
    if (!capacity && !dayBlocks.length) continue;
    days.push({
      date,
      capacity_hours: round2(capacity / 60),
      planned_hours: round2(dayBlocks.reduce((sum, b) => sum + b.hours, 0)),
      blocks: dayBlocks,
    });
  }

  const finish = tasks.reduce<ScheduledTask | undefined>(
    (latest, t) => (!latest || `${t.end.date} ${t.end.time}` > `${latest.end.date} ${latest.end.time}` ? t : latest),
    undefined,
  );

  return {
    from: { date: now.date, time: fmtTime(startMinute) },
    days,
    tasks,
    at_risk: tasks
      .filter((t) => t.late_days > 0)
      .map((t) => ({ id: t.id, code: t.code, title: t.title, deadline: t.deadline!, end: t.end.date, late_days: t.late_days })),
    unscheduled,
    warnings,
    total_hours: round2(tasks.reduce((sum, t) => sum + t.hours, 0)),
    finish: finish?.end,
  };
}
