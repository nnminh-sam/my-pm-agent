import { z } from "zod";
import { MILESTONE_CODE, PROJECT_CODE, TASK_CODE } from "./codes";

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const dateStr = z.string().regex(DATE, "expected YYYY-MM-DD");

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export const MILESTONE_STATUSES = ["idea", "planned", "in_progress", "done", "cancelled"] as const;
export const PROJECT_STATUSES = ["planned", "active", "on_hold", "done", "cancelled"] as const;
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const TaskStatus = z.enum(TASK_STATUSES);
export const MilestoneStatus = z.enum(MILESTONE_STATUSES);
export const ProjectStatus = z.enum(PROJECT_STATUSES);
export const Priority = z.enum(PRIORITIES);

export type TaskStatus = z.infer<typeof TaskStatus>;
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;
export type ProjectStatus = z.infer<typeof ProjectStatus>;
export type Priority = z.infer<typeof Priority>;

/** Opaque primary key (UUID v7); references between records use it, so they survive code changes. */
const id = z.uuid();
/** Position within the parent, from its counter: never reused, even after an item moves away. */
const number = z.number().int().positive();
const counter = z.number().int().nonnegative().default(0);

/**
 * Frontmatter of a task markdown file (`tasks/<id>.md`). The markdown body holds the description.
 * Ids and codes: see src/lib/codes.ts.
 */
export const TaskMeta = z.object({
  id,
  /** The milestone's code plus this task's number, e.g. PMA-M1-T3. Kept in step by repo.ts. */
  code: z.string().regex(TASK_CODE, "expected a task code like PMA-M1-T3"),
  number,
  title: z.string(),
  status: TaskStatus.default("todo"),
  /** Falls back to the milestone's priority, then the project's, then P2. */
  priority: Priority.optional(),
  milestone: id,
  /** Expected effort in hours (PERT mean when a range is given). */
  estimate: z.number().nonnegative().optional(),
  /** [optimistic, pessimistic] hours from a three-point estimate. */
  estimate_range: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
  /** Hours already worked. */
  spent: z.number().nonnegative().default(0),
  deadline: dateStr.optional(),
  /** Don't schedule before this date. */
  not_before: dateStr.optional(),
  /** Task ids. */
  depends_on: z.array(id).default([]),
  tags: z.array(z.string()).default([]),
  /** Manual rank within the same priority: lower goes first. */
  order: z.number().optional(),
  created: dateStr,
  completed: dateStr.optional(),
});
export type TaskMeta = z.infer<typeof TaskMeta>;
export type Task = TaskMeta & { body: string };

/** Frontmatter of a milestone markdown file (`milestones/<id>.md`). The body holds the spec. */
export const MilestoneMeta = z.object({
  id,
  /** The project's code plus this milestone's number, e.g. PMA-M1. Kept in step by repo.ts. */
  code: z.string().regex(MILESTONE_CODE, "expected a milestone code like PMA-M1"),
  number,
  title: z.string(),
  status: MilestoneStatus.default("planned"),
  project: id,
  /** Falls back to the project's priority, then P2. */
  priority: Priority.optional(),
  deadline: dateStr.optional(),
  created: dateStr,
  /** The highest task number handed out; only the repository's allocateNumbers moves it. */
  last_task_number: counter,
});
export type MilestoneMeta = z.infer<typeof MilestoneMeta>;
export type Milestone = MilestoneMeta & { body: string };

/**
 * Frontmatter of a project markdown file (`projects/<id>.md`). The body holds goals and context.
 * Projects group milestones; tasks belong to a project through their milestone.
 */
export const ProjectMeta = z.object({
  id,
  /** Chosen, unique, 2–6 characters (e.g. PMA); prefixes every milestone and task code in the project. */
  code: z.string().regex(PROJECT_CODE, "expected 2–6 uppercase letters or digits, starting with a letter"),
  title: z.string(),
  /** on_hold / done / cancelled projects keep their tasks off the schedule. */
  status: ProjectStatus.default("active"),
  priority: Priority.default("P2"),
  deadline: dateStr.optional(),
  created: dateStr,
  /** The highest milestone number handed out; only the repository's allocateNumbers moves it. */
  last_milestone_number: counter,
});
export type ProjectMeta = z.infer<typeof ProjectMeta>;
export type Project = ProjectMeta & { body: string };

