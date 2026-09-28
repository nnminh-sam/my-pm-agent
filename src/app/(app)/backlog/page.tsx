import Link from "next/link";
import { Outlook } from "@/components/outlook";
import { TaskTable } from "@/components/task-table";
import { Badge, Card, Empty, PriorityBadge } from "@/components/ui";
import { lookup, type Lookup } from "@/lib/hierarchy";
import { milestoneSummary, projectSummary, scheduleFor } from "@/lib/planning";
import { loadWorkspace, type Workspace } from "@/lib/repo";
import type { ScheduleResult } from "@/lib/scheduler";
import { PRIORITIES, type Milestone, type Task } from "@/lib/types";

export const dynamic = "force-dynamic";

const isOpen = (status: string) => status !== "done" && status !== "cancelled";

function MilestoneCard(props: { milestone: Milestone; tasks: Task[]; ws: Workspace; plan: ScheduleResult; parents: Lookup }) {
  const { milestone, tasks, ws, plan, parents } = props;
  const s = milestoneSummary(milestone, ws, plan);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <Link href={`/milestones/${milestone.code}`} className="flex min-w-0 items-baseline gap-2 hover:underline">
          <span className="font-mono text-xs text-muted">{milestone.code}</span>
          <span className="font-medium">{milestone.title}</span>
        </Link>
        <PriorityBadge priority={s.priority} inherited={!milestone.priority} />
        <Badge tone="muted">{milestone.status.replace("_", " ")}</Badge>
        <div className="ml-auto">
          <Outlook data={s} />
        </div>
      </div>
      {tasks.length ? (
        <TaskTable tasks={tasks} plan={plan} parents={parents} codes={new Map(ws.tasks.map((t) => [t.id, t.code]))} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted">No tasks — ask your agent to break down {milestone.code}.</p>
      )}
    </Card>
  );
}

export default async function BacklogPage({ searchParams }: { searchParams: Promise<{ closed?: string }> }) {
  const { closed } = await searchParams;
  const showClosed = closed === "1";
  const ws = await loadWorkspace();
  const plan = scheduleFor(ws);
  const parents = lookup(ws.milestones, ws.projects);
  const tasks = ws.tasks.filter((t) => showClosed || isOpen(t.status));
  const milestones = ws.milestones
    .filter((m) => showClosed || isOpen(m.status))
    .sort((a, b) => PRIORITIES.indexOf(milestoneSummary(a, ws, plan).priority) - PRIORITIES.indexOf(milestoneSummary(b, ws, plan).priority));
  const projects = ws.projects
    .filter((p) => showClosed || isOpen(p.status))
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));

  const card = (m: Milestone) => (
    <MilestoneCard key={m.id} milestone={m} tasks={tasks.filter((t) => t.milestone === m.id)} ws={ws} plan={plan} parents={parents} />
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Backlog</h1>
        <Link href={showClosed ? "/backlog" : "/backlog?closed=1"} className="text-sm text-accent hover:underline">
          {showClosed ? "Hide done & cancelled" : "Show done & cancelled"}
        </Link>
      </div>

      {!projects.length && !milestones.length && !tasks.length && <Empty>Nothing here yet.</Empty>}

      {projects.map((project) => {
        const own = milestones.filter((m) => m.project === project.id);
        return (
          <section key={project.id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link href={`/projects/${project.code}`} className="flex items-baseline gap-2 hover:underline">
                <span className="font-mono text-xs text-muted">{project.code}</span>
                <span className="text-lg font-semibold tracking-tight">{project.title}</span>
              </Link>
              <PriorityBadge priority={project.priority} />
              {project.status !== "active" && <Badge tone={project.status === "on_hold" ? "warn" : "muted"}>{project.status.replace("_", " ")}</Badge>}
              <div className="ml-auto">
                <Outlook data={projectSummary(project, ws, plan)} />
              </div>
            </div>
            {own.length ? own.map(card) : <p className="text-sm text-muted">No milestones — ask your agent to plan {project.code}.</p>}
          </section>
        );
      })}
    </div>
  );
}
