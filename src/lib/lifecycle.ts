import { compareCodes } from "./codes";
import { earliestDate, inheritedPriority, projectHold } from "./hierarchy";
import { checkStage, compareVersions, type Check, type Playbook, type PlaybookVersion } from "./playbook";
import type { ScheduleResult } from "./scheduler";
import {
  LIFECYCLE_STAGES,
  type CheckResult,
  type Deployment,
  type LifecycleStage,
  type Milestone,
  type MilestoneStatus,
  type Priority,
  type Project,
  type ProjectContext,
  type Settings,
  type Task,
} from "./types";

/**
 * The lifecycle engine: where each milestone stands against its project's pinned playbook, what to do next, and what
 * needs attention across projects. Pure, like the scheduler: the caller passes the workspace, plus the schedule for
 * deadline risk and task order. Stages are fixed (LIFECYCLE_STAGES); playbooks only add checks to them.
 */

/** More milestones than this in build at once, across projects, is flagged. */
export const WIP_LIMIT = 3;

export type CheckState = "open" | "passed" | "waived" | "failed";

export interface CheckStatus {
  key: string;
  stage: LifecycleStage;
  kind: Check["kind"];
  /** The pinned playbook version (`PMA@1.0.0`), or `detector:<name>` for a check a detector added. */
  source: string;
  state: CheckState;
  env?: string;
  principle?: string;
  /** The text of the check. */
  text?: string;
  skill?: string;
  /** Why an auto check isn't passed, e.g. "2 of 5 tasks unestimated". */
  detail?: string;
  /** The recorded result, if any; it wins over what an auto check would compute. */
  result?: CheckResult;
}

export type NextAction =
  | { kind: "check"; check: string; env?: string; skill?: string; text: string }
  | { kind: "work"; task?: string; text: string }
  | { kind: "deploy"; env: string; text: string }
  | { kind: "advance"; to: LifecycleStage | "done"; text: string };

export interface MilestoneLifecycle {
  code: string;
  id: string;
  title: string;
  project: string;
  status: MilestoneStatus;
  stage: LifecycleStage;
  priority: Priority;
  deadline?: string;
  /** One of its tasks is projected to miss its deadline. */
  at_risk: boolean;
  environments: { name: string; reached?: Deployment }[];
  /** Every check of the playbook, in playbook order (detector checks last). */
  checks: CheckStatus[];
  /** Keys of the current stage's checks that aren't passed or waived: what stops it advancing. */
  open: string[];
  /** Absent once the milestone is done or cancelled. */
  next?: NextAction;
}

export type WarningCode = "no_playbook" | "no_project_rules" | "playbook_update";

export interface LifecycleWarning {
  code: WarningCode;
  project: string;
  message: string;
}

export interface ProjectLifecycle {
  code: string;
  title: string;
  context: ProjectContext;
  /** The pinned version, if it is stored. */
  playbook?: string;
  environments: string[];
  warnings: LifecycleWarning[];
  milestones: MilestoneLifecycle[];
}

export interface RankedAction {
  project: string;
  context: ProjectContext;
  milestone: string;
  title: string;
  stage: LifecycleStage;
  priority: Priority;
  deadline?: string;
  at_risk: boolean;
  action: NextAction;
  open: string[];
  /** Other milestones of the project in the same stage with the very same next action (one prod cut-over releases them all). */
  with?: string[];
}

export interface LifecycleResult {
  /** Projects on a lifecycle: pinned to a stored playbook, and not on hold, done or cancelled. */
  projects: ProjectLifecycle[];
  /** Every warning, for all active projects (including those without a playbook). */
  warnings: LifecycleWarning[];
  /** What to do next, most important first; one entry per distinct action. Ideas and finished milestones aren't listed. */
  next: RankedAction[];
  wip: { in_build: string[]; limit: number; over: boolean };
}

export interface LifecycleInput {
  projects: Project[];
  milestones: Milestone[];
  tasks: Task[];
  playbooks: PlaybookVersion[];
  settings: Pick<Settings, "max_task_hours">;
  plan?: Pick<ScheduleResult, "tasks" | "at_risk">;
}

const stageIndex = (stage: LifecycleStage) => LIFECYCLE_STAGES.indexOf(stage);

