import { z } from "zod";
import {
  compareCodes,
  codeKind,
  isId,
  isLegacyId,
  milestoneCode,
  newId,
  normalizeCode,
  PROJECT_CODE,
  renameMentions,
  taskCode,
  type CodeKind,
} from "./codes";
import { pert } from "./estimation";
import { comparePlaybookVersions, type PlaybookVersion } from "./playbook";
import { getRepository, type Repository } from "./repository";
import type { Changes, Key } from "./repository/types";
import { todayIn } from "./time";
import {
  ApiKey,
  Milestone,
  MilestoneStatus,
  Priority,
  Project,
  ProjectStatus,
  Settings,
  SettingsPatch,
  Task,
  TaskStatus,
  User,
  dateStr,
} from "./types";

// ---------------------------------------------------------------------------
// Input shapes shared by the MCP tools and the web UI. Records are referred to by code (PMA, PMA-M1, PMA-M1-T3,
// case-insensitive) or by id (uuid); see src/lib/codes.ts.
// ---------------------------------------------------------------------------

export const PertInput = z
  .object({
    optimistic: z.number().nonnegative(),
    likely: z.number().nonnegative(),
    pessimistic: z.number().nonnegative(),
  })
  .describe("Three-point estimate in hours; stored as the PERT mean (o + 4m + p) / 6 plus the [o, p] range.");

export const NewTask = z.object({
  ref: z.string().optional().describe("Temporary key so other tasks in the same batch can depend on this one."),
  title: z.string().min(1),
  description: z.string().optional().describe("Markdown: context, acceptance criteria, notes."),
  milestone: z.string().describe("Milestone code, e.g. PMA-M2 (or its id). The task is numbered within it: PMA-M2-T5."),
  priority: Priority.optional().describe("P0 (critical) … P3 (low). Defaults to the milestone's priority."),
  estimate: z.number().nonnegative().optional().describe("Hours. Prefer `pert` for anything non-trivial."),
  pert: PertInput.optional(),
  deadline: dateStr.optional(),
  not_before: dateStr.optional(),
  depends_on: z.array(z.string()).optional().describe("Existing task codes (or ids), or `ref`s from this batch."),
  tags: z.array(z.string()).optional(),
  status: TaskStatus.optional(),
});
export type NewTask = z.infer<typeof NewTask>;

export const TaskPatch = z.object({
  title: z.string().min(1).optional(),
  status: TaskStatus.optional(),
  priority: Priority.nullable().optional().describe("null → inherit from the milestone."),
  milestone: z
    .string()
    .optional()
    .describe("Move to another milestone (code or id). The task takes that milestone's next number, so its code changes."),
  estimate: z.number().nonnegative().optional(),
  pert: PertInput.optional(),
  spent: z.number().nonnegative().optional().describe("Total hours worked (overwrites). Use log_time to add."),
  deadline: dateStr.nullable().optional(),
  not_before: dateStr.nullable().optional(),
  depends_on: z.array(z.string()).optional().describe("Task codes (or ids)."),
  tags: z.array(z.string()).optional(),
  order: z.number().nullable().optional(),
  description: z.string().optional().describe("Replaces the markdown body."),
  append_note: z.string().optional().describe("Appended to the body under a dated heading."),
});
export type TaskPatch = z.infer<typeof TaskPatch>;

export const NewMilestone = z.object({
  title: z.string().min(1),
  project: z.string().describe("Project code, e.g. PMA (or its id). The milestone is numbered within it: PMA-M3."),
  description: z.string().optional().describe("Markdown spec: goal, scope, out of scope, acceptance criteria."),
  priority: Priority.optional().describe("Defaults to the project's priority."),
  deadline: dateStr.optional(),
  status: MilestoneStatus.optional(),
});
export type NewMilestone = z.infer<typeof NewMilestone>;

