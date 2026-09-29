import { parseMarkdown, toMarkdown } from "./markdown";
import { MilestonePatch, ProjectCode, ProjectPatch, resolve, TaskPatch, type Workspace } from "./repo";
import {
  DATE,
  MILESTONE_STATUSES,
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  type Milestone,
  type Project,
  type Task,
} from "./types";

/**
 * A project, milestone or task as editable markdown: its editable fields as YAML frontmatter, its description (or
 * spec) as the body. References are shown and read back as codes (PMA-M1, PMA-M1-T3); the patch holds ids.
 * Pure: the caller loads the workspace and applies the patch with updateTask / updateMilestone / updateProject.
 *
 * toEditable is deterministic, so re-serializing a record and comparing it with the text an editor opened with
 * detects a stale edit.
 */

export type RecordKind = "task" | "milestone" | "project";

interface Records {
  task: Task;
  milestone: Milestone;
  project: Project;
}
interface Patches {
  task: TaskPatch;
  milestone: MilestonePatch;
  project: ProjectPatch;
}

export type EditResult<K extends RecordKind> = { ok: true; patch: Patches[K] } | { ok: false; errors: string[] };

type Ws = Pick<Workspace, "tasks" | "milestones" | "projects">;

/** Frontmatter keys in schema order (see src/lib/types.ts). */
export const EDITABLE_KEYS: Record<RecordKind, readonly string[]> = {
  task: ["title", "status", "priority", "milestone", "estimate", "deadline", "not_before", "depends_on", "tags", "prs"],
  milestone: ["title", "status", "project", "priority", "deadline"],
  project: ["code", "title", "status", "priority", "deadline"],
};

const READ_ONLY: Record<RecordKind, readonly string[]> = {
  task: ["id", "code", "number", "estimate_range", "pert", "spent", "order", "created", "completed", "log"],
  milestone: ["id", "code", "number", "created", "last_task_number"],
  project: ["id", "created", "last_milestone_number"],
};

const BODY_NAME: Record<RecordKind, string> = { task: "description", milestone: "spec", project: "description" };

/** A dangling reference keeps its id, so it survives a round trip instead of turning into an error. */
const codeOf = (list: { id: string; code: string }[], id: string) => list.find((x) => x.id === id)?.code ?? id;

export function toEditable<K extends RecordKind>(kind: K, record: Records[K], ws: Ws): string {
  return toMarkdown(editableFields(kind, record, ws), record.body);
}

function editableFields(kind: RecordKind, record: Task | Milestone | Project, ws: Ws): Record<string, unknown> {
  if (kind === "task") {
    const t = record as Task;
    return {
      title: t.title,
      status: t.status,
      priority: t.priority,
      milestone: codeOf(ws.milestones, t.milestone),
      estimate: t.estimate,
      deadline: t.deadline,
      not_before: t.not_before,
      depends_on: t.depends_on.map((id) => codeOf(ws.tasks, id)),
      tags: t.tags,
      prs: t.prs,
    };
  }
  if (kind === "milestone") {
    const m = record as Milestone;
    return { title: m.title, status: m.status, project: codeOf(ws.projects, m.project), priority: m.priority, deadline: m.deadline };
  }
  const p = record as Project;
  return { code: p.code, title: p.title, status: p.status, priority: p.priority, deadline: p.deadline };
}

/**
 * The fields of `text` that differ from `record`, as a patch for updateTask / updateMilestone / updateProject
 * (an empty patch means no changes), or every problem found. Removing a key clears a nullable field (priority →
 * inherit, deadline, not_before) or empties a list; removing a required one (title, status, milestone, project,
 * a project's code or priority) is an error, and so is removing an estimate, which a patch can't clear. A changed
 * estimate replaces a three-point range; an unchanged one leaves it alone.
 */