/** The milestone status that goes with a stage (repo.ts keeps them in step). */
export function statusForStage(stage: LifecycleStage): MilestoneStatus {
  if (stage === "idea") return "idea";
  if (stage === "spec" || stage === "design" || stage === "plan") return "planned";
  return "in_progress";
}

/** Where a milestone can go from a stage. After learn it's done, or maintain when the retro proposed playbook changes. */
export function nextStages(stage: LifecycleStage): (LifecycleStage | "done")[] {
  if (stage === "learn") return ["done", "maintain"];
  if (stage === "maintain") return ["done"];
  return [LIFECYCLE_STAGES[stageIndex(stage) + 1]];
}

interface Entry {
  key: string;
  check: Check;
  source: string;
}

/** The playbook's checks, then those of the detectors that fired in the project's repos. */
export function projectChecks(playbook: Playbook, ref: string, detectors: string[]): Entry[] {
  const entries: Entry[] = Object.entries(playbook.checks).map(([key, check]) => ({ key, check, source: ref }));
  for (const detector of playbook.detectors) {
    if (!detectors.includes(detector.name)) continue;
    for (const [key, check] of Object.entries(detector.add)) entries.push({ key, check, source: `detector:${detector.name}` });
  }
  return entries;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What an auto check computes from the milestone's own tasks and deployments. */
function autoState(
  check: Extract<Check, { kind: "auto" }>,
  milestone: Milestone,
  tasks: Task[],
  environments: string[],
  maxTaskHours: number,
): { state: CheckState; detail?: string } {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const open = (detail: string) => ({ state: "open" as const, detail });
  const codes = (list: Task[]) => list.map((t) => t.code).join(", ");
  switch (check.rule) {
    case "tasks_estimated": {
      if (!live.length) return open("no tasks yet");
      const missing = live.filter((t) => t.estimate === undefined);
      return missing.length ? open(`${missing.length} of ${plural(live.length, "task")} unestimated`) : { state: "passed" };
    }
    case "tasks_small": {
      if (!live.length) return open("no tasks yet");
      const big = live.filter((t) => t.status !== "done" && (t.estimate ?? 0) > maxTaskHours);
      return big.length ? open(`over ${maxTaskHours}h: ${codes(big)}`) : { state: "passed" };
    }
    case "tasks_done": {
      if (!live.length) return open("no tasks yet");
      const done = live.filter((t) => t.status === "done").length;
      return done < live.length ? open(`${done} of ${plural(live.length, "task")} done`) : { state: "passed" };
    }
    case "time_logged": {
      const done = live.filter((t) => t.status === "done");
      if (!done.length) return open("no finished tasks");
      const missing = done.filter((t) => !(t.spent > 0));
      return missing.length ? open(`no time logged on ${codes(missing)}`) : { state: "passed" };
    }
    case "deployed": {
      const targets = check.env ? [check.env] : environments;
      const missing = targets.filter((env) => !milestone.deployments[env]);
      return missing.length ? open(`not on ${missing.join(", ")} yet`) : { state: "passed" };
    }
  }
}

function evaluate(
  entry: Entry,
  milestone: Milestone,
  tasks: Task[],
  environments: string[],
  maxTaskHours: number,
): CheckStatus {
  const { key, check, source } = entry;
  const result = milestone.checks[key];
  const computed =
    result ? { state: result.status } : check.kind === "auto" ? autoState(check, milestone, tasks, environments, maxTaskHours) : { state: "open" as const };
  return {
    key,
    stage: checkStage(key),
    kind: check.kind,
    source,
    state: computed.state,
    env: check.env,
    principle: check.principle,
    text: check.text,
    skill: check.kind === "attest" ? check.skill : undefined,
    detail: "detail" in computed ? computed.detail : undefined,
    result,
  };
}

const pending = (c: CheckStatus) => c.state === "open" || c.state === "failed";
const isDeploy = (entry?: Entry) => entry?.check.kind === "auto" && entry.check.rule === "deployed";

function checkAction(c: CheckStatus): NextAction {
  const where = c.env ? ` (${c.env})` : "";
  const why = c.state === "failed" ? `failed${c.result?.note ? `: ${c.result.note}` : ""}` : (c.detail ?? c.text ?? "open");
  return { kind: "check", check: c.key, env: c.env, skill: c.skill, text: `${c.key}${where}: ${why}` };
}

function nextAction(
  milestone: Milestone,
  stage: LifecycleStage,
  checks: CheckStatus[],
  entries: Map<string, Entry>,
  environments: string[],
  firstTask: Task | undefined,
): NextAction {
  const current = checks.filter((c) => c.stage === stage && pending(c));
  if (stage === "release") {
    // In promotion order: an environment's own checks come before deploying to it, and the deploy check turns into
    // "deploy to <next environment>". Checks for later environments wait their turn.
    const nextEnv = environments.find((env) => !milestone.deployments[env]);
    const actionable = current.filter(
      (c) => !isDeploy(entries.get(c.key)) && (!c.env || c.env === nextEnv || Boolean(milestone.deployments[c.env])),
    );
    if (actionable.length) return checkAction(actionable[0]);
    if (nextEnv && current.some((c) => isDeploy(entries.get(c.key)))) {
      return { kind: "deploy", env: nextEnv, text: `Deploy to ${nextEnv} and record it` };
    }
    if (current.length) return checkAction(current[0]);
  } else if (current.length) {
    const first = current[0];
    const entry = entries.get(first.key);
    if (entry?.check.kind === "auto" && entry.check.rule === "tasks_done" && first.state === "open") {
      return {
        kind: "work",
        task: firstTask?.code,
        text: `${first.key}: ${first.detail}${firstTask ? `; next ${firstTask.code} ${firstTask.title}` : ""}`,
      };
    }
    return checkAction(first);
  }
  const [to] = nextStages(stage);
  const text =
    stage === "learn"
      ? "Advance to done, or to maintain if the retro proposed playbook changes"
      : `Advance to ${to}`;
  return { kind: "advance", to, text };
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
/** YYYY-MM-DD, earliest first; no deadline last. */
const compareDeadlines = (a?: string, b?: string) => (a === b ? 0 : !a ? 1 : !b ? -1 : a < b ? -1 : 1);

function latestVersions(playbooks: PlaybookVersion[]) {
  const latest = new Map<string, string>();
  for (const v of playbooks) {
    const known = latest.get(v.name);
    if (!known || compareVersions(v.version, known) > 0) latest.set(v.name, v.version);
  }
  return latest;
}

function projectWarnings(project: Project, pinned: PlaybookVersion | undefined, latest: Map<string, string>): LifecycleWarning[] {
  const warn = (code: WarningCode, message: string): LifecycleWarning => ({ code, project: project.code, message });
  if (!project.playbook) return [warn("no_playbook", `${project.code} has no playbook yet; adopt one`)];
  if (!pinned) return [warn("no_playbook", `${project.code} is pinned to ${project.playbook}, which isn't stored`)];
  const warnings: LifecycleWarning[] = [];
  if (pinned.definition.rules.project === 0) {
    warnings.push(warn("no_project_rules", `${project.code}'s playbook ${pinned.ref} has no project rules; add some`));
  }
  const own = latest.get(pinned.name);
  if (own && compareVersions(own, pinned.version) > 0) {
    warnings.push(warn("playbook_update", `${pinned.name}@${own} is available (pinned ${pinned.ref})`));
  }
  for (const layer of pinned.definition.layers) {
    const newer = latest.get(layer.name);
    if (newer && compareVersions(newer, layer.version) > 0) {
      warnings.push(warn("playbook_update", `${layer.name}@${newer} is available (${pinned.ref} was compiled with ${layer.version})`));
    }
  }
  return warnings;
}

export interface MilestoneContext {
  project: Project;
  /** The project's pinned version. */
  version: PlaybookVersion;
  /** The milestone's own tasks. */
  tasks: Task[];
  settings: Pick<Settings, "max_task_hours">;
  at_risk?: boolean;
  /** Its first scheduled task, which "keep building" points at. */
  firstTask?: Task;
}

/** One milestone against its project's pinned playbook. */
export function milestoneLifecycle(milestone: Milestone, ctx: MilestoneContext): MilestoneLifecycle {
  const { project, version, settings } = ctx;
  const environments = version.definition.environments.map((e) => e.name);
  const entries = projectChecks(version.definition, version.ref, project.detectors);
  const stage = milestone.stage ?? "idea";
  const checks = entries.map((e) => evaluate(e, milestone, ctx.tasks, environments, settings.max_task_hours));
  const finished = milestone.status === "done" || milestone.status === "cancelled";
  return {
    code: milestone.code,
    id: milestone.id,
    title: milestone.title,
    project: project.code,
    status: milestone.status,
    stage,
    priority: inheritedPriority(milestone.priority, project.priority),
    deadline: earliestDate(milestone.deadline, project.deadline),
    at_risk: Boolean(ctx.at_risk),
    environments: environments.map((name) => ({ name, reached: milestone.deployments[name] })),
    checks,
    open: checks.filter((c) => c.stage === stage && pending(c)).map((c) => c.key),
    next: finished
      ? undefined
      : nextAction(milestone, stage, checks, new Map(entries.map((e) => [e.key, e])), environments, ctx.firstTask),
  };
}

export function lifecycle({ projects, milestones, tasks, playbooks, settings, plan }: LifecycleInput): LifecycleResult {
  const versions = new Map(playbooks.map((v) => [v.ref, v]));
  const latest = latestVersions(playbooks);
  const tasksOf = new Map<string, Task[]>();
  for (const t of tasks) tasksOf.set(t.milestone, [...(tasksOf.get(t.milestone) ?? []), t]);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const atRisk = new Set((plan?.at_risk ?? []).map((r) => taskById.get(r.id)?.milestone).filter(Boolean));
  // The first scheduled task of each milestone: what "keep building" points at.
  const firstScheduled = new Map<string, Task>();
  for (const slot of plan?.tasks ?? []) {
    const task = taskById.get(slot.id);
    if (task && !firstScheduled.has(slot.milestone)) firstScheduled.set(slot.milestone, task);
  }

  const result: LifecycleResult = { projects: [], warnings: [], next: [], wip: { in_build: [], limit: WIP_LIMIT, over: false } };
  for (const project of [...projects].sort((a, b) => compareCodes(a.code, b.code))) {
    if (projectHold(project)) continue;
    const pinned = project.playbook ? versions.get(project.playbook) : undefined;
    const warnings = projectWarnings(project, pinned, latest);
    result.warnings.push(...warnings);
    if (!pinned) continue;

    const view: ProjectLifecycle = {
      code: project.code,
      title: project.title,
      context: project.context,
      playbook: pinned.ref,
      environments: pinned.definition.environments.map((e) => e.name),
      warnings,
      milestones: [],
    };

    for (const milestone of milestones.filter((m) => m.project === project.id).sort((a, b) => compareCodes(a.code, b.code))) {
      const item = milestoneLifecycle(milestone, {
        project,
        version: pinned,
        tasks: tasksOf.get(milestone.id) ?? [],
        settings,
        at_risk: atRisk.has(milestone.id),
        firstTask: firstScheduled.get(milestone.id),
      });
      view.milestones.push(item);
      const { stage } = item;
      if (milestone.status === "done" || milestone.status === "cancelled") continue;
      if (stage === "build") result.wip.in_build.push(milestone.code);
      if (stage === "idea" || !item.next) continue;
      result.next.push({
        project: project.code,
        context: project.context,
        milestone: item.code,
        title: item.title,
        stage,
        priority: item.priority,
        deadline: item.deadline,
        at_risk: item.at_risk,
        action: item.next,
        open: item.open,
      });
    }
    result.projects.push(view);
  }

  result.next.sort(
    (a, b) =>
      Number(b.at_risk) - Number(a.at_risk) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      stageIndex(b.stage) - stageIndex(a.stage) ||
      compareDeadlines(a.deadline, b.deadline) ||
      compareCodes(a.milestone, b.milestone),
  );
  // One entry per action: the same step for the same project and stage is done once, for all of them.
  const grouped: RankedAction[] = [];
  for (const item of result.next) {
    const same = grouped.find((g) => g.project === item.project && g.stage === item.stage && sameAction(g.action, item.action));
    if (same) same.with = [...(same.with ?? []), item.milestone];
    else grouped.push(item);
  }
  result.next = grouped;
  result.wip.over = result.wip.in_build.length > WIP_LIMIT;
  return result;
}

function sameAction(a: NextAction, b: NextAction) {
  return a.kind === b.kind && a.text === b.text && ("check" in a ? a.check : undefined) === ("check" in b ? b.check : undefined);
}
