import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyCode } from "@/components/copy-code";
import { TaskTable } from "@/components/task-table";
import { Badge, Card, Markdown, PriorityBadge, Stat, hours } from "@/components/ui";
import { lookup } from "@/lib/hierarchy";
import { milestoneEffective, milestoneSummary, scheduleFor } from "@/lib/planning";
import { NotFoundError, getMilestone, loadWorkspace } from "@/lib/repo";
import { fmtDay } from "@/lib/time";

export const dynamic = "force-dynamic";

/** `id` is the milestone's code (case-insensitive) or its uuid. */
export default async function MilestonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const milestone = await getMilestone(decodeURIComponent(id)).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const ws = await loadWorkspace();
  const plan = scheduleFor(ws);
  const s = milestoneSummary(milestone, ws, plan);
  const { project } = milestoneEffective(milestone, ws);
  const tasks = ws.tasks.filter((t) => t.milestone === milestone.id);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {project && (
            <>
              <Link href={`/projects/${project.code}`} className="text-muted hover:underline">
                {project.title}
              </Link>
              <span className="text-muted">/</span>
            </>
          )}
          <CopyCode code={milestone.code} className="text-muted" />
          <PriorityBadge priority={s.priority} inherited={!milestone.priority} />
          <Badge tone="muted">{milestone.status.replace("_", " ")}</Badge>
        </div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{milestone.title}</h1>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Estimate" value={`${hours(s.estimate_hours)}${s.estimate_sd_hours ? ` ±${hours(s.estimate_sd_hours)}` : ""}`} />
        <Stat label="Remaining" value={hours(s.remaining_hours)} />
        <Stat
          label={s.deadline ? `Done by (due ${fmtDay(s.deadline)})` : "Done by"}
          value={s.projected_finish ? fmtDay(s.projected_finish) : "—"}
          tone={s.on_track === false ? "danger" : s.on_track ? "ok" : undefined}
        />
        <Stat label="Progress" value={`${Math.round(s.progress * 100)}%`} />
      </div>

      <Card className="px-5 py-4">
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Spec</h2>
        <Markdown>{milestone.body}</Markdown>
      </Card>

      <Card>
        <h2 className="border-b border-border px-4 py-2.5 font-medium">
          Tasks <span className="text-sm font-normal text-muted">({tasks.length})</span>
        </h2>
        {tasks.length ? (
          <TaskTable
            tasks={tasks}
            plan={plan}
            parents={lookup(ws.milestones, ws.projects)}
            codes={new Map(ws.tasks.map((t) => [t.id, t.code]))}
          />
        ) : (
          <p className="px-4 py-3 text-sm text-muted">
            No tasks yet. Ask your agent: “break down {milestone.code}” (breakdown_milestone prompt).
          </p>
        )}
      </Card>
    </div>
  );
}
