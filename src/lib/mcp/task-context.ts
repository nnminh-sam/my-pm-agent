import { lineage, lookup } from "../hierarchy";
import type { Workspace } from "../repo";
import type { Milestone, Task } from "../types";

/**
 * What an agent needs beside a task to start on it from its code alone: the milestone spec, the project, and
 * whether its dependencies are done. Named *_context so they don't clash with taskRow's `milestone` code.
 */
export function taskContext(task: Task, ws: Pick<Workspace, "tasks" | "milestones" | "projects">) {
  const { milestone, project } = lineage(task, lookup(ws.milestones, ws.projects));
  const tasks = new Map(ws.tasks.map((t) => [t.id, t]));
  return {
    milestone_context: milestone && {
      code: milestone.code,
      title: milestone.title,
      status: milestone.status,
      spec: (milestone as Milestone).body, // the lookup holds the workspace's full records
    },
    project_context: project && { code: project.code, title: project.title },
    dependencies: task.depends_on.length
      ? task.depends_on.map((id) => {
          const dep = tasks.get(id);
          return dep ? { code: dep.code, title: dep.title, status: dep.status } : { code: id, title: "(missing task)", status: undefined };
        })
      : undefined,
  };
}
