import Link from "next/link";
import { notFound } from "next/navigation";
import { logTimeAction } from "@/app/actions";
import { Comments } from "@/components/comments";
import { CopyCode } from "@/components/copy-code";
import { PrCard } from "@/components/pr-card";
import { RecordEditor } from "@/components/record-editor";
import { StatusSelect } from "@/components/status-select";
import { Card, Markdown, PriorityBadge, TaskLink, hours } from "@/components/ui";
import { loadPrView } from "@/lib/github/view";
import { inheritedPriority, lineage, lookup } from "@/lib/hierarchy";
import { scheduleFor } from "@/lib/planning";
import { toEditable } from "@/lib/record-markdown";
import { NotFoundError, getTask, listComments, loadWorkspace } from "@/lib/repo";
import { fmtDay } from "@/lib/time";

export const dynamic = "force-dynamic";

/** `id` is the task's code (case-insensitive) or its uuid. */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(decodeURIComponent(id)).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const ws = await loadWorkspace();
  const plan = scheduleFor(ws);
  const { milestone, project } = lineage(task, lookup(ws.milestones, ws.projects));
  const slot = plan.tasks.find((t) => t.id === task.id);
  const blocks = plan.days.flatMap((d) => d.blocks.filter((b) => b.task === task.id));
  const reason = plan.unscheduled.find((u) => u.id === task.id)?.reason;
  const byId = new Map(ws.tasks.map((t) => [t.id, t]));
  const dependents = ws.tasks.filter((t) => t.depends_on.includes(task.id));
  // Opening the page pulls its PRs (a snapshot under 60s old is served as is). A company project has no PR section.
  const now = new Date().toISOString();
  const [comments, prs] = await Promise.all([
    listComments(task.id),
    project?.context === "company" ? [] : Promise.all(task.prs.map(async (ref) => ({ ref, view: await loadPrView(ref) }))),
  ]);
  const closed = task.status === "done" || task.status === "cancelled";

  const meta: [string, React.ReactNode][] = [
    ["Status", <StatusSelect key="s" id={task.id} status={task.status} />],
    ["Priority", <PriorityBadge key="p" priority={inheritedPriority(task.priority, milestone?.priority, project?.priority)} inherited={!task.priority} />],
    [
      "Estimate",
      <>
        {hours(task.estimate)}
        {task.estimate_range && <span className="text-muted"> ({task.estimate_range[0]}–{task.estimate_range[1]}h)</span>}
      </>,
    ],
    ["Spent", <span key="sp" className={task.estimate && task.spent > task.estimate ? "text-danger" : ""}>{hours(task.spent)}</span>],
    ["Deadline", task.deadline ? fmtDay(task.deadline) : "—"],
    ["Not before", task.not_before ? fmtDay(task.not_before) : "—"],
    ["Tags", task.tags.length ? task.tags.join(", ") : "—"],
    ["Created", fmtDay(task.created)],
  ];

  return (
    <RecordEditor kind="task" id={task.id} code={task.code} editable={toEditable("task", task, ws)}>
      <div className="space-y-6">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            {project && (
              <>
                <Link href={`/projects/${project.code}`} className="hover:underline">
                  {project.title}
                </Link>
                <span>/</span>
              </>
            )}
            {milestone && (
              <>
                <Link href={`/milestones/${milestone.code}`} className="hover:underline">
                  <span className="font-mono">{milestone.code}</span> {milestone.title}
                </Link>
                <span>/</span>
              </>
            )}
            <CopyCode code={task.code} />
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{task.title}</h1>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_280px]">
          <div className="space-y-6">
            <Card className="px-5 py-4">
              <Markdown>{task.body}</Markdown>
            </Card>

            {prs.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Pull requests</h2>
                {prs.map(({ ref, view }) => (
                  <PrCard key={ref} prRef={ref} data={view.data} sync={view.sync} syncKey={view.key} now={now} />
                ))}
              </section>
            )}

            <Card className="px-5 py-4">
              <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Scheduled</h2>
              {slot ? (
                <ul className="space-y-1 text-sm">
                  {blocks.map((b) => (
                    <li key={`${b.date}-${b.start}`} className="flex gap-3 tabular-nums">
                      <span className="w-24">{fmtDay(b.date)}</span>
                      <span className="font-mono text-xs leading-5 text-muted">
                        {b.start}–{b.end}
                      </span>
                      <span className="text-muted">{hours(b.hours)}</span>
                    </li>
                  ))}
                  {slot.late_days > 0 && (
                    <li className="pt-1 text-danger">
                      Finishes {slot.late_days} day(s) after its {fmtDay(slot.deadline!)} deadline.
                    </li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted">{closed ? `Closed${task.completed ? ` on ${fmtDay(task.completed)}` : ""}.` : reason}</p>
              )}
            </Card>

            <Card className="px-5 py-4">
              <Comments taskId={task.id} comments={comments} />
            </Card>
          </div>

          <aside className="space-y-4">
            <Card className="px-4 py-3">
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
                {meta.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            {(task.depends_on.length > 0 || dependents.length > 0) && (
              <Card className="space-y-2 px-4 py-3 text-sm">
                {task.depends_on.length > 0 && (
                  <div>
                    <div className="text-xs text-muted">Depends on</div>
                    {task.depends_on.map((d) => (
                      <div key={d}>
                        <TaskLink code={byId.get(d)?.code ?? d} title={byId.get(d)?.title} />
                      </div>
                    ))}
                  </div>
                )}
                {dependents.length > 0 && (
                  <div>
                    <div className="text-xs text-muted">Blocks</div>
                    {dependents.map((d) => (
                      <div key={d.id}>
                        <TaskLink code={d.code} title={d.title} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {!closed && (
              <Card className="px-4 py-3">
                <form action={logTimeAction} className="space-y-2 text-sm">
                  <input type="hidden" name="id" value={task.id} />
                  <div className="text-xs font-medium tracking-wide text-muted uppercase">Log time</div>
                  <div className="flex gap-2">
                    <input
                      name="hours"
                      type="number"
                      step="0.25"
                      min="0.25"
                      required
                      placeholder="Hours"
                      className="w-20 rounded border border-border bg-surface px-2 py-1"
                    />
                    <input name="note" placeholder="Note (optional)" className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1" />
                  </div>
                  <label className="flex items-center gap-2 text-muted">
                    <input type="checkbox" name="done" /> Mark done
                  </label>
                  <button className="w-full rounded bg-accent px-3 py-1.5 font-medium text-white dark:text-black">Log</button>
                </form>
              </Card>
            )}
          </aside>
        </div>
      </div>
    </RecordEditor>
  );
}
