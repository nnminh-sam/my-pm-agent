import { rollup } from "./estimation";
import { earliestDate, inheritedPriority } from "./hierarchy";
import { schedule, type ScheduleResult } from "./scheduler";
import { fmtDay, fmtHours, nowIn } from "./time";
import type { Milestone, Project, Task } from "./types";
import type { Workspace } from "./repo";

export function scheduleFor(ws: Workspace, at?: Date): ScheduleResult {
  return schedule({
    tasks: ws.tasks,
    milestones: ws.milestones,
    projects: ws.projects,
    settings: ws.settings,
    now: nowIn(ws.settings.timezone, at),
  });
}

/** Rollup + schedule outlook for any group of tasks. */
function outlook(tasks: Task[], plan: ScheduleResult, deadline?: string) {
  const ids = new Set(tasks.map((t) => t.id));
  const projected = plan.tasks
    .filter((t) => ids.has(t.id))
    .reduce<string | undefined>((max, t) => (!max || t.end.date > max ? t.end.date : max), undefined);
  const unscheduled = plan.unscheduled.filter((u) => ids.has(u.id));
  return {
    ...rollup(tasks),
    projected_finish: projected,
    on_track: deadline && projected ? projected <= deadline : undefined,
    unscheduled: unscheduled.length,
  };
}

/** The milestone's own values, or what it inherits from its project. */
export function milestoneEffective(milestone: Milestone, ws: Pick<Workspace, "projects">) {
  const project = ws.projects.find((p) => p.id === milestone.project);
  return {
    project,
    priority: inheritedPriority(milestone.priority, project?.priority),
    deadline: earliestDate(milestone.deadline, project?.deadline),
  };
}

export function milestoneSummary(milestone: Milestone, ws: Workspace, plan: ScheduleResult) {
  const { project, priority, deadline } = milestoneEffective(milestone, ws);
  return {
    code: milestone.code,
    id: milestone.id,
    title: milestone.title,
    project: project?.code,
    status: milestone.status,
    stage: milestone.stage,
    priority,
    deadline,
    ...outlook(
      ws.tasks.filter((t) => t.milestone === milestone.id),
      plan,
      deadline,
    ),
  };
}

export function projectSummary(project: Project, ws: Workspace, plan: ScheduleResult) {
  const milestones = ws.milestones.filter((m) => m.project === project.id);
  const milestoneIds = new Set(milestones.map((m) => m.id));
  const milestoneCounts: Record<string, number> = {};
  for (const m of milestones) milestoneCounts[m.status] = (milestoneCounts[m.status] ?? 0) + 1;
  return {
    code: project.code,
    id: project.id,
    title: project.title,
    status: project.status,
    priority: project.priority,
    deadline: project.deadline,
    playbook: project.playbook,
    repos: project.repos.length ? project.repos : undefined,
    detectors: project.detectors.length ? project.detectors : undefined,
    milestones: milestones.length,
    milestones_by_status: milestoneCounts,
    ...outlook(
      ws.tasks.filter((t) => milestoneIds.has(t.milestone)),
      plan,
      project.deadline,
    ),
  };
}

/** Human/LLM-friendly markdown rendering of a schedule; `tasks` (by id) supplies codes and titles for the blocks. */
export function renderSchedule(plan: ScheduleResult, tasks: Map<string, Pick<Task, "code" | "title">>, maxDays = 10): string {
  const lines: string[] = [];
  lines.push(`Schedule from ${plan.from.date} ${plan.from.time} — ${fmtHours(plan.total_hours)} of planned work` +
    (plan.finish ? `, all done by ${fmtDay(plan.finish.date)} ${plan.finish.time}` : ""));
  if (plan.at_risk.length) {
    lines.push("", "## At risk");
    for (const r of plan.at_risk) lines.push(`- ${r.code} ${r.title}: due ${r.deadline}, finishes ${r.end} (${r.late_days}d late)`);
  }
  if (plan.warnings.length) {
    lines.push("", "## Warnings");
    for (const w of plan.warnings) lines.push(`- ${w}`);
  }
  lines.push("", "## Plan");
  for (const day of plan.days.slice(0, maxDays)) {
    lines.push(`### ${fmtDay(day.date)} (${day.date}) — ${fmtHours(day.planned_hours)} / ${fmtHours(day.capacity_hours)}`);
    for (const b of day.blocks) {
      const task = tasks.get(b.task);
      lines.push(`- ${b.start}–${b.end} ${task?.code ?? b.task} ${task?.title ?? ""} (${fmtHours(b.hours)})`);
    }
  }
  if (plan.days.length > maxDays) lines.push(`… ${plan.days.length - maxDays} more working days`);
  if (plan.unscheduled.length) {
    lines.push("", "## Not scheduled");
    for (const u of plan.unscheduled) lines.push(`- ${u.code} ${u.title}: ${u.reason}`);
  }
  return lines.join("\n");
}