export const MilestonePatch = z.object({
  title: z.string().min(1).optional(),
  project: z
    .string()
    .optional()
    .describe("Move to another project (code or id). The milestone takes that project's next number; its tasks' codes follow."),
  description: z.string().optional(),
  priority: Priority.nullable().optional().describe("null → inherit from the project."),
  deadline: dateStr.nullable().optional(),
  status: MilestoneStatus.optional(),
});
export type MilestonePatch = z.infer<typeof MilestonePatch>;

/** Uppercased before it's checked, so `pma` is accepted as PMA. */
export const ProjectCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PROJECT_CODE, "Project code must be 2–6 letters or digits, starting with a letter (e.g. PMA)");

export const NewProject = z.object({
  title: z.string().min(1),
  code: ProjectCode.describe("Short unique code that prefixes its milestone and task codes: PMA → PMA-M1, PMA-M1-T3."),
  description: z.string().optional().describe("Markdown: goal, success criteria, constraints, milestones."),
  priority: Priority.optional().describe("Default for its milestones and tasks (P2 if omitted)."),
  deadline: dateStr.optional().describe("Applies to every task in the project."),
  status: ProjectStatus.optional(),
});
export type NewProject = z.infer<typeof NewProject>;

export const ProjectPatch = z.object({
  title: z.string().min(1).optional(),
  code: ProjectCode.optional().describe("Renames every milestone and task code in the project (PMA-M1 → NEW-M1)."),
  description: z.string().optional(),
  priority: Priority.optional(),
  deadline: dateStr.nullable().optional(),
  status: ProjectStatus.optional().describe("on_hold / done / cancelled take the project's tasks off the schedule."),
});
export type ProjectPatch = z.infer<typeof ProjectPatch>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Users and API keys keep their `U-n` / `K-n` ids; a bare number is accepted for them. */
type Prefix = "U" | "K";

export function normalizeId(id: string, prefix: Prefix) {
  const trimmed = id.trim().toUpperCase();
  if (/^\d+$/.test(trimmed)) return `${prefix}-${trimmed}`;
  return trimmed;
}

export class NotFoundError extends Error {}

const EXAMPLE: Record<CodeKind, string> = { project: "PMA", milestone: "PMA-M1", task: "PMA-M1-T3" };
const LABEL: Record<CodeKind, string> = { project: "Project", milestone: "Milestone", task: "Task" };

/** The lookup key for a code or id, or undefined when `ref` is neither for this kind of record. */
function keyOf(kind: CodeKind, ref: string): Key | undefined {
  if (isId(ref)) return { id: ref.trim().toLowerCase() };
  const code = normalizeCode(ref);
  return codeKind(code) === kind ? { code } : undefined;
}

/** Like keyOf, but explains what's wrong (as a NotFoundError, so a bad URL is a 404). */
function keyFor(kind: CodeKind, ref: string): Key {
  const key = keyOf(kind, ref);
  if (key) return key;
  if (isLegacyId(ref)) {
    throw new NotFoundError(`${normalizeCode(ref)} is an id from before milestones; use a ${kind} code like ${EXAMPLE[kind]}`);
  }
  throw new NotFoundError(`"${ref}" is not a ${kind} code (like ${EXAMPLE[kind]}) or id`);
}

const matches = (key: Key) => (x: { id: string; code: string }) => ("id" in key ? x.id === key.id : x.code === key.code);

/** A record from an already-loaded list, by code or id; same rules and errors as getTask & co. */
export function resolve<T extends { id: string; code: string }>(kind: CodeKind, list: T[], ref: string): T {
  const found = list.find(matches(keyFor(kind, ref)));
  if (!found) throw new NotFoundError(`${LABEL[kind]} ${normalizeCode(ref)} not found`);
  return found;
}

/** `label` names the task in the error (its code, or a ref / title for a task not created yet). */
function assertNoCycle(tasks: Map<string, { depends_on: string[] }>, start: string, label: string) {
  const seen = new Set<string>();
  const stack = [...(tasks.get(start)?.depends_on ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === start) throw new Error(`Dependency cycle: ${label} would depend on itself`);
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks.get(id)?.depends_on ?? []));
  }
}

