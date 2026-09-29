/**
 * The sync badge's view model, pure: a sync status (plus read-time refusal) in, label / tone / reason text / whether
 * Retry now is allowed out. Everything here is deterministic given `now`, so the server and the client render the same.
 */
import { GITHUB_SNAPSHOT_KEY } from "../types";
import type { SyncState, SyncStatus } from "./sync";

/** Why a view shows nothing from GitHub although no call failed: see Refused in ./pull.ts. */
export type SyncRefusal = "invalid" | "not_linked" | "company";

/** A sync status the browser may hold: SyncStatus (already redacted, JSON-safe) plus an optional refusal. */
export interface BadgeSync extends SyncStatus {
  refusal?: SyncRefusal;
}

export type BadgeTone = "quiet" | "warn" | "danger";

export interface BadgeView {
  state: SyncState;
  tone: BadgeTone;
  /** The badge text, e.g. "synced 2m ago", "Out of sync · last synced 14m ago", "Never synced". */
  label: string;
  /** Whether the badge opens a details panel (everything but a quiet "synced"). */
  hasDetails: boolean;
  /** The reason in UI wording; null when synced. */
  reason: string | null;
  /** "HTTP 403 · GitHub's message" pieces, only what exists. */
  status: number | null;
  message: string | null;
  requestId: string | null;
  lastAttempt: string | null;
  retryAfter: string | null;
  /** Retry now: false for a refusal, or while `retry_after` is in the future. */
  canRetry: boolean;
  /** Why Retry now is disabled, when it is because of a rate limit. */
  retryBlocked: string | null;
}

const REASON_TEXT = {
  github_down: "GitHub is unavailable",
  timeout: "GitHub didn't respond in time",
  bad_token: "Token invalid or expired",
  no_access: "Repo renamed, deleted or not granted to the token",
} as const;

const REFUSAL_TEXT: Record<SyncRefusal, string> = {
  invalid: "Not a GitHub pull request or repo",
  not_linked: "Repo isn't linked to this project",
  company: "Company projects don't read GitHub",
};

/** `2026-09-29 14:05 UTC`: fixed zone and format, so server and client agree. */
export function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `just now`, `2m ago`, `3h ago`, `4d ago`; a future or unparseable time reads as `just now` / as given. */
export function relativeTime(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const minutes = Math.floor((now.getTime() - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const isFuture = (iso: string | null, now: Date) => iso !== null && Date.parse(iso) > now.getTime();

/** The reason line for a sync status; null when the last attempt didn't fail (and nothing was refused). */
export function reasonText(sync: BadgeSync): string | null {
  if (sync.refusal) return REFUSAL_TEXT[sync.refusal];
  switch (sync.reason) {
    case null:
      return null;
    case "rate_limited":
      return sync.retry_after ? `Rate-limited until ${formatWhen(sync.retry_after)}` : "Rate-limited";
    default:
      return REASON_TEXT[sync.reason];
  }
}

export function badgeView(sync: BadgeSync, now: Date): BadgeView {
  const reason = reasonText(sync);
  const blocked = !sync.refusal && isFuture(sync.retry_after, now);
  const lastSynced = sync.fetched_at ? relativeTime(sync.fetched_at, now) : null;
  const label =
    sync.sync === "synced"
      ? `synced ${lastSynced}`
      : sync.sync === "out_of_sync"
        ? `Out of sync · last synced ${lastSynced}`
        : "Never synced";
  return {
    state: sync.sync,
    tone: sync.sync === "synced" ? "quiet" : sync.sync === "out_of_sync" ? "warn" : "danger",
    label,
    hasDetails: sync.sync !== "synced",
    reason,
    status: sync.error?.status ?? null,
    message: sync.error?.message || null,
    requestId: sync.error?.request_id ?? null,
    lastAttempt: sync.last_attempt_at ? formatWhen(sync.last_attempt_at) : null,
    retryAfter: sync.retry_after ? formatWhen(sync.retry_after) : null,
    canRetry: !sync.refusal && !blocked,
    retryBlocked: blocked && sync.retry_after ? `Rate-limited until ${formatWhen(sync.retry_after)}` : null,
  };
}

/**
 * What to tell the user after Retry now returned `sync`: null when it worked; otherwise "Rate-limited until …" while
 * GitHub asks us to wait (the retry was blocked or GitHub limited us again), else "Still unavailable" and the reason.
 */
export function retryFeedback(sync: BadgeSync, now: Date): string | null {
  if (sync.sync === "synced") return null;
  const view = badgeView(sync, now);
  if (view.retryBlocked) return view.retryBlocked;
  return view.reason ? `Still unavailable: ${view.reason}` : "Still unavailable";
}

/**
 * A key for Retry now, validated at runtime (server actions get arbitrary input): `pr:owner/repo#123` or
 * `repo:owner/repo`. Returns the parts, or null.
 */
export function parseSyncKey(key: unknown): { kind: "pr" | "repo"; target: string } | null {
  if (typeof key !== "string" || !GITHUB_SNAPSHOT_KEY.test(key)) return null;
  const i = key.indexOf(":");
  return { kind: key.slice(0, i) as "pr" | "repo", target: key.slice(i + 1) };
}
