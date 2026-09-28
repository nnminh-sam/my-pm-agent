import Link from "next/link";
import { Badge, Bar, Card, Empty, Notice, Stat, TaskLink, hours } from "@/components/ui";
import { lineage, lookup } from "@/lib/hierarchy";
import { scheduleFor } from "@/lib/planning";
import { loadWorkspace } from "@/lib/repo";
import { fmtDay, nowIn } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const ws = await loadWorkspace();
  const plan = scheduleFor(ws);
  const today = nowIn(ws.settings.timezone).date;
  const tasks = new Map(ws.tasks.map((t) => [t.id, t]));
  const parents = lookup(ws.milestones, ws.projects);

  if (!ws.tasks.length) {
    return (
      <Empty>
        No tasks yet. <Link href="/connect" className="text-accent underline">Connect an AI agent</Link> and ask it to
        create a project and plan it — or add markdown files to <code className="font-mono">data/</code>.
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Schedule</h1>
        <p className="text-sm text-muted">
          From {fmtDay(plan.from.date)} {plan.from.time} · {ws.settings.timezone}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Planned work" value={hours(plan.total_hours)} />
        <Stat label="All done by" value={plan.finish ? `${fmtDay(plan.finish.date)}` : "—"} />
        <Stat label="Deadlines at risk" value={plan.at_risk.length} tone={plan.at_risk.length ? "danger" : "ok"} />
        <Stat label="Not scheduled" value={plan.unscheduled.length} tone={plan.unscheduled.length ? "warn" : undefined} />
      </div>

      <Notice
        tone="danger"
        title="At risk"
        items={plan.at_risk.map((r) => (
          <>
            <TaskLink code={r.code} title={r.title} /> — due {fmtDay(r.deadline)}, finishes {fmtDay(r.end)} ({r.late_days}d late)
          </>
        ))}
      />
      <Notice tone="warn" title="Heads up" items={[...ws.problems, ...plan.warnings]} />

      <div className="space-y-3">
        {plan.days.map((day) => (
          <Card key={day.date}>
            <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
              <div className="font-medium">{fmtDay(day.date)}</div>
              {day.date === today && <Badge tone="accent">Today</Badge>}
              <div className="ml-auto flex w-40 items-center gap-2 text-xs text-muted tabular-nums">
                <Bar value={day.capacity_hours ? day.planned_hours / day.capacity_hours : 0} />
                <span className="whitespace-nowrap">
                  {hours(day.planned_hours)} / {hours(day.capacity_hours)}
                </span>
              </div>
            </div>
            <ul className="divide-y divide-border">
              {day.blocks.map((block) => {
                const task = tasks.get(block.task);
                const { milestone, project } = task ? lineage(task, parents) : {};
                return (
                  <li key={`${block.task}-${block.start}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-24 shrink-0 font-mono text-xs text-muted">
                      {block.start}–{block.end}
                    </span>
                    <span className="min-w-0 flex-1">
                      <TaskLink code={task?.code ?? block.task} title={task?.title} />
                    </span>
                    {milestone && (
                      <Link href={`/milestones/${milestone.code}`} className="hidden sm:block">
                        <Badge tone="muted" title={project ? `${project.title} › ${milestone.title}` : milestone.title}>
                          <span className="max-w-64 truncate">
                            <span className="font-mono opacity-70">{milestone.code}</span> {milestone.title}
                          </span>
                        </Badge>
                      </Link>
                    )}
                    <span className="w-12 shrink-0 text-right text-xs text-muted tabular-nums">{hours(block.hours)}</span>
                  </li>
                );
              })}
              {!day.blocks.length && <li className="px-4 py-2 text-sm text-muted">Free</li>}
            </ul>
          </Card>
        ))}
      </div>

      {plan.unscheduled.length > 0 && (
        <Card>
          <h2 className="border-b border-border px-4 py-2.5 font-medium">Not scheduled</h2>
          <ul className="divide-y divide-border">
            {plan.unscheduled.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <TaskLink code={u.code} title={u.title} />
                </span>
                <span className="text-xs text-warn">{u.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
