import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { estimationStats } from "../estimation";
import { lifecycle, projectChecks, type MilestoneLifecycle } from "../lifecycle";
import { milestoneSummary, projectSummary, renderSchedule, scheduleFor } from "../planning";
import {
  DeploymentInput,
  MilestonePatch,
  NewMilestone,
  NewProject,
  NewTask,
  ProjectPatch,
  TaskPatch,
  createMilestone,
  createProject,
  addComment,
  listComments,
  advanceStage,
  createTasks,
  getMilestone,
  getProject,
  getTask,
  loadWorkspace,
  logTime,
  recordDeployment,
  reorderTasks,
  resolve,
  setCheck,
  setPlaybookVersion,
  syncPlaybook,
  updateMilestone,
  updateProject,
  updateSettings,
  updateTask,
  type Workspace,
} from "../repo";
import type { ScheduleResult } from "../scheduler";
import { getRepository } from "../repository";
import { nowIn } from "../time";
import { LIFECYCLE_STAGES, LifecycleStage, SettingsPatch, TaskStatus, type Milestone, type Project, type Task } from "../types";
import { CHECKIN_PROMPT, REPLAN_PROMPT, breakdownPrompt, estimatePrompt, projectBreakdownPrompt, workOnTaskPrompt } from "./prompts";
import { taskContext } from "./task-context";
import { taskGithub } from "./task-github";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const noArgs = z.object({});

/** Records are shown by code, then id; references to other records by code (agents can pass either back). */
function taskRow(t: Task, ws: Workspace, plan?: ScheduleResult) {
  const slot = plan?.tasks.find((s) => s.id === t.id);
  const code = (id: string) => ws.tasks.find((x) => x.id === id)?.code ?? id;
  return {
    code: t.code,
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    milestone: ws.milestones.find((m) => m.id === t.milestone)?.code ?? t.milestone,
    estimate: t.estimate,
    estimate_range: t.estimate_range,
    spent: t.spent || undefined,
    deadline: t.deadline,
    not_before: t.not_before,
    depends_on: t.depends_on.length ? t.depends_on.map(code) : undefined,
    tags: t.tags.length ? t.tags : undefined,
    prs: t.prs.length ? t.prs : undefined,
    order: t.order,
    scheduled: slot ? `${slot.start.date} ${slot.start.time} → ${slot.end.date} ${slot.end.time}` : undefined,
    late_days: slot?.late_days || undefined,
    not_scheduled: plan?.unscheduled.find((u) => u.id === t.id)?.reason,
  };
}

function milestoneRow({ code, id, body, ...m }: Milestone, ws: Workspace) {
  return { code, id, ...m, project: ws.projects.find((p) => p.id === m.project)?.code ?? m.project, spec: body };
}

function projectRow({ code, id, body, ...p }: Project) {
  return { code, id, ...p, description: body };
}

/** What changed for the plan as a whole — returned after every write so the agent sees the impact. */
function impact(ws: Workspace, ids: string[]) {
  const plan = scheduleFor(ws);
  return {
    plan,
    summary: {
      finish: plan.finish ? `${plan.finish.date} ${plan.finish.time}` : undefined,
      total_hours: plan.total_hours,
      at_risk: plan.at_risk,
      not_scheduled: plan.unscheduled.filter((u) => ids.includes(u.id)),
    },
  };
}

/**
 * A milestone's lifecycle as the tools show it: the current stage's checks, plus any other check with a recorded
 * result (evidence can come early); every check is in get_lifecycle's `checks` count. Done milestones stay short.
 */
function lifecycleRow(m: MilestoneLifecycle) {
  const { checks, ...rest } = m;
  if (m.status === "done" || m.status === "cancelled") {
    return { code: m.code, title: m.title, status: m.status, stage: m.stage, environments: m.environments };
  }
  return { ...rest, checks: checks.filter((c) => c.stage === m.stage || c.result) };
}

/** The milestone's lifecycle after a write, so the agent sees what's open and what's next. */
async function milestoneAfter(milestone: Milestone) {
  const ws = await loadWorkspace();
  const project = ws.projects.find((p) => p.id === milestone.project)!;
  const result = lifecycle({ ...ws, projects: [{ ...project, status: "active" }], plan: scheduleFor(ws) });
  const view = result.projects[0]?.milestones.find((m) => m.id === milestone.id);
  return view ? lifecycleRow(view) : { code: milestone.code, stage: milestone.stage, status: milestone.status };
}

