import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyCode } from "@/components/copy-code";
import { Outlook } from "@/components/outlook";
import { RepoLinks } from "@/components/repo-links";
import { RepoPrs } from "@/components/repo-prs";
import { RecordEditor } from "@/components/record-editor";
import { Badge, Card, Markdown, PriorityBadge, Stat, hours } from "@/components/ui";
import { loadProjectPrs } from "@/lib/github/project-prs";
import { milestoneSummary, projectSummary, scheduleFor } from "@/lib/planning";
import { toEditable } from "@/lib/record-markdown";
import { NotFoundError, getProject, loadWorkspace } from "@/lib/repo";
import { fmtDay } from "@/lib/time";

export const dynamic = "force-dynamic";

/** `id` is the project's code (case-insensitive) or its uuid. */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(decodeURIComponent(id)).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  // Opening the page pulls the open PRs of each linked repo, in parallel (a snapshot under 60s old is served as is).
  const now = new Date().toISOString();
  const [ws, prs] = await Promise.all([loadWorkspace(), loadProjectPrs(project)]);
  const plan = scheduleFor(ws);
  const s = projectSummary(project, ws, plan);
  const milestones = ws.milestones
    .filter((m) => m.project === project.id)
    .map((m) => ({ milestone: m, summary: milestoneSummary(m, ws, plan) }));
  const onHold = project.status === "on_hold";

  return (
    <div className="space-y-6">
      <RecordEditor kind="project" id={project.id} code={project.code} editable={toEditable("project", project, ws)}>
        <div className="space-y-6">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Link href="/projects" className="text-muted hover:underline">
                Projects
              </Link>
              <span className="text-muted">/</span>
              <CopyCode code={project.code} className="text-muted" />
              <PriorityBadge priority={project.priority} />
              <Badge tone={onHold ? "warn" : "muted"}>{project.status.replace("_", " ")}</Badge>
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">{project.title}</h1>
          </div>

          {onHold && (
            <div className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
              This project is on hold, so none of its tasks are on the schedule.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Estimate" value={`${hours(s.estimate_hours)}${s.estimate_sd_hours ? ` ±${hours(s.estimate_sd_hours)}` : ""}`} />
            <Stat label="Remaining" value={hours(s.remaining_hours)} />
            <Stat
              label={project.deadline ? `Done by (due ${fmtDay(project.deadline)})` : "Done by"}
              value={s.projected_finish ? fmtDay(s.projected_finish) : "—"}
              tone={s.on_track === false ? "danger" : s.on_track ? "ok" : undefined}
            />
            <Stat label="Progress" value={`${Math.round(s.progress * 100)}%`} />
          </div>

          <Card className="px-5 py-4">
            <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">About</h2>
            <Markdown>{project.body}</Markdown>
          </Card>
        </div>
      </RecordEditor>

      <Card className="space-y-3 px-5 py-4">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Repositories</h2>
        <RepoLinks project={project.id} repos={project.repos} />
        {project.context === "company" && (
          <p className="text-xs text-muted">
            Company project: my_pm never contacts GitHub for it, so no pull requests are shown. Linked repos are still
            used by local hooks.
          </p>
        )}
      </Card>

      <RepoPrs prs={prs} now={now} />

      <Card>
        <h2 className="border-b border-border px-4 py-2.5 font-medium">
          Milestones <span className="text-sm font-normal text-muted">({milestones.length})</span>
        </h2>
        {milestones.length ? (
          <ul className="divide-y divide-border">
            {milestones.map(({ milestone, summary }) => (
              <li key={milestone.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
                <Link href={`/milestones/${milestone.code}`} className="flex min-w-0 flex-1 items-baseline gap-2 hover:underline">
                  <span className="font-mono text-xs text-muted">{milestone.code}</span>
                  <span className="truncate">{milestone.title}</span>
                </Link>
                <PriorityBadge priority={summary.priority} inherited={!milestone.priority} />
                <Badge tone="muted">{milestone.status.replace("_", " ")}</Badge>
                <span className="text-xs text-muted">
                  {summary.tasks} task{summary.tasks === 1 ? "" : "s"}
                </span>
                <Outlook data={summary} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted">
            No milestones yet. Ask your agent: “plan {project.code}” (breakdown_project prompt).
          </p>
        )}
      </Card>
    </div>
  );
}