export function fromEditable<K extends RecordKind>(kind: K, text: string, record: Records[K], ws: Ws): EditResult<K> {
  const parsed = parse(text);
  if ("error" in parsed) return { ok: false, errors: [parsed.error] };
  const { data, body } = parsed;
  const errors: string[] = [];
  for (const key of Object.keys(data)) {
    if (EDITABLE_KEYS[kind].includes(key)) continue;
    if (READ_ONLY[kind].includes(key)) errors.push(`"${key}" can't be edited here`);
    else if (key === "description" || key === "spec" || key === "body") {
      errors.push(`"${key}": the ${BODY_NAME[kind]} goes below the frontmatter, as the markdown body`);
    } else errors.push(`Unknown field "${key}" (fields: ${EDITABLE_KEYS[kind].join(", ")})`);
  }
  const read = reader(data, errors);
  const patch: Record<string, unknown> = {};

  const title = read.text("title", true);
  if (title && title !== record.title.trim()) patch.title = title;
  if (body !== record.body.trim()) patch.description = body;

  if (kind === "task") {
    const t = record as Task;
    const status = read.choice("status", TASK_STATUSES, true);
    if (status && status !== t.status) patch.status = status;
    nullable(patch, "priority", read.choice("priority", PRIORITIES), t.priority);
    const milestone = read.ref("milestone", ws.milestones);
    if (milestone && milestone.id !== t.milestone) patch.milestone = milestone.id;
    const estimate = read.number("estimate");
    if (estimate === null && t.estimate !== undefined) errors.push(`"estimate" can't be removed; set it to a number of hours`);
    else if (estimate !== undefined && estimate !== null && estimate !== t.estimate) patch.estimate = estimate;
    nullable(patch, "deadline", read.date("deadline"), t.deadline);
    nullable(patch, "not_before", read.date("not_before"), t.not_before);
    const depends = dependencies(read.list("depends_on"), t, ws, errors);
    if (depends && !sameList(depends, t.depends_on)) patch.depends_on = depends;
    const tags = read.list("tags");
    if (tags && !sameList(tags, t.tags)) patch.tags = tags;
    const prs = read.list("prs");
    if (prs && !sameList(prs, t.prs)) patch.prs = prs;
  } else if (kind === "milestone") {
    const m = record as Milestone;
    const status = read.choice("status", MILESTONE_STATUSES, true);
    if (status && status !== m.status) patch.status = status;
    const project = read.ref("project", ws.projects);
    if (project && project.id !== m.project) patch.project = project.id;
    nullable(patch, "priority", read.choice("priority", PRIORITIES), m.priority);
    nullable(patch, "deadline", read.date("deadline"), m.deadline);
  } else {
    const p = record as Project;
    const code = read.text("code", true);
    if (code) {
      const checked = ProjectCode.safeParse(code);
      if (!checked.success) errors.push(`"code": ${checked.error.issues[0].message}`);
      else if (checked.data !== p.code) {
        const taken = ws.projects.find((x) => x.code === checked.data && x.id !== p.id);
        if (taken) errors.push(`"code": ${checked.data} is already used by "${taken.title}"`);
        else patch.code = checked.data;
      }
    }
    const status = read.choice("status", PROJECT_STATUSES, true);
    if (status && status !== p.status) patch.status = status;
    // Projects always have a priority (their milestones and tasks inherit it), so removing it is an error.
    if (absent(data.priority)) errors.push(`"priority" can't be removed from a project; its milestones and tasks inherit it (one of: ${PRIORITIES.join(", ")})`);
    const priority = read.choice("priority", PRIORITIES);
    if (priority && priority !== p.priority) patch.priority = priority;
    nullable(patch, "deadline", read.date("deadline"), p.deadline);
  }

  if (errors.length) return { ok: false, errors };
  const schema = kind === "task" ? TaskPatch : kind === "milestone" ? MilestonePatch : ProjectPatch;
  const checked = schema.safeParse(patch);
  if (!checked.success) return { ok: false, errors: checked.error.issues.map((i) => `"${i.path.join(".")}": ${i.message}`) };
  return { ok: true, patch: checked.data as Patches[K] };
}

function parse(text: string): { data: Record<string, unknown>; body: string } | { error: string } {
  // Browsers submit textareas with CRLF line breaks; a body that differs only in those isn't an edit.
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trimStart();
  if (!/^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized)) return { error: "The text must start with frontmatter: fields between two --- lines" };
  let parsed: ReturnType<typeof parseMarkdown>;
  try {
    parsed = parseMarkdown(normalized);
  } catch (error) {
    return { error: `The frontmatter isn't valid YAML: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/:$/, "")}` };
  }
  if (typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return { error: "The frontmatter must be a list of `key: value` fields" };
  }
  return parsed;
}

/** A nullable field: null (key removed or left empty) clears it, a value sets it. */
function nullable(patch: Record<string, unknown>, key: string, value: string | null | undefined, current: string | undefined) {
  if (value !== undefined && (value ?? undefined) !== current) patch[key] = value;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const absent = (value: unknown) => value === undefined || value === null || value === "";
const scalar = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined);
const shown = (value: unknown) => JSON.stringify(value);