const milestoneArg = z.string().describe("Milestone code, e.g. PMA-M6 (or its id).");
const checkArg = z.string().describe("Check key, e.g. spec.accepted (get_lifecycle lists them).");
const byArg = z.string().optional().describe("Who recorded it, e.g. your name or claude.");

export function registerPmServer(server: McpServer) {
  // ---------------------------------------------------------------- overview
  server.registerTool(
    "get_overview",
    {
      title: "Overview",
      description:
        "Start here. Today's date and plan, active projects and milestones with progress and projected finish, deadline risks, the top lifecycle next actions and warnings (get_next has them all), settings and data problems.",
      inputSchema: noArgs,
      annotations: READ,
    },
    async () =>
      run(async () => {
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        const flow = lifecycle({ ...ws, plan });
        const now = nowIn(ws.settings.timezone);
        const tasks = new Map(ws.tasks.map((t) => [t.id, t]));
        const counts: Record<string, number> = {};
        for (const t of ws.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
        return json({
          now: `${now.date} ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}`,
          timezone: ws.settings.timezone,
          storage: getRepository().kind,
          task_counts: counts,
          projects: ws.projects
            .filter((p) => p.status !== "done" && p.status !== "cancelled")
            .map((p) => projectSummary(p, ws, plan)),
          milestones: ws.milestones
            .filter((m) => m.status !== "done" && m.status !== "cancelled")
            .map((m) => milestoneSummary(m, ws, plan)),
          today: (plan.days.find((d) => d.date === now.date)?.blocks ?? []).map(
            (b) => `${b.start}–${b.end} ${tasks.get(b.task)?.code} ${tasks.get(b.task)?.title}`,
          ),
          finish: plan.finish,
          remaining_hours: plan.total_hours,
          at_risk: plan.at_risk,
          lifecycle: { warnings: flow.warnings, next: flow.next.slice(0, 5), wip: flow.wip },
          not_scheduled: plan.unscheduled,
          warnings: plan.warnings,
          settings: ws.settings,
          problems: ws.problems.length ? ws.problems : undefined,
        });
      }),
  );

  // ------------------------------------------------------------------- tasks
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List tasks with their scheduled slot. Done and cancelled tasks are hidden unless include_closed is true.",
      inputSchema: z.object({
        status: z.array(TaskStatus).optional(),
        project: z.string().optional().describe("Project code (e.g. PMA): tasks of all its milestones."),
        milestone: z.string().optional().describe("Milestone code, e.g. PMA-M2."),
        tag: z.string().optional(),
        unestimated: z.boolean().optional().describe("Only tasks without an estimate."),
        include_closed: z.boolean().optional(),
      }),
      annotations: READ,
    },
    async (args) =>
      run(async () => {
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        const milestone = args.milestone ? resolve("milestone", ws.milestones, args.milestone).id : undefined;
        const project = args.project ? resolve("project", ws.projects, args.project).id : undefined;
        const inProject = new Set(ws.milestones.filter((m) => m.project === project).map((m) => m.id));
        const tasks = ws.tasks.filter(
          (t) =>
            (args.status
              ? args.status.includes(t.status)
              : args.include_closed || (t.status !== "done" && t.status !== "cancelled")) &&
            (!milestone || t.milestone === milestone) &&
            (!project || inProject.has(t.milestone)) &&
            (!args.tag || t.tags.includes(args.tag)) &&
            (!args.unestimated || t.estimate === undefined),
        );
        return json(tasks.map((t) => taskRow(t, ws, plan)));
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "A task's full details, including its markdown description, log and scheduled slot, plus what's needed to start on it: milestone_context (code, title, status, spec), project_context (code, title) and dependencies (code, title, status). Also comments (oldest first: id, author, created_at, body) and, when the task has PRs, pull_requests: per PR its ref, url, overview (title, body, state, GitHub milestone, reviewers with states, assignees) and sync ({sync: synced | out_of_sync | never, fetched_at, reason}, plus message and retry_after when the last attempt failed or GitHub rate-limited). Both come from stored snapshots and never call GitHub (a PR whose repo is no longer linked to a project shows no overview, reason not_linked); for the diff or review threads use `gh`.",
      inputSchema: z.object({ id: z.string().describe("Task code, e.g. PMA-M1-T3 (or its id).") }),
      annotations: READ,
    },
    async ({ id }) =>
      run(async () => {
        const [task, ws] = await Promise.all([getTask(id), loadWorkspace()]);
        const [comments, pull_requests] = await Promise.all([listComments(task.id), taskGithub(task, ws)]);
        return json({
          ...taskRow(task, ws, scheduleFor(ws)),
          created: task.created,
          completed: task.completed,
          description: task.body,
          ...taskContext(task, ws),
          pull_requests,
          comments: comments.length
            ? comments.map((c) => ({ id: c.id, author: c.author, created_at: c.created_at, body: c.body }))
            : undefined,
        });
      }),
  );

  server.registerTool(
    "create_tasks",
    {
      title: "Create tasks",
      description:
        "Create one or more tasks in one call (preferred for breakdowns). Each task goes in a milestone and is numbered within it (PMA-M2-T5). Give each task a `ref` so others in the batch can depend on it. Returns the new codes and the effect on the schedule.",
      inputSchema: z.object({ tasks: z.array(NewTask).min(1).max(100) }),
      annotations: WRITE,
    },
    async ({ tasks }) =>
      run(async () => {
        const created = await createTasks(tasks);
        const ws = await loadWorkspace();
        const { plan, summary } = impact(
          ws,
          created.map((t) => t.id),
        );
        return json({ created: created.map((t) => taskRow(t, ws, plan)), schedule: summary });
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Change any task field — status, priority, estimate (or pert), deadline, not_before, depends_on, order, tags, prs, description, milestone (moves it: the code changes) — or append a note. Nullable fields accept null to clear them. Set `prs` right after opening a pull request, with its URL or owner/repo#N (stored as owner/repo#N); it replaces the list ([] clears it). The PR's repo must be linked to the task's project (update_project repos). Returns the task's new slot and the effect on the schedule.",
      inputSchema: TaskPatch.extend({ id: z.string().describe("Task code, e.g. PMA-M1-T3 (or its id).") }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, ...patch }) =>
      run(async () => {
        const task = await updateTask(id, patch);
        const ws = await loadWorkspace();
        const { plan, summary } = impact(ws, [task.id]);
        return json({ task: taskRow(task, ws, plan), schedule: summary });
      }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a task comment",
      description:
        "Append a plain-text note to a task (any project). Use it for progress, findings or hand-off notes; it is stored as written, never edited. Not markdown, and my_pm never resolves references in it (a PR link or task code stays text). Comments are append-only over MCP (the user can delete them in the web UI); get_task returns them. Returns the created comment (author is agent). Max 10000 characters.",
      inputSchema: z.object({
        id: z.string().describe("Task code, e.g. PMA-M1-T3 (or its id)."),
        body: z.string().describe("The note, plain text."),
      }),
      annotations: WRITE,
    },
    async ({ id, body }) => run(async () => json(await addComment(id, body, "agent"))),
  );

  server.registerTool(
    "log_time",
    {
      title: "Log time",
      description:
        "Add hours worked on a task (moves it to in_progress). Set done=true to complete it. Logged time drives estimate calibration.",
      inputSchema: z.object({
        id: z.string().describe("Task code, e.g. PMA-M1-T3 (or its id)."),
        hours: z.number().positive(),
        note: z.string().optional(),
        done: z.boolean().optional(),
      }),
      annotations: WRITE,
    },
    async ({ id, hours, note, done }) =>
      run(async () => {
        const task = await logTime(id, hours, note, done);
        const ws = await loadWorkspace();
        const { plan, summary } = impact(ws, [task.id]);
        return json({ task: taskRow(task, ws, plan), schedule: summary });
      }),
  );

  server.registerTool(
    "reorder_tasks",
    {
      title: "Reorder tasks",
      description:
        "Set the manual order of tasks (first = do first). Order breaks ties within the same priority; to move a task ahead of higher-priority work, change its priority or add a dependency instead.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1).describe("Task codes (or ids), first = do first.") }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ ids }) =>
      run(async () => {
        const tasks = await reorderTasks(ids);
        const ws = await loadWorkspace();
        const { plan, summary } = impact(
          ws,
          tasks.map((t) => t.id),
        );
        return json({ tasks: tasks.map((t) => taskRow(t, ws, plan)), schedule: summary });
      }),
  );

  // -------------------------------------------------------------- milestones
  server.registerTool(
    "list_milestones",
    {
      title: "List milestones",
      description: "Milestones with task counts, estimated/remaining hours (± σ), progress and projected finish.",
      inputSchema: z.object({ project: z.string().optional().describe("Project code, e.g. PMA.") }),
      annotations: READ,
    },
    async (args) =>
      run(async () => {
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        const project = args.project ? resolve("project", ws.projects, args.project).id : undefined;
        return json(ws.milestones.filter((m) => !project || m.project === project).map((m) => milestoneSummary(m, ws, plan)));
      }),
  );

  server.registerTool(
    "get_milestone",
    {
      title: "Get milestone",
      description: "A milestone's spec, estimate rollup, projected finish and all of its tasks.",
      inputSchema: z.object({ id: z.string().describe("Milestone code, e.g. PMA-M2 (or its id).") }),
      annotations: READ,
    },
    async ({ id }) =>
      run(async () => {
        const [milestone, ws] = await Promise.all([getMilestone(id), loadWorkspace()]);
        const plan = scheduleFor(ws);
        return json({
          ...milestoneSummary(milestone, ws, plan),
          spec: milestone.body,
          tasks: ws.tasks.filter((t) => t.milestone === milestone.id).map((t) => taskRow(t, ws, plan)),
        });
      }),
  );

  server.registerTool(
    "create_milestone",
    {
      title: "Create milestone",
      description:
        "Create a milestone in a project, with a markdown spec. It's numbered within the project (PMA-M3). Break it down afterwards with the breakdown_milestone prompt.",
      inputSchema: NewMilestone,
      annotations: WRITE,
    },
    async (input) =>
      run(async () => {
        const milestone = await createMilestone(input);
        return json(milestoneRow(milestone, await loadWorkspace()));
      }),
  );

  server.registerTool(
    "update_milestone",
    {
      title: "Update milestone",
      description:
        "Change a milestone's title, spec, project, priority, deadline or status. Moving it to another project renumbers it, and its tasks' codes follow. Tasks inherit its priority and deadline; it inherits from its project.",
      inputSchema: MilestonePatch.extend({ id: z.string().describe("Milestone code, e.g. PMA-M2 (or its id).") }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, ...patch }) =>
      run(async () => {
        const milestone = await updateMilestone(id, patch);
        return json(milestoneRow(milestone, await loadWorkspace()));
      }),
  );

  // ---------------------------------------------------------------- projects
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Projects with milestone/task counts, estimated/remaining hours, progress and projected finish vs deadline.",
      inputSchema: z.object({ include_closed: z.boolean().optional().describe("Include done and cancelled projects.") }),
      annotations: READ,
    },
    async ({ include_closed }) =>
      run(async () => {
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        return json(
          ws.projects
            .filter((p) => include_closed || (p.status !== "done" && p.status !== "cancelled"))
            .map((p) => projectSummary(p, ws, plan)),
        );
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "A project's description, rollup, projected finish and a summary of each of its milestones.",
      inputSchema: z.object({ id: z.string().describe("Project code, e.g. PMA (or its id).") }),
      annotations: READ,
    },
    async ({ id }) =>
      run(async () => {
        const [project, ws] = await Promise.all([getProject(id), loadWorkspace()]);
        const plan = scheduleFor(ws);
        return json({
          ...projectSummary(project, ws, plan),
          description: project.body,
          milestone_list: ws.milestones.filter((m) => m.project === project.id).map((m) => milestoneSummary(m, ws, plan)),
        });
      }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create a project: the top level that groups milestones. It needs a short unique code (2–6 letters/digits, e.g. PMA) that prefixes its milestone and task codes; propose one from the title. Its priority and deadline are inherited by its milestones and tasks. Plan its milestones afterwards with the breakdown_project prompt.",
      inputSchema: NewProject,
      annotations: WRITE,
    },
    async (input) => run(async () => json(projectRow(await createProject(input)))),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description:
        "Change a project's title, code, description, priority, deadline or status. A new code renames every milestone and task code in the project. Setting status to on_hold, done or cancelled takes all its tasks off the schedule.",
      inputSchema: ProjectPatch.extend({ id: z.string().describe("Project code, e.g. PMA (or its id).") }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, ...patch }) =>
      run(async () => {
        const project = await updateProject(id, patch);
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        return json({
          project: projectSummary(project, ws, plan),
          schedule: { finish: plan.finish, total_hours: plan.total_hours, at_risk: plan.at_risk },
        });
      }),
  );

  // --------------------------------------------------------------- lifecycle
  server.registerTool(
    "get_next",
    {
      title: "What's next",
      description:
        "What to do next across all projects: lifecycle warnings (no playbook, no project rules, a newer playbook version), each active milestone's next action ranked by deadline risk, then priority, then later stage first, then deadline, and today's scheduled blocks. Ideas and finished milestones aren't listed.",
      inputSchema: z.object({
        project: z.string().optional().describe("Only this project (code, e.g. PMA)."),
        limit: z.number().int().positive().max(50).optional().describe("Most next actions to return (default 10)."),
      }),
      annotations: READ,
    },
    async ({ project, limit = 10 }) =>
      run(async () => {
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        const result = lifecycle({ ...ws, plan });
        const code = project ? resolve("project", ws.projects, project).code : undefined;
        const mine = <T extends { project: string }>(list: T[]) => (code ? list.filter((x) => x.project === code) : list);
        const projectOf = new Map(ws.milestones.map((m) => [m.id, ws.projects.find((p) => p.id === m.project)?.code]));
        const tasks = new Map(ws.tasks.map((t) => [t.id, t]));
        const now = nowIn(ws.settings.timezone);
        const today = (plan.days.find((d) => d.date === now.date)?.blocks ?? [])
          .map((b) => ({ block: b, task: tasks.get(b.task) }))
          .filter(({ task }) => !code || (task && projectOf.get(task.milestone) === code))
          .map(({ block, task }) => `${block.start}–${block.end} ${task?.code} ${task?.title}`);
        return json({ warnings: mine(result.warnings), next: mine(result.next).slice(0, limit), today, wip: result.wip });
      }),
  );

  server.registerTool(
    "get_lifecycle",
    {
      title: "Project lifecycle",
      description:
        "One project's lifecycle: its pinned playbook version, environments, warnings, and each milestone's stage, open checks, the current stage's checks (state, source, evidence), environments reached and next action. Done milestones are summarized.",
      inputSchema: z.object({ project: z.string().describe("Project code, e.g. PMA (or its id).") }),
      annotations: READ,
    },
    async ({ project }) =>
      run(async () => {
        const ws = await loadWorkspace();
        const p = resolve("project", ws.projects, project);
        const result = lifecycle({ ...ws, projects: [{ ...p, status: "active" }], plan: scheduleFor(ws) });
        const view = result.projects[0];
        if (!view) return json({ code: p.code, status: p.status, playbook: p.playbook, warnings: result.warnings });
        const version = ws.playbooks.find((v) => v.ref === view.playbook)!;
        return json({
          ...view,
          status: p.status,
          checks: projectChecks(version.definition, version.ref, p.detectors).length,
          milestones: view.milestones.map(lifecycleRow),
        });
      }),
  );

  server.registerTool(
    "pass_check",
    {
      title: "Pass a check",
      description:
        "Record that a milestone's lifecycle check passed, with evidence (a link, a commit, or one line). Any stage's check can be passed early. advance_stage moves the milestone on once its stage's checks pass.",
      inputSchema: z.object({ milestone: milestoneArg, check: checkArg, evidence: z.string().optional(), by: byArg }),
      annotations: WRITE,
    },
    async ({ milestone, check, evidence, by }) =>
      run(async () => json(await milestoneAfter(await setCheck(milestone, check, "passed", evidence, by)))),
  );

  server.registerTool(
    "fail_check",
    {
      title: "Fail a check",
      description: "Record that a check failed (e.g. review findings), with what failed. It blocks advancing until it passes or is waived.",
      inputSchema: z.object({ milestone: milestoneArg, check: checkArg, evidence: z.string().min(1).describe("What failed."), by: byArg }),
      annotations: WRITE,
    },
    async ({ milestone, check, evidence, by }) =>
      run(async () => json(await milestoneAfter(await setCheck(milestone, check, "failed", evidence, by)))),
  );

  server.registerTool(
    "waive_check",
    {
      title: "Waive a check",
      description:
        "Skip a check for this milestone, with the reason (kept on the record). Use it when a check doesn't apply; confirm with the user before waiving checks they care about.",
      inputSchema: z.object({ milestone: milestoneArg, check: checkArg, reason: z.string().min(1), by: byArg }),
      annotations: WRITE,
    },
    async ({ milestone, check, reason, by }) =>
      run(async () => json(await milestoneAfter(await setCheck(milestone, check, "waived", reason, by)))),
  );

  server.registerTool(
    "reopen_check",
    {
      title: "Reopen a check",
      description: "Clear a check's recorded result, so it's open again (auto checks go back to being computed).",
      inputSchema: z.object({ milestone: milestoneArg, check: checkArg }),
      annotations: WRITE,
    },
    async ({ milestone, check }) => run(async () => json(await milestoneAfter(await setCheck(milestone, check, "open")))),
  );

  server.registerTool(
    "advance_stage",
    {
      title: "Advance stage",
      description:
        "Move a milestone to its next lifecycle stage (idea → spec → design → plan → build → verify → release → learn → done, or maintain after learn when the retro proposed playbook changes). Refused while the current stage has open or failed checks: pass or waive them first. `to` can also be an earlier stage, to send it back.",
      inputSchema: z.object({
        milestone: milestoneArg,
        to: z.enum([...LIFECYCLE_STAGES, "done"]).optional().describe("Default: the next stage (after learn: done)."),
      }),
      annotations: WRITE,
    },
    async ({ milestone, to }) => run(async () => json(await milestoneAfter(await advanceStage(milestone, to)))),
  );

  server.registerTool(
    "record_deployment",
    {
      title: "Record deployment",
      description:
        "Record that a milestone reached an environment of its playbook (e.g. dev, staging, prod), with the commit or URL. Environments go in promotion order; skipping one needs a note saying why.",
      inputSchema: DeploymentInput.extend({ milestone: milestoneArg, env: z.string().describe("Environment name, e.g. prod.") }),
      annotations: WRITE,
    },
    async ({ milestone, env, ...input }) => run(async () => json(await milestoneAfter(await recordDeployment(milestone, env, input)))),
  );

  server.registerTool(
    "set_playbook_version",
    {
      title: "Pin playbook version",
      description:
        "Pin a project to a stored playbook version (e.g. PMA@1.2.0): to adopt a playbook, upgrade, or roll back. When adopting, `stages` places existing milestones on the lifecycle (milestone code → stage) and puts their status in step. Confirm with the user before re-pinning.",
      inputSchema: z.object({
        project: z.string().describe("Project code, e.g. PMA."),
        version: z.string().describe("A stored version, e.g. PMA@1.2.0 (sync_playbook stores one)."),
        stages: z.record(z.string(), LifecycleStage).optional().describe("Milestone code → stage, e.g. { \"PMA-M3\": \"release\" }."),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ project, version, stages }) =>
      run(async () => {
        const pinned = await setPlaybookVersion(project, version, stages);
        const ws = await loadWorkspace();
        const result = lifecycle({ ...ws, projects: [{ ...pinned.project, status: "active" }], plan: scheduleFor(ws) });
        return json({
          project: pinned.project.code,
          playbook: pinned.project.playbook,
          placed: pinned.milestones.map((m) => `${m.code} → ${m.stage}`),
          warnings: result.warnings,
          next: result.next,
        });
      }),
  );

  server.registerTool(
    "sync_playbook",
    {
      title: "Store playbook version",
      description:
        "Store a compiled playbook (a project's playbook merged with its layers, as pm-flow builds it) as a new version. Sending the same content again changes nothing; changed content needs a new version number. Company playbooks keep only metadata. pm-flow normally calls POST /api/playbooks instead.",
      inputSchema: z.object({
        playbook: z
          .record(z.string(), z.unknown())
          .describe("{ name, version, layers, software, principles, environments, checks, detectors, rules } (src/lib/playbook.ts)."),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ playbook }) =>
      run(async () => {
        const { version, created } = await syncPlaybook(playbook);
        return json({ ref: version.ref, hash: version.hash, synced_at: version.synced_at, created });
      }),
  );

  // ---------------------------------------------------------------- schedule
  server.registerTool(
    "get_schedule",
    {
      title: "Get schedule",
      description:
        "Compute the plan from now: day-by-day time blocks, projected finish, deadline risks, unscheduled tasks (with reasons) and warnings (over-estimate, too large).",
      inputSchema: z.object({
        days: z.number().int().positive().max(90).optional().describe("Working days to show (default 10)."),
        format: z.enum(["text", "json"]).optional().describe("text (default) is a readable plan; json has every field."),
      }),
      annotations: READ,
    },
    async ({ days = 10, format = "text" }) =>
      run(async () => {
        const ws = await loadWorkspace();
        const plan = scheduleFor(ws);
        if (format === "json") return json({ ...plan, days: plan.days.slice(0, days) });
        return text(renderSchedule(plan, new Map(ws.tasks.map((t) => [t.id, t])), days));
      }),
  );

  server.registerTool(
    "get_estimation_stats",
    {
      title: "Estimation stats",
      description:
        "How accurate past estimates were (actual ÷ estimate), overall and per tag, plus recent completed tasks as reference points. Read before estimating.",
      inputSchema: noArgs,
      annotations: READ,
    },
    async () =>
      run(async () => {
        const ws = await loadWorkspace();
        return json({ current_buffer: ws.settings.buffer, ...estimationStats(ws.tasks) });
      }),
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update settings",
      description:
        "Change timezone, working hours per weekday (e.g. mon: [\"09:00-12:00\",\"13:00-17:00\"]), days_off, per-date overrides, estimate buffer, min_block_hours, max_task_hours or horizon_days. Only the given fields change.",
      inputSchema: SettingsPatch,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (patch) => run(async () => json(await updateSettings(patch))),
  );

  // ----------------------------------------------------------------- prompts
  server.registerPrompt(
    "breakdown_project",
    {
      title: "Plan a project",
      description: "Turn a project's goal into milestones with specs, then break each milestone into tasks.",
      argsSchema: z.object({ project_id: z.string().describe("Project code, e.g. PMA.") }),
    },
    async ({ project_id }) => ({
      messages: [{ role: "user", content: { type: "text", text: projectBreakdownPrompt(project_id.trim().toUpperCase()) } }],
    }),
  );

  server.registerPrompt(
    "breakdown_milestone",
    {
      title: "Break down a milestone",
      description: "Turn a milestone spec into small, estimated, dependency-linked tasks.",
      argsSchema: z.object({ milestone_id: z.string().describe("Milestone code, e.g. PMA-M2.") }),
    },
    async ({ milestone_id }) => {
      const ws = await loadWorkspace();
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: breakdownPrompt(milestone_id.trim().toUpperCase(), ws.settings.max_task_hours) },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "estimate_tasks",
    {
      title: "Estimate tasks",
      description: "Three-point estimates for unestimated tasks, calibrated against your history.",
      argsSchema: z.object({ milestone_id: z.string().optional().describe("Limit to one milestone, e.g. PMA-M2.") }),
    },
    async ({ milestone_id }) => {
      const ws = await loadWorkspace();
      const scope = milestone_id
        ? `the open tasks of milestone ${milestone_id.trim().toUpperCase()} that have no estimate`
        : "all open tasks that have no estimate";
      return {
        messages: [{ role: "user", content: { type: "text", text: estimatePrompt(scope, ws.settings.max_task_hours) } }],
      };
    },
  );

  server.registerPrompt(
    "work_on_task",
    {
      title: "Work on a task",
      description: "Pick up a task from its code: read its context, check dependencies, do the work and log time.",
      argsSchema: z.object({ task_id: z.string().describe("Task code, e.g. PMA-M1-T3.") }),
    },
    ({ task_id }) => ({
      messages: [{ role: "user", content: { type: "text", text: workOnTaskPrompt(task_id.trim().toUpperCase()) } }],
    }),
  );

  server.registerPrompt(
    "replan",
    { title: "Replan", description: "Diagnose the schedule and propose a rearrangement.", argsSchema: noArgs },
    () => ({ messages: [{ role: "user", content: { type: "text", text: REPLAN_PROMPT } }] }),
  );

  server.registerPrompt(
    "daily_checkin",
    { title: "Daily check-in", description: "Log yesterday's work and show today's plan.", argsSchema: noArgs },
    () => ({ messages: [{ role: "user", content: { type: "text", text: CHECKIN_PROMPT } }] }),
  );
}