/**
 * An account (`users/U-1.md`, frontmatter only; `users` table in Postgres).
 * Users are not part of the workspace: loadAll, import/export and backend comparison leave them out.
 */
export const UserMeta = z.object({
  id: z.string().regex(/^U-\d+$/, "expected U-n"),
  /** Normalized: trimmed and lowercased (see normalizeEmail in repo.ts). */
  email: z.string(),
  password_hash: z.string(),
  created: dateStr,
});
export type UserMeta = z.infer<typeof UserMeta>;
export type User = UserMeta;

/** UTC ISO 8601 instant, e.g. `2026-09-27T02:00:00.000Z` (`new Date().toISOString()`). */
export const datetimeStr = z.iso.datetime();

/**
 * An agent API key (`api_keys/K-1.md`, frontmatter only; `api_keys` table in Postgres). Only the hash is
 * stored; the raw key is shown once at issuance (see src/lib/auth/api-keys.ts). Like users, API keys are
 * not part of the workspace: loadAll, import/export and backend comparison leave them out.
 */
export const ApiKeyMeta = z.object({
  id: z.string().regex(/^K-\d+$/, "expected K-n"),
  /** Free-form note for the owner (e.g. "claude-code laptop"); may be empty. */
  label: z.string().default(""),
  /** The account that created the key in the web UI; absent for keys issued with `npm run auth:create-key`. */
  user_id: z.string().regex(/^U-\d+$/, "expected U-n").optional(),
  /** Lowercase hex SHA-256 of the raw key. */
  hash: z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase hex SHA-256"),
  created: dateStr,
  last_used_at: datetimeStr.optional(),
  /** Set once the key is revoked; revoked keys are kept (soft delete) but never authenticate. */
  revoked_at: datetimeStr.optional(),
});
export type ApiKeyMeta = z.infer<typeof ApiKeyMeta>;
export type ApiKey = ApiKeyMeta;

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const interval = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "expected HH:MM-HH:MM");

export const Settings = z.object({
  timezone: z.string().default("UTC"),
  /** Focus-time intervals per weekday, e.g. mon: ["09:00-12:00", "13:30-17:30"]. */
  work_hours: z.partialRecord(z.enum(WEEKDAYS), z.array(interval)).default({
    mon: ["09:00-12:00", "13:00-17:00"],
    tue: ["09:00-12:00", "13:00-17:00"],
    wed: ["09:00-12:00", "13:00-17:00"],
    thu: ["09:00-12:00", "13:00-17:00"],
    fri: ["09:00-12:00", "13:00-17:00"],
  }),
  days_off: z.array(dateStr).default([]),
  /** Replace the working intervals for a specific date (e.g. a meeting-heavy day). */
  overrides: z.record(z.string().regex(DATE), z.array(interval)).default({}),
  /** Multiplier applied to estimates when scheduling (use the calibration factor from estimation stats). */
  buffer: z.number().positive().default(1),
  /** Don't create schedule blocks shorter than this many hours. */
  min_block_hours: z.number().positive().default(0.5),
  /** Tasks larger than this should be broken down further. */
  max_task_hours: z.number().positive().default(8),
  horizon_days: z.number().int().positive().default(90),
});
export type Settings = z.infer<typeof Settings>;

/** Partial settings without defaults, so a patch never resets fields it doesn't mention. */
export const SettingsPatch = z.object({
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown IANA timezone")
    .optional(),
  work_hours: z.partialRecord(z.enum(WEEKDAYS), z.array(interval)).optional(),
  days_off: z.array(dateStr).optional(),
  overrides: z.record(z.string().regex(DATE), z.array(interval)).optional(),
  buffer: z.number().positive().optional(),
  min_block_hours: z.number().positive().optional(),
  max_task_hours: z.number().positive().optional(),
  horizon_days: z.number().int().positive().max(365).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