/**
 * `changes` plus every record whose markdown mentions a renamed code (old → new), with those mentions updated,
 * so references in specs and notes keep pointing at the same items. Records already in `changes` keep their edits.
 */
function withMentions(ws: Pick<Workspace, "tasks" | "milestones" | "projects">, changes: Changes, renames: Map<string, string>): Changes {
  const merge = <T extends { id: string; body: string }>(all: T[], changed: T[] = []) => {
    const byId = new Map(changed.map((x) => [x.id, x]));
    for (const record of all) {
      const current = byId.get(record.id) ?? record;
      const body = renameMentions(current.body, renames);
      if (body !== current.body) byId.set(record.id, { ...current, body });
    }
    return [...byId.values()];
  };
  return { projects: merge(ws.projects, changes.projects), milestones: merge(ws.milestones, changes.milestones), tasks: merge(ws.tasks, changes.tasks) };
}

function withNote(body: string, heading: string, note: string) {
  return `${body.trim()}\n\n### ${heading}\n\n${note.trim()}`.trim();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(repo: Repository = getRepository()): Promise<Settings> {
  const data = { ...((await repo.readSettings()) ?? {}) };
  if (!data.timezone && process.env.PM_TIMEZONE) data.timezone = process.env.PM_TIMEZONE;
  return Settings.parse(data);
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = Settings.parse({ ...current, ...defined });
  await getRepository().writeSettings(next);
  return next;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface Workspace {
  settings: Settings;
  tasks: Task[];
  milestones: Milestone[];
  projects: Project[];
  /** Every stored playbook version, by name then version. */
  playbooks: PlaybookVersion[];
  /** Records that couldn't be parsed, or whose code doesn't match their parents; they don't break anything else. */
  problems: string[];
}

/**
 * Stored codes that disagree with their parents (e.g. after a hand edit), and pins to playbook versions that aren't
 * stored (the file backend has no foreign keys). Reported, never silently fixed.
 */
function codeProblems({ tasks, milestones, projects, playbooks }: Pick<Workspace, "tasks" | "milestones" | "projects" | "playbooks">) {
  const problems: string[] = [];
  const refs = new Set(playbooks.map((v) => v.ref));
  for (const p of projects) {
    if (p.playbook && !refs.has(p.playbook)) problems.push(`project ${p.code}: its playbook ${p.playbook} isn't stored`);
  }
  const projectCodes = new Map(projects.map((p) => [p.id, p.code]));
  const milestoneCodes = new Map(milestones.map((m) => [m.id, m.code]));
  for (const m of milestones) {
    const parent = projectCodes.get(m.project);
    if (!parent) problems.push(`milestone ${m.code}: its project ${m.project} doesn't exist`);
    else if (m.code !== milestoneCode(parent, m.number)) problems.push(`milestone ${m.code}: code should be ${milestoneCode(parent, m.number)}`);
  }
  for (const t of tasks) {
    const parent = milestoneCodes.get(t.milestone);
    if (!parent) problems.push(`task ${t.code}: its milestone ${t.milestone} doesn't exist`);
    else if (t.code !== taskCode(parent, t.number)) problems.push(`task ${t.code}: code should be ${taskCode(parent, t.number)}`);
  }
  return problems;
}

export async function loadWorkspace(repo: Repository = getRepository()): Promise<Workspace> {
  const [settings, { tasks, milestones, projects, playbooks, problems }] = await Promise.all([getSettings(repo), repo.loadAll()]);
  for (const list of [tasks, milestones, projects]) list.sort((a, b) => compareCodes(a.code, b.code));
  playbooks.sort(comparePlaybookVersions);
  return {
    settings,
    tasks,
    milestones,
    projects,
    playbooks,
    problems: [...problems, ...codeProblems({ tasks, milestones, projects, playbooks })],
  };
}

export async function getTask(ref: string): Promise<Task> {
  const task = await getRepository().getTask(keyFor("task", ref));
  if (!task) throw new NotFoundError(`Task ${normalizeCode(ref)} not found`);
  return task;
}

export async function getMilestone(ref: string): Promise<Milestone> {
  const milestone = await getRepository().getMilestone(keyFor("milestone", ref));
  if (!milestone) throw new NotFoundError(`Milestone ${normalizeCode(ref)} not found`);
  return milestone;
}

export async function getProject(ref: string): Promise<Project> {
  const project = await getRepository().getProject(keyFor("project", ref));
  if (!project) throw new NotFoundError(`Project ${normalizeCode(ref)} not found`);
  return project;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTasks(inputs: NewTask[]): Promise<Task[]> {
  const ws = await loadWorkspace();
  const today = todayIn(ws.settings.timezone);
  const refIndex = new Map<string, number>();
  for (const [index, input] of inputs.entries()) {
    if (!input.ref) continue;
    if (refIndex.has(input.ref)) throw new Error(`Duplicate ref "${input.ref}" in this batch`);
    refIndex.set(input.ref, index);
  }

  // Everything is validated before any number is handed out. Ids are made here, so refs resolve up front.
  const ids = inputs.map(() => newId());
  const milestones = inputs.map((input) => {
    const key = keyOf("milestone", input.milestone);
    const milestone = key && ws.milestones.find(matches(key));
    if (!milestone) throw new NotFoundError(`Milestone ${input.milestone} not found (task "${input.title}")`);
    return milestone;
  });
  const deps = inputs.map((input) =>
    (input.depends_on ?? []).map((dep) => {
      const ref = refIndex.get(dep);
      if (ref !== undefined) return ids[ref];
      const key = keyOf("task", dep);
      const task = key && ws.tasks.find(matches(key));
      if (!task) throw new NotFoundError(`"${input.title}" depends on ${dep}, which is neither an existing task nor a ref in this batch`);
      return task.id;
    }),
  );
  for (const input of inputs) if (input.pert) pert(input.pert.optimistic, input.pert.likely, input.pert.pessimistic);
  // Existing tasks can't depend on new ones, so only the new tasks can form a cycle.
  const graph = new Map(ids.map((id, i) => [id, { depends_on: deps[i] }]));
  for (const [i, id] of ids.entries()) assertNoCycle(graph, id, inputs[i].ref ?? `"${inputs[i].title}"`);

  // Numbers per milestone, handed out in batch order.
  const repository = getRepository();
  const counts = new Map<string, number>();
  for (const m of milestones) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  const next = new Map<string, number>();
  for (const [milestoneId, count] of counts) next.set(milestoneId, await repository.allocateNumbers("tasks", milestoneId, count));

  const tasks = inputs.map((input, i): Task => {
    const milestone = milestones[i];
    const number = next.get(milestone.id)!;
    next.set(milestone.id, number + 1);
    const estimate = input.pert
      ? pert(input.pert.optimistic, input.pert.likely, input.pert.pessimistic)
      : { estimate: input.estimate, estimate_range: undefined };
    return {
      id: ids[i],
      code: taskCode(milestone.code, number),
      number,
      title: input.title,
      status: input.status ?? "todo",
      priority: input.priority,
      milestone: milestone.id,
      estimate: estimate.estimate,
      estimate_range: estimate.estimate_range,
      spent: 0,
      deadline: input.deadline,
      not_before: input.not_before,
      depends_on: deps[i],
      tags: input.tags ?? [],
      created: today,
      body: input.description ?? "",
    };
  });
  await repository.insert({ tasks });
  return tasks;
}

export async function updateTask(ref: string, patch: TaskPatch): Promise<Task> {
  const task = await getTask(ref);
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const next: Task = { ...task };

  if (patch.title !== undefined) next.title = patch.title;
  if (patch.priority !== undefined) next.priority = patch.priority ?? undefined;
  if (patch.pert) Object.assign(next, pert(patch.pert.optimistic, patch.pert.likely, patch.pert.pessimistic));
  else if (patch.estimate !== undefined) {
    next.estimate = patch.estimate;
    next.estimate_range = undefined;
  }
  if (patch.spent !== undefined) next.spent = patch.spent;
  if (patch.deadline !== undefined) next.deadline = patch.deadline ?? undefined;
  if (patch.not_before !== undefined) next.not_before = patch.not_before ?? undefined;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.order !== undefined) next.order = patch.order ?? undefined;
  if (patch.description !== undefined) next.body = patch.description;
  if (patch.append_note) next.body = withNote(next.body, `Note · ${today}`, patch.append_note);
  if (patch.status !== undefined && patch.status !== task.status) {
    next.status = patch.status;
    next.completed = patch.status === "done" ? today : undefined;
  }
  if (patch.depends_on !== undefined) {
    const ws = await loadWorkspace();
    next.depends_on = patch.depends_on.map((d) => resolve("task", ws.tasks, d).id);
    const graph = new Map<string, { depends_on: string[] }>(ws.tasks.map((t) => [t.id, t]));
    graph.set(next.id, next);
    assertNoCycle(graph, next.id, next.code);
  }
  // Last, once everything else is valid, so a rejected patch doesn't use up a number.
  let changes: Changes = { tasks: [next] };
  if (patch.milestone !== undefined) {
    const milestone = await getMilestone(patch.milestone);
    if (milestone.id !== task.milestone) {
      const ws = await loadWorkspace();
      const number = await getRepository().allocateNumbers("tasks", milestone.id, 1);
      Object.assign(next, { milestone: milestone.id, number, code: taskCode(milestone.code, number) });
      changes = withMentions(ws, changes, new Map([[task.code, next.code]]));
    }
  }

  await getRepository().save(changes);
  return changes.tasks!.find((t) => t.id === next.id)!;
}

export async function logTime(ref: string, hours: number, note?: string, done?: boolean): Promise<Task> {
  const task = await getTask(ref);
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const next: Task = { ...task, spent: Math.round((task.spent + hours) * 100) / 100 };
  if (done) {
    next.status = "done";
    next.completed = today;
  } else if (task.status === "todo") {
    next.status = "in_progress";
  }
  const line = `- ${today}: ${hours}h${note ? ` — ${note.trim()}` : ""}`;
  next.body = /^## Log$/m.test(next.body) ? `${next.body.trim()}\n${line}` : `${next.body.trim()}\n\n## Log\n\n${line}`.trim();
  await getRepository().save({ tasks: [next] });
  return next;
}

/** Give tasks an explicit order (0, 1, 2…) — the tie-breaker within a priority level. */
export async function reorderTasks(refs: string[]): Promise<Task[]> {
  const tasks = await Promise.all(refs.map((ref) => getTask(ref)));
  const updated = tasks.map((task, index) => ({ ...task, order: index }));
  await getRepository().save({ tasks: updated });
  return updated;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function createMilestone(input: NewMilestone): Promise<Milestone> {
  const settings = await getSettings();
  const project = await getProject(input.project);
  const repository = getRepository();
  const number = await repository.allocateNumbers("milestones", project.id, 1);
  const milestone: Milestone = {
    id: newId(),
    code: milestoneCode(project.code, number),
    number,
    title: input.title,
    status: input.status ?? "planned",
    project: project.id,
    priority: input.priority,
    deadline: input.deadline,
    created: todayIn(settings.timezone),
    last_task_number: 0,
    checks: {},
    deployments: {},
    body: input.description ?? "",
  };
  await repository.insert({ milestones: [milestone] });
  return milestone;
}

export async function updateMilestone(ref: string, patch: MilestonePatch): Promise<Milestone> {
  const milestone = await getMilestone(ref);
  const next: Milestone = { ...milestone };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.body = patch.description;
  if (patch.priority !== undefined) next.priority = patch.priority ?? undefined;
  if (patch.deadline !== undefined) next.deadline = patch.deadline ?? undefined;
  if (patch.status !== undefined) next.status = patch.status;
  let changes: Changes = { milestones: [next] };
  if (patch.project !== undefined) {
    const project = await getProject(patch.project);
    if (project.id !== milestone.project) {
      const ws = await loadWorkspace();
      const number = await getRepository().allocateNumbers("milestones", project.id, 1);
      Object.assign(next, { project: project.id, number, code: milestoneCode(project.code, number) });
      // Its tasks keep their numbers; only the prefix changes.
      const tasks = ws.tasks.filter((t) => t.milestone === milestone.id);
      changes.tasks = tasks.map((t) => ({ ...t, code: taskCode(next.code, t.number) }));
      const renames = new Map([[milestone.code, next.code], ...tasks.map((t, i): [string, string] => [t.code, changes.tasks![i].code])]);
      changes = withMentions(ws, changes, renames);
    }
  }
  await getRepository().save(changes);
  return changes.milestones!.find((m) => m.id === next.id)!;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function assertCodeFree(code: string) {
  const taken = await getRepository().getProject({ code });
  if (taken) throw new Error(`Project code ${code} is already used by "${taken.title}"`);
}

export async function createProject(input: NewProject): Promise<Project> {
  const settings = await getSettings();
  const code = ProjectCode.parse(input.code);
  await assertCodeFree(code);
  const project: Project = {
    id: newId(),
    code,
    title: input.title,
    status: input.status ?? "active",
    priority: input.priority ?? "P2",
    deadline: input.deadline,
    context: "personal",
    repos: [],
    detectors: [],
    created: todayIn(settings.timezone),
    last_milestone_number: 0,
    body: input.description ?? "",
  };
  await getRepository().insert({ projects: [project] });
  return project;
}

export async function updateProject(ref: string, patch: ProjectPatch): Promise<Project> {
  const project = await getProject(ref);
  const next: Project = { ...project };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.body = patch.description;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.deadline !== undefined) next.deadline = patch.deadline ?? undefined;
  if (patch.status !== undefined) next.status = patch.status;
  let changes: Changes = { projects: [next] };
  const code = patch.code === undefined ? undefined : ProjectCode.parse(patch.code);
  if (code !== undefined && code !== project.code) {
    await assertCodeFree(code);
    next.code = code;
    // Every code in the project follows, in the same write, and so do mentions of them in markdown.
    const ws = await loadWorkspace();
    const renames = new Map<string, string>();
    const milestones = ws.milestones.filter((m) => m.project === project.id);
    changes.milestones = milestones.map((m) => ({ ...m, code: milestoneCode(code, m.number) }));
    milestones.forEach((m, i) => renames.set(m.code, changes.milestones![i].code));
    const recoded = new Map(changes.milestones.map((m) => [m.id, m.code]));
    const tasks = ws.tasks.filter((t) => recoded.has(t.milestone));
    changes.tasks = tasks.map((t) => ({ ...t, code: taskCode(recoded.get(t.milestone)!, t.number) }));
    tasks.forEach((t, i) => renames.set(t.code, changes.tasks![i].code));
    changes = withMentions(ws, changes, renames);
  }
  await getRepository().save(changes);
  return changes.projects!.find((p) => p.id === next.id)!;
}

// ---------------------------------------------------------------------------
// Users (password hashing lives in src/lib/auth; never log password_hash)
// ---------------------------------------------------------------------------

/** Trimmed and lowercased: the form every email is stored and looked up in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A simple `local@domain.tld` check (at most 254 chars, no spaces). Checks the email as given, so normalize first. */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

export async function findUserByEmail(email: string): Promise<User | null> {
  return getRepository().findUserByEmail(normalizeEmail(email));
}

/** The user, or null when there's no such id (e.g. a session outliving its account). */
export async function getUser(id: string): Promise<User | null> {
  return getRepository().getUser(normalizeId(id, "U"));
}

export async function countUsers(): Promise<number> {
  return getRepository().countUsers();
}

/** Stores a new account; `password_hash` must already be hashed. Returns null when the email is taken. */
export async function createUser(input: { email: string; password_hash: string }): Promise<User | null> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error("Invalid email address");
  if (!input.password_hash) throw new Error("password_hash is required");
  const repository = getRepository();
  // Checked first so a duplicate doesn't use up an id; the backend still enforces uniqueness.
  if (await repository.findUserByEmail(email)) return null;
  const settings = await getSettings(repository);
  return repository.insertUser({ email, password_hash: input.password_hash, created: todayIn(settings.timezone) });
}

// ---------------------------------------------------------------------------
// API keys (generation, hashing and verification live in src/lib/auth/api-keys.ts;
// only hashes reach the repository, and neither raw keys nor hashes are ever logged)
// ---------------------------------------------------------------------------

const API_KEY_HASH = /^[0-9a-f]{64}$/;
const API_KEY_ID = /^K-\d+$/;

/** The key id in its `K-n` form, or null for anything else (so no lookup is made for junk ids). */
function apiKeyId(id: string): string | null {
  const keyId = normalizeId(id, "K");
  return API_KEY_ID.test(keyId) ? keyId : null;
}

/** Stores a new key by its hash (lowercase hex SHA-256, see hashApiKey); the raw key is never passed here. */
export async function createApiKey(input: { label?: string; hash: string; user_id?: string }): Promise<ApiKey> {
  if (!API_KEY_HASH.test(input.hash)) throw new Error("hash must be a lowercase hex SHA-256");
  const repository = getRepository();
  const settings = await getSettings(repository);
  const draft = { label: (input.label ?? "").trim(), hash: input.hash, created: todayIn(settings.timezone) };
  return repository.insertApiKey(input.user_id ? { ...draft, user_id: normalizeId(input.user_id, "U") } : draft);
}

/** Exact hash match, revoked keys included (verifyApiKey rejects those). */
export async function findApiKeyByHash(hash: string): Promise<ApiKey | null> {
  if (!API_KEY_HASH.test(hash)) return null;
  return getRepository().findApiKeyByHash(hash);
}

/** Every key, revoked ones included, by id number. */
export async function listApiKeys(): Promise<ApiKey[]> {
  return getRepository().listApiKeys();
}

/** The keys an account created in the web UI, revoked ones included, by id number. */
export async function listUserApiKeys(userId: string): Promise<ApiKey[]> {
  const owner = normalizeId(userId, "U");
  return (await listApiKeys()).filter((key) => key.user_id === owner);
}

/** The key, or null when there's no such id. */
export async function getApiKey(id: string): Promise<ApiKey | null> {
  const keyId = apiKeyId(id);
  return keyId ? getRepository().getApiKey(keyId) : null;
}

/** Sets `revoked_at` (soft delete). Idempotent: an already-revoked key comes back unchanged; null for an unknown id. */
export async function revokeApiKey(id: string, at: Date = new Date()): Promise<ApiKey | null> {
  const key = await getApiKey(id);
  if (!key || key.revoked_at) return key;
  const next: ApiKey = { ...key, revoked_at: at.toISOString() };
  await getRepository().saveApiKey(next);
  return next;
}

/**
 * Records a use of the key: only `last_used_at` is written, so it never undoes a concurrent revoke (the
 * returned key then carries `revoked_at`). Null for an unknown id.
 */
export async function touchApiKey(id: string, at: Date = new Date()): Promise<ApiKey | null> {
  const keyId = apiKeyId(id);
  return keyId ? getRepository().touchApiKey(keyId, at.toISOString()) : null;
}
