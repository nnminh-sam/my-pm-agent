export const SERVER_INSTRUCTIONS = `Personal project-management system for one person.

Data model — Project → Milestone → Task. Refer to records by code (case-insensitive); each also has an opaque uuid id that tools accept too:
- Projects (code chosen at creation, 2–6 letters/digits, e.g. PMA): a goal/description, priority P0–P3, optional deadline, status planned|active|on_hold|done|cancelled. Tasks of on_hold/done/cancelled projects are not scheduled.
- Milestones (PMA-M1, numbered within their project): belong to a project; a spec in markdown, priority (inherits the project's), optional deadline.
- Tasks (PMA-M1-T3, numbered within their milestone): belong to a milestone; estimate in hours (optionally a three-point range), priority (inherits milestone → project), deadline (the earliest of task/milestone/project applies), depends_on, not_before, tags, logged time (spent), status todo|in_progress|blocked|done|cancelled.
- Codes change when a project's code changes or an item moves to another parent (it takes the next number there); use the codes from the latest tool output.
- Settings: timezone, working hours per weekday, days off, estimate buffer.

A deterministic scheduler lays open tasks onto the working hours. Never work out a schedule yourself — call get_schedule. It respects dependencies, priority, deadlines (pulling late tasks forward when that helps) and marks deadline risks.

Workflows:
- New project: create_project with a goal and a code, then follow the breakdown_project prompt to propose milestones (create_milestone with project set), then break each milestone down.
- New milestone: create_milestone with a spec (and its project), then follow the breakdown_milestone prompt — tasks of at most max_task_hours, three-point estimates via \`pert\`, dependencies via \`ref\`, all in one create_tasks call.
- Estimating: read get_estimation_stats first and calibrate against the actual/estimate ratio of similar (same-tag) work.
- Rearranging: change priority, order (reorder_tasks), depends_on, not_before, deadline or the estimate with update_task. The schedule recomputes on every read, so call get_schedule afterwards to show the effect.
- Progress: log_time as work happens (this feeds estimate calibration). log_time with done=true completes a task.
- A bare task code from the user (e.g. PMA-M1-T3) means "work on this task": call get_task, read its milestone spec and dependencies, then do the work — update_task status in_progress, log_time as work happens, log_time with done=true when finished (the work_on_task prompt has the steps).

Lifecycle — every project follows the same stages: idea → spec → design → plan → build → verify → release → learn (→ maintain, optional) → done. A project's playbook (a pinned version, e.g. PMA@1.0.0) adds checks to the stages (auto: computed from tasks and deployments; probe: from repo signals; attest: recorded with evidence) and names its environments (e.g. dev → prod). Each milestone carries its stage, its check results and the environments it has reached.
- What's next across projects: get_next (warnings, ranked next actions, today's blocks); get_lifecycle shows one project.
- Checks: pass_check with evidence, fail_check with what failed, waive_check with a reason, reopen_check to clear. advance_stage moves a milestone on only once its stage's checks pass; never change a milestone's status to get around that.
- Releases: record_deployment for each environment, in the playbook's order.
- Adopting a playbook: sync_playbook stores a version, then set_playbook_version pins the project and places its existing milestones (stages). Re-pin to upgrade or roll back.
- Company projects (context company) keep only metadata and links in my_pm: link to company documents in specs and evidence rather than copying them.

Start with get_overview. Confirm with the user before bulk-creating, cancelling or re-prioritising several tasks.`;

export function projectBreakdownPrompt(projectId: string) {
  return `Act as my project manager and plan project ${projectId} as a set of milestones.

1. Call get_project("${projectId}") for its goal and any existing milestones, and list_projects to see what else competes for my time.
2. If the goal leaves scope unclear, list your assumptions — or ask me up to 3 questions — before drafting.
3. Propose the milestones:
   - Each milestone is a user-visible capability or a coherent technical step that can ship on its own — typically 1–5 days of work.
   - For each: title, a short markdown spec (goal, scope, out of scope, acceptance criteria as a checklist), priority relative to the others (omit it to inherit the project's), and a rough size (S ≤ 1 day, M 2–3 days, L 4–5 days; split anything bigger).
   - Order them so foundations come first (they're numbered in creation order: M1, M2, …); note which milestones depend on which.
   - Call out what you are deliberately leaving out.
4. Show me the list as a table (title, size, priority, depends on) and wait for my OK.
5. Once I confirm, create each milestone, in order, with create_milestone (project: "${projectId}"). Then offer to break them down one by one with the breakdown_milestone steps, starting with the first.`;
}