function isDate(value: string) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Field readers. Each returns the value, null when the key is missing or empty, or undefined when it's invalid
 * (after recording why). A required field reports its absence and returns undefined.
 */
function reader(data: Record<string, unknown>, errors: string[]) {
  const missing = (key: string, required: boolean, hint = "") => {
    if (!required) return null;
    errors.push(`"${key}" is required${hint}`);
    return undefined;
  };
  return {
    text(key: string, required = false): string | null | undefined {
      if (absent(data[key])) return missing(key, required, " and can't be empty");
      const value = scalar(data[key]);
      if (value === undefined) errors.push(`"${key}" must be text, got ${shown(data[key])}`);
      else if (!value) return missing(key, required, " and can't be empty");
      return value;
    },
    choice<T extends string>(key: string, values: readonly T[], required = false): T | null | undefined {
      const allowed = ` (one of: ${values.join(", ")})`;
      if (absent(data[key])) return missing(key, required, allowed);
      const value = scalar(data[key]);
      const match = values.find((v) => v.toLowerCase() === value?.toLowerCase());
      if (!match) errors.push(`"${key}" must be one of: ${values.join(", ")}; got ${shown(data[key])}`);
      return match;
    },
    number(key: string): number | null | undefined {
      if (absent(data[key])) return null;
      const value = data[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      errors.push(`"${key}" must be a number of hours (0 or more), got ${shown(value)}`);
      return undefined;
    },
    date(key: string): string | null | undefined {
      if (absent(data[key])) return null;
      const value = scalar(data[key]);
      if (value && isDate(value)) return value;
      errors.push(`"${key}" must be a date like 2026-10-31 (YYYY-MM-DD), got ${shown(data[key])}`);
      return undefined;
    },
    /** A YAML list, or a comma-separated string (`tags: api, backend`). Missing → empty. */
    list(key: string): string[] | undefined {
      const value = data[key];
      if (absent(value)) return [];
      const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [value];
      const out: string[] = [];
      for (const item of items) {
        const s = scalar(item);
        if (s === undefined) {
          errors.push(`"${key}" must be a list like [a, b], got ${shown(value)}`);
          return undefined;
        }
        if (s) out.push(s);
      }
      return out;
    },
    /** A required parent, by code (or id). */
    ref<T extends { id: string; code: string }>(key: "milestone" | "project", list: T[]): T | undefined {
      const example = key === "milestone" ? "PMA-M1" : "PMA";
      if (absent(data[key])) return missing(key, true, ` (a ${key} code like ${example})`) ?? undefined;
      const value = scalar(data[key]);
      if (value === undefined) {
        errors.push(`"${key}" must be a ${key} code like ${example}, got ${shown(data[key])}`);
        return undefined;
      }
      try {
        return resolve(key, list, value);
      } catch (error) {
        errors.push(`"${key}": ${(error as Error).message}`);
        return undefined;
      }
    },
  };
}

/** Dependency codes → ids, rejecting unknown tasks and cycles. Dangling ids already on the task are kept. */
function dependencies(refs: string[] | undefined, task: Task, ws: Ws, errors: string[]): string[] | undefined {
  if (!refs) return undefined;
  const byId = new Map(ws.tasks.map((t) => [t.id, t]));
  const ids: string[] = [];
  let valid = true;
  for (const ref of refs) {
    let id: string;
    if (task.depends_on.includes(ref.toLowerCase()) && !byId.has(ref.toLowerCase())) id = ref.toLowerCase();
    else {
      try {
        id = resolve("task", ws.tasks, ref).id;
      } catch (error) {
        errors.push(`"depends_on": ${(error as Error).message}`);
        valid = false;
        continue;
      }
    }
    if (id === task.id) {
      errors.push(`"depends_on": ${task.code} can't depend on itself`);
      valid = false;
    } else if (reaches(byId, id, task.id)) {
      errors.push(`"depends_on": dependency cycle, ${codeOf(ws.tasks, id)} already depends on ${task.code}`);
      valid = false;
    } else if (!ids.includes(id)) ids.push(id);
  }
  return valid ? ids : undefined;
}

/** Whether `from` depends on `target`, directly or through other tasks. */
function reaches(tasks: Map<string, { depends_on: string[] }>, from: string, target: string) {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks.get(id)?.depends_on ?? []));
  }
  return false;
}
