import Link from "next/link";
import { Outlook } from "@/components/outlook";
import { Badge, Card, Empty, PriorityBadge } from "@/components/ui";
import { projectSummary, scheduleFor } from "@/lib/planning";
import { loadWorkspace } from "@/lib/repo";
import { PRIORITIES, type ProjectStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const DISPLAY_ORDER: ProjectStatus[] = ["active", "planned", "on_hold", "done", "cancelled"];

const STATUS_TONE: Record<ProjectStatus, "accent" | "neutral" | "warn" | "ok" | "muted"> = {
  active: "accent",
  planned: "neutral",
  on_hold: "warn",
  done: "ok",
  cancelled: "muted",
};

export default async function ProjectsPage() {
  const ws = await loadWorkspace();
  const plan = scheduleFor(ws);
  const projects = [...ws.projects].sort(
    (a, b) =>
      DISPLAY_ORDER.indexOf(a.status) - DISPLAY_ORDER.indexOf(b.status) ||
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority),
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Projects</h1>

      {!projects.length && (
        <Empty>
          No projects yet. Ask your agent: “create a project for … and plan its milestones” (breakdown_project prompt).
        </Empty>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {projects.map((project) => {
          const s = projectSummary(project, ws, plan);
          const closed = project.status === "done" || project.status === "cancelled";
          return (
            <Link key={project.id} href={`/projects/${project.code}`} className="group">
              <Card className={`h-full px-4 py-3 transition-colors group-hover:border-muted ${closed ? "opacity-60" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">{project.code}</span>
                  <PriorityBadge priority={project.priority} />
                  <Badge tone={STATUS_TONE[project.status]}>{project.status.replace("_", " ")}</Badge>
                </div>
                <div className="mt-1.5 font-medium group-hover:underline">{project.title}</div>
                <div className="mt-1 text-xs text-muted">
                  {s.milestones} milestone{s.milestones === 1 ? "" : "s"} · {s.tasks} task{s.tasks === 1 ? "" : "s"}
                  {s.unscheduled > 0 && project.status !== "on_hold" && ` · ${s.unscheduled} not scheduled`}
                </div>
                <div className="mt-3">
                  <Outlook data={s} />
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
