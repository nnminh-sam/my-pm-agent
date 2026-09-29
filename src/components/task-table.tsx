import { compareCodes } from "@/lib/codes";
import { inheritedPriority, lineage, type Lookup } from "@/lib/hierarchy";
import type { ScheduleResult } from "@/lib/scheduler";
import { fmtDay } from "@/lib/time";
import type { Task } from "@/lib/types";
import type { PrEntry } from "@/lib/mcp/task-github";
import { CopyCode } from "./copy-code";
import { PrChips } from "./pr-chips";
import { StatusSelect } from "./status-select";
import { Badge, PriorityBadge, TaskLink, hours } from "./ui";

/** Tasks in the order they're scheduled, then unscheduled ones, then closed ones. */
export function sortForDisplay(tasks: Task[], plan: ScheduleResult) {
  const position = new Map(plan.tasks.map((t, i) => [t.id, i]));
  const closed = (t: Task) => (t.status === "done" || t.status === "cancelled" ? 1 : 0);
  return [...tasks].sort(
    (a, b) =>
      closed(a) - closed(b) ||
      (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity) ||
      compareCodes(a.code, b.code),
  );
}

/** `codes` maps every task id to its code (dependencies can sit in other milestones). */
export function TaskTable(props: {
  tasks: Task[];
  plan: ScheduleResult;
  parents: Lookup;
  codes: Map<string, string>;
  /** PR entries by task id (tasksGithub), for the chips; snapshots only. */
  prs?: Map<string, PrEntry[]>;
  now?: Date;
}) {
  const { tasks, plan, parents, codes, prs, now } = props;
  const slots = new Map(plan.tasks.map((t) => [t.id, t]));
  const reasons = new Map(plan.unscheduled.map((u) => [u.id, u.reason]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium">Task</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Pri</th>
            <th className="px-2 py-2 text-right font-medium">Estimate</th>
            <th className="px-2 py-2 text-right font-medium">Spent</th>
            <th className="px-2 py-2 font-medium">Due</th>
            <th className="px-4 py-2 font-medium">Scheduled</th>
          </tr>
        </thead>
        <tbody>
          {sortForDisplay(tasks, plan).map((t) => {
            const slot = slots.get(t.id);
            const closed = t.status === "done" || t.status === "cancelled";
            const { milestone, project } = lineage(t, parents);
            const priority = inheritedPriority(t.priority, milestone?.priority, project?.priority);
            return (
              <tr key={t.id} className={`border-b border-border last:border-0 ${closed ? "text-muted" : ""}`}>
                <td className="w-full min-w-64 px-4 py-2">
                  <div className="flex items-center gap-2">
                    <TaskLink code={t.code} title={t.title} wrap />
                    <CopyCode code={t.code} bare />
                    {t.depends_on.length > 0 && (
                      <Badge tone="muted" title={`Depends on ${t.depends_on.map((d) => codes.get(d) ?? d).join(", ")}`}>⇠ {t.depends_on.length}</Badge>
                    )}
                    {now && prs?.get(t.id) && <PrChips entries={prs.get(t.id)!} now={now} />}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <StatusSelect id={t.id} status={t.status} />
                </td>
                <td className="px-2 py-2">
                  <PriorityBadge priority={priority} inherited={!t.priority} />
                </td>
                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                  {hours(t.estimate)}
                  {t.estimate_range && (
                    <span className="ml-1 text-xs text-muted">
                      ({t.estimate_range[0]}–{t.estimate_range[1]})
                    </span>
                  )}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums ${t.estimate && t.spent > t.estimate ? "text-danger" : ""}`}>
                  {t.spent ? hours(t.spent) : "—"}
                </td>
                <td className="px-2 py-2 whitespace-nowrap">{t.deadline ? fmtDay(t.deadline) : ""}</td>
                <td className="px-4 py-2 whitespace-nowrap">
                  {slot ? (
                    <span className={slot.late_days ? "text-danger" : ""} title={slot.late_days ? `${slot.late_days} day(s) late` : undefined}>
                      {fmtDay(slot.start.date)}
                      {slot.end.date !== slot.start.date && ` → ${fmtDay(slot.end.date)}`}
                    </span>
                  ) : closed ? (
                    t.completed ? `done ${fmtDay(t.completed)}` : ""
                  ) : (
                    <span className="text-warn">{reasons.get(t.id)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