export function breakdownPrompt(milestoneId: string, maxTaskHours: number) {
  return `Act as my project manager and break milestone ${milestoneId} down into schedulable tasks.

1. Call get_milestone("${milestoneId}") for the spec and any existing tasks, and get_estimation_stats to see how my past estimates compared with actual time.
2. If the spec leaves scope unclear, list your assumptions — or ask me up to 3 questions — before drafting.
3. Draft the breakdown:
   - Each task is a concrete, verifiable outcome ("Add POST /login with input validation"), not an activity ("work on backend").
   - Each task is 0.5–${maxTaskHours}h of focused work; split anything bigger.
   - Include the work that usually gets forgotten: spikes for unknowns, tests, review fixes, docs, deploy and verification.
   - Give every task a three-point estimate (optimistic / likely / pessimistic hours). Express uncertainty with a wider range, not a padded "likely". Adjust with the calibration ratio for similar tags.
   - Use depends_on only for real ordering constraints (use \`ref\`s inside the batch).
   - Tag the kind of work (frontend, backend, infra, research, testing, …) — tags drive estimate calibration.
   - Description: 1–3 lines of context, then acceptance criteria as a checklist.
4. Show me the breakdown as a table (ref, title, o/m/p, expected, depends on) with the total expected hours ± σ, and wait for my OK.
5. Once I confirm, create everything in a single create_tasks call (milestone: "${milestoneId}"), then call get_schedule and tell me when the milestone will be done and whether anything is at risk.`;
}

export function estimatePrompt(scope: string, maxTaskHours: number) {
  return `Estimate ${scope}.

1. Call list_tasks to find the open tasks without an estimate (or the ones I point out), then get_estimation_stats.
2. For each task, read get_task for details and give an optimistic / likely / pessimistic estimate in hours with a one-line rationale. Cite comparable completed tasks from the stats when you can, and apply the calibration ratio for similar tags.
3. Flag any task whose likely estimate exceeds ${maxTaskHours}h and propose how to split it.
4. Show a table and wait for my OK. Then save each estimate with update_task using \`pert\`.
5. Call get_schedule and summarise how the finish date and deadline risks changed.`;
}

export function workOnTaskPrompt(taskId: string) {
  return `Work on task ${taskId}.

1. Call get_task("${taskId}") for its description, acceptance criteria, milestone spec (milestone_context), project and dependencies.
2. Check that every dependency is done. If one isn't, tell me which and ask whether to go ahead before starting.
3. Set it in progress with update_task (status in_progress), then do the work, following the task's acceptance criteria within the milestone spec. If the scope is unclear, ask before guessing.
4. log_time as work happens; when every acceptance criterion is met, log_time with done=true and a one-line note.
5. Report back: what you did, how each acceptance criterion was met, anything left open, and the hours logged.`;
}

export const REPLAN_PROMPT = `Review my schedule and help me rearrange it.

1. Call get_overview and get_schedule.
2. Diagnose: deadlines at risk, tasks that have run over their estimate, blocked or unestimated tasks, tasks too large to schedule well, and whether the order matches what matters most.
3. Propose concrete changes, each with its expected effect: re-prioritise (update_task priority, or reorder_tasks within a priority), re-estimate remaining work, add or remove dependencies, defer with not_before, move a deadline, split a task, or cut scope (status cancelled).
4. Wait for my OK, apply the changes, then show the new finish date and any remaining risks.`;

export const CHECKIN_PROMPT = `Run my daily check-in.

1. Call get_schedule with days=2.
2. Ask what I worked on since the last check-in (hours per task), and whether anything is done or blocked.
3. Record it with log_time (done=true for finished tasks) and update_task (status blocked, plus a note on why).
4. Show today's plan with times and call out anything at risk.`;
