import { describe, expect, it } from "vitest";
import { newId } from "../codes";
import { MilestoneMeta, ProjectMeta, TaskMeta, type Milestone, type Project, type Task } from "../types";
import { taskContext } from "./task-context";

const project: Project = { ...ProjectMeta.parse({ id: newId(), code: "PMA", title: "PM app", created: "2026-09-01" }), body: "Goal" };
const milestone: Milestone = {
  ...MilestoneMeta.parse({ id: newId(), code: "PMA-M1", number: 1, title: "Agents", status: "in_progress", project: project.id, created: "2026-09-01" }),
  body: "## Spec\n- [ ] works",
};

function task(number: number, fields: Partial<TaskMeta> = {}): Task {
  const meta = TaskMeta.parse({ id: newId(), code: `PMA-M1-T${number}`, number, title: `Task ${number}`, milestone: milestone.id, created: "2026-09-01", ...fields });
  return { ...meta, body: "" };
}

describe("taskContext", () => {
  it("adds the milestone spec, the project and the resolved dependencies", () => {
    const done = task(1, { status: "done" });
    const open = task(2);
    const t = task(3, { depends_on: [done.id, open.id] });
    const ws = { tasks: [done, open, t], milestones: [milestone], projects: [project] };

    expect(taskContext(t, ws)).toEqual({
      milestone_context: { code: "PMA-M1", title: "Agents", status: "in_progress", spec: "## Spec\n- [ ] works" },
      project_context: { code: "PMA", title: "PM app" },
      dependencies: [
        { code: "PMA-M1-T1", title: "Task 1", status: "done" },
        { code: "PMA-M1-T2", title: "Task 2", status: "todo" },
      ],
    });
  });

  it("leaves out what it can't resolve instead of failing", () => {
    const missing = newId();
    const t = task(4, { depends_on: [missing] });
    const ctx = taskContext(t, { tasks: [t], milestones: [], projects: [] });

    expect(ctx.milestone_context).toBeUndefined();
    expect(ctx.project_context).toBeUndefined();
    expect(ctx.dependencies).toEqual([{ code: missing, title: "(missing task)", status: undefined }]);
    expect(taskContext(task(5), { tasks: [], milestones: [milestone], projects: [project] }).dependencies).toBeUndefined();
  });
});
