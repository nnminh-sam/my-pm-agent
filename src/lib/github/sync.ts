/**
 * The snapshot pull path, pure: whether to call GitHub for a key, how a fetch result updates its snapshot, and the
 * sync status every GitHub-backed view shows (the badge, get_task). No I/O; the orchestration is in ./pull.ts.
 */
import { z } from "zod";
import { GITHUB_SNAPSHOT_KEY, PR_REF, type GithubSnapshot } from "../types";
import { GITHUB_ERROR_REASONS, PrOverview, RepoPrItem, type GithubError, type GithubResult } from "./overview";

/** A snapshot fetched this recently is served without calling GitHub (unless forced, as by Retry now). */
export const FRESH_MS = 60_000;

// ---- repos and keys: the one place `github.com/owner/repo` (projects.repos) meets `owner/repo` (GitHub, PR refs) ----

const GITHUB_REMOTE = "github.com/";

/**
 * `owner/repo` in normalized (lowercase) form from either a project remote (`github.com/owner/repo`) or `owner/repo`;
 * null for another host or anything that isn't a repo (`.` / `..` segments included).
 */
export function toGithubRepo(input: string): string | null {
  const lower = input.trim().toLowerCase();
  const repo = lower.startsWith(GITHUB_REMOTE) ? lower.slice(GITHUB_REMOTE.length) : lower;
  const name = repo.split("/")[1];
  if (!GITHUB_SNAPSHOT_KEY.test(`repo:${repo}`) || name === "." || name === "..") return null;
  return repo;
}

/** The remote a project stores for a repo: `owner/repo` → `github.com/owner/repo`. */
export const githubRemote = (repo: string) => `${GITHUB_REMOTE}${repo}`;

/** `owner/repo#123` → its parts; null for anything else. */
export function parsePrRef(ref: string): { repo: string; number: number } | null {
  if (!PR_REF.test(ref)) return null;
  const i = ref.lastIndexOf("#");
  const repo = toGithubRepo(ref.slice(0, i));
  const number = Number(ref.slice(i + 1));
  return repo && Number.isSafeInteger(number) ? { repo, number } : null;
}

export const prKey = (ref: string) => `pr:${ref}`;
export const repoKey = (repo: string) => `repo:${repo}`;

// ---- the decision ----

export type PullReason =
  /** Served: fetched under FRESH_MS ago. */
  | "fresh"
  /** Served: GitHub asked us to wait (a rate limit); even Retry now waits. */
  | "retry_after"
  /** Fetch: nothing fetched yet (no snapshot, or only failed attempts). */
  | "never_fetched"
  /** Fetch: the last fetch is FRESH_MS old or more. */
  | "stale"
  /** Fetch: fresh, but forced (Retry now). */
  | "forced";

export interface PullDecision {
  action: "serve" | "fetch";
  reason: PullReason;
}

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Serve or fetch, in order:
 * 1. `retry_after` in the future: serve, even when forced;
 * 2. fetched under FRESH_MS ago: serve, unless forced;
 * 3. otherwise fetch.
 */
export function decidePull(snapshot: GithubSnapshot | null, now: Date, options: { force?: boolean } = {}): PullDecision {
  const t = now.getTime();
  if (time(snapshot?.retry_after) > t) return { action: "serve", reason: "retry_after" };
  const fetchedAt = time(snapshot?.fetched_at);
  if (Number.isNaN(fetchedAt)) return { action: "fetch", reason: "never_fetched" };
  if (t - fetchedAt < FRESH_MS) return options.force ? { action: "fetch", reason: "forced" } : { action: "serve", reason: "fresh" };
  return { action: "fetch", reason: "stale" };
}

// ---- applying a fetch ----

/** What `last_error` holds: the GithubError minus retry_after (the snapshot's own column). */
export type StoredGithubError = Omit<GithubError, "retry_after">;

const withoutUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The columns a failed fetch writes (Repository.recordGithubFailure), and nothing else: `data` and `fetched_at` are
 * never part of a failure, so a failure can't undo a webhook write that landed while the fetch was in flight.
 * `retry_after` null clears an older one.
 */
export interface GithubFailure {
  last_attempt_at: string;
  last_error: StoredGithubError;
  retry_after: string | null;
}

export function failureOf(error: GithubError, now: Date): GithubFailure {
  const { retry_after, ...last_error } = error;
  return { last_attempt_at: now.toISOString(), last_error, retry_after: retry_after ?? null };
}

/** A snapshot with a failure's columns applied: what recordGithubFailure stores (none yet: a row without data). */
export function withFailure(key: string, snapshot: GithubSnapshot | null, failure: GithubFailure): GithubSnapshot {
  return withoutUndefined({
    key,
    data: snapshot?.data,
    fetched_at: snapshot?.fetched_at,
    last_attempt_at: failure.last_attempt_at,
    last_error: failure.last_error,
    retry_after: failure.retry_after ?? undefined,
  });
}

/**
 * The snapshot after a fetch attempt at `now`:
 * - success: the new data, `fetched_at` and `last_attempt_at` set, `last_error` and `retry_after` cleared;
 * - failure: `data` and `fetched_at` kept (a failed fetch never overwrites a good snapshot), `last_attempt_at`,
 *   `last_error` and `retry_after` (GitHub's reset time, or none) set.
 */
export function applyFetchResult(
  key: string,
  snapshot: GithubSnapshot | null,
  result: GithubResult<PrOverview | RepoPrItem[]>,
  now: Date,
): GithubSnapshot {
  const at = now.toISOString();
  if (result.ok) return { key, data: result.data, fetched_at: at, last_attempt_at: at };
  return withFailure(key, snapshot, failureOf(result.error, now));
}

// ---- reading a snapshot ----

/** Lenient, so an odd stored error still shows something rather than breaking a view. */
const StoredError = z.object({
  reason: z.enum(GITHUB_ERROR_REASONS).catch("github_down"),
  status: z.number().int().nullable().catch(null),
  message: z.string().catch(""),
  request_id: z.string().nullable().catch(null),
});

/** The stored `last_error`, typed; null when the last attempt succeeded. */
export function snapshotError(snapshot: GithubSnapshot | null): StoredGithubError | null {
  return snapshot?.last_error ? StoredError.parse(snapshot.last_error) : null;
}

/** A PR snapshot's overview; null when there's none (never fetched) or it doesn't parse. */
export function prOverviewOf(snapshot: GithubSnapshot | null): PrOverview | null {
  const parsed = PrOverview.safeParse(snapshot?.data);
  return parsed.success ? parsed.data : null;
}

/** A repo snapshot's open PRs; null when there's none (never fetched) or it doesn't parse. */
export function repoPrsOf(snapshot: GithubSnapshot | null): RepoPrItem[] | null {
  const parsed = z.array(RepoPrItem).safeParse(snapshot?.data);
  return parsed.success ? parsed.data : null;
}

export const SYNC_STATES = ["synced", "out_of_sync", "never"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** The sync status of a snapshot: the single source for the badge (T9) and get_task (T8). */
export interface SyncStatus {
  /** synced: data, last attempt succeeded; out_of_sync: data, last attempt failed; never: no data yet. */
  sync: SyncState;
  /** When the data shown was fetched; null when never synced. */
  fetched_at: string | null;
  last_attempt_at: string | null;
  /** Why the last attempt failed; null when it succeeded or none was made. */
  reason: GithubError["reason"] | null;
  error: StoredGithubError | null;
  /** No GitHub call (Retry now included) before then. */
  retry_after: string | null;
}

/** A snapshot row can exist with no data (the first fetch failed): that is "never". */
export function syncStatus(snapshot: GithubSnapshot | null): SyncStatus {
  const error = snapshot?.last_error ? snapshotError(snapshot) : null;
  const hasData = snapshot?.data !== undefined && snapshot.fetched_at !== undefined;
  return {
    sync: !hasData ? "never" : error ? "out_of_sync" : "synced",
    fetched_at: hasData ? snapshot.fetched_at! : null,
    last_attempt_at: snapshot?.last_attempt_at ?? null,
    reason: error?.reason ?? null,
    error,
    retry_after: snapshot?.retry_after ?? null,
  };
}
