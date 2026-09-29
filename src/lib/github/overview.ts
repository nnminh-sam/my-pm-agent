/**
 * Pure GitHub types and mapping: no I/O, safe to import anywhere (the webhook reuses `mapPr`).
 * Only the PR overview fields are kept; diffs, files, commits and review text are never mapped.
 */
import { z } from "zod";

export const PR_STATES = ["open", "draft", "merged", "closed"] as const;
export const REVIEW_STATES = ["approved", "changes_requested", "commented", "pending"] as const;
export const GITHUB_ERROR_REASONS = ["github_down", "timeout", "rate_limited", "bad_token", "no_access"] as const;

export const PrReviewer = z.object({ login: z.string(), state: z.enum(REVIEW_STATES) });
export type PrReviewer = z.infer<typeof PrReviewer>;

/** The only PR data my_pm shows or stores. */
export const PrOverview = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  state: z.enum(PR_STATES),
  merged_at: z.string().nullable(),
  /** The GitHub milestone title, not a my_pm milestone. */
  milestone: z.string().nullable(),
  reviewers: z.array(PrReviewer),
  assignees: z.array(z.string()),
  author: z.string().nullable(),
  base: z.string(),
  head: z.string(),
  updated_at: z.string(),
  url: z.string(),
});
export type PrOverview = z.infer<typeof PrOverview>;

/** An item of a repo's open-PR list (reviewers are the requested ones only). */
export const RepoPrItem = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "draft"]),
  author: z.string().nullable(),
  reviewers: z.array(z.string()),
  assignees: z.array(z.string()),
  updated_at: z.string(),
  url: z.string(),
});
export type RepoPrItem = z.infer<typeof RepoPrItem>;

export const GithubError = z.object({
  reason: z.enum(GITHUB_ERROR_REASONS),
  status: z.number().int().nullable(),
  /** GitHub's message, redacted and clipped. */
  message: z.string(),
  /** `x-github-request-id`. */
  request_id: z.string().nullable(),
  /** ISO timestamp before which GitHub must not be called again. */
  retry_after: z.string().nullable(),
});
export type GithubError = z.infer<typeof GithubError>;

export type GithubResult<T> = { ok: true; data: T } | { ok: false; error: GithubError };

/** Postgres jsonb rejects U+0000. */
export function cleanText(s: unknown): string {
  return typeof s === "string" ? s.replace(/\u0000/g, "") : "";
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const login = (v: unknown): string | null => {
  const l = cleanText(obj(v).login);
  return l || null;
};
const logins = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(login).filter((l): l is string => l !== null) : [];

function prState(pr: Json): PrOverview["state"] {
  if (pr.merged === true || pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft === true ? "draft" : "open";
}

/**
 * Reduce GitHub reviews to one state per reviewer (keyed by lowercase login), in chronological order:
 * - APPROVED / CHANGES_REQUESTED set the state;
 * - COMMENTED sets the state only if the reviewer has none (it never overrides an approval or a change request,
 *   as on GitHub's own review summary);
 * - DISMISSED clears the reviewer's state (they fall back to pending if still requested, else drop out);
 * - PENDING (an unsubmitted draft review) is ignored.
 */
export function reduceReviews(reviews: unknown): Map<string, PrReviewer> {
  const out = new Map<string, PrReviewer>();
  if (!Array.isArray(reviews)) return out;
  const sorted = reviews
    .map((r, i) => ({ r: obj(r), i }))
    .sort((a, b) => {
      const ta = Date.parse(cleanText(a.r.submitted_at)) || 0;
      const tb = Date.parse(cleanText(b.r.submitted_at)) || 0;
      return ta - tb || a.i - b.i;
    });
  for (const { r } of sorted) applyReview(out, r);
  return out;
}

/**
 * Apply one review (a GitHub review object, state in any case) to the per-reviewer states, by the rules of
 * reduceReviews. Mutates and returns `states`. The webhook uses it for a single `pull_request_review` delivery.
 */
export function applyReview(states: Map<string, PrReviewer>, review: unknown): Map<string, PrReviewer> {
  const r = obj(review);
  const who = login(r.user);
  if (!who) return states;
  const key = who.toLowerCase();
  const s = cleanText(r.state).toUpperCase();
  if (s === "APPROVED") states.set(key, { login: who, state: "approved" });
  else if (s === "CHANGES_REQUESTED") states.set(key, { login: who, state: "changes_requested" });
  else if (s === "COMMENTED") {
    if (!states.has(key)) states.set(key, { login: who, state: "commented" });
  } else if (s === "DISMISSED") states.delete(key);
  return states;
}

/** Reviewers = everyone with a review state, plus requested reviewers who haven't reviewed (pending). */
export function mergeReviewers(requested: string[], states: Map<string, PrReviewer>): PrReviewer[] {
  const list = [...states.values()];
  for (const who of requested) {
    if (!states.has(who.toLowerCase())) list.push({ login: who, state: "pending" });
  }
  return list;
}

/** Map `GET /repos/{o}/{r}/pulls/{n}` (or a webhook `pull_request` object) plus its reviews to a PrOverview. */
export function mapPr(repo: string, pr: unknown, reviews: unknown): PrOverview {
  const p = obj(pr);
  const requested = logins(p.requested_reviewers);
  return {
    repo: repo.toLowerCase(),
    number: Number(p.number),
    title: cleanText(p.title),
    body: cleanText(p.body),
    state: prState(p),
    merged_at: cleanText(p.merged_at) || null,
    milestone: cleanText(obj(p.milestone).title) || null,
    reviewers: mergeReviewers(requested, reduceReviews(reviews)),
    assignees: logins(p.assignees),
    author: login(p.user),
    base: cleanText(obj(p.base).ref),
    head: cleanText(obj(p.head).ref),
    updated_at: cleanText(p.updated_at),
    url: cleanText(p.html_url),
  };
}

/** Map one item of `GET /repos/{o}/{r}/pulls?state=open`. */
export function mapRepoPrItem(repo: string, pr: unknown): RepoPrItem {
  const p = obj(pr);
  return {
    repo: repo.toLowerCase(),
    number: Number(p.number),
    title: cleanText(p.title),
    state: p.draft === true ? "draft" : "open",
    author: login(p.user),
    reviewers: logins(p.requested_reviewers),
    assignees: logins(p.assignees),
    updated_at: cleanText(p.updated_at),
    url: cleanText(p.html_url),
  };
}

// ---- error classification and redaction (pure) ----

const MAX_MESSAGE = 300;

/** Replace every secret occurrence with `[redacted]` and clip long text. */
export function redact(text: string, secrets: Array<string | undefined | null>, max = MAX_MESSAGE): string {
  let out = cleanText(text);
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join("[redacted]");
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export interface FailureInput {
  /** HTTP status; null when there was no response. */
  status: number | null;
  headers?: { get(name: string): string | null };
  /** Response body text (only used to find GitHub's `message`). */
  body?: string;
  /** The call was aborted by the timeout. */
  timedOut?: boolean;
  /** The timeout that applied, for the message (default GITHUB_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Error text for a network failure. */
  networkMessage?: string;
  now: Date;
  secrets: Array<string | undefined | null>;
}

function githubMessage(body: string | undefined): string {
  if (!body) return "";
  try {
    const m = (JSON.parse(body) as Json).message;
    if (typeof m === "string") return m;
  } catch {
    /* not JSON: use the raw text */
  }
  return body;
}

/** The longest a rate limit may hold off GitHub calls, whatever the headers say (GitHub's own windows are 1h). */
export const RETRY_AFTER_MAX_MS = 3600_000;

/**
 * retry-after (seconds) wins over x-ratelimit-reset (epoch seconds); null when neither is usable. A negative, zero
 * (reset) or non-finite value is unusable; a usable one is capped at now + 1h, so a bogus header can't block a key
 * for long.
 */
export function retryAfterFrom(headers: FailureInput["headers"], now: Date): string | null {
  const t = now.getTime();
  const capped = (ms: number) => new Date(Math.min(ms, t + RETRY_AFTER_MAX_MS)).toISOString();
  const raHeader = headers?.get("retry-after");
  const ra = Number(raHeader);
  if (raHeader && raHeader.trim() !== "" && Number.isFinite(ra) && ra >= 0) return capped(t + ra * 1000);
  const resetHeader = headers?.get("x-ratelimit-reset");
  const reset = Number(resetHeader);
  if (resetHeader && resetHeader.trim() !== "" && Number.isFinite(reset) && reset > 0) return capped(reset * 1000);
  return null;
}

/**
 * A 2xx whose body isn't what GitHub documents (not a PR, not a list): a failed fetch, so the old snapshot stays.
 * The message is fixed, so it can't quote anything from the body.
 */
export function unreadableResponse(): GithubError {
  return { reason: "github_down", status: null, message: "GitHub sent a response my_pm couldn't read", request_id: null, retry_after: null };
}

/** How long each GitHub call may take. */
export const GITHUB_TIMEOUT_MS = 5000;
/** A rate limit that came without a usable reset header waits this long. */
export const RATE_LIMIT_DEFAULT_MS = 60_000;

/** `5s`, or `250ms` for a timeout that isn't whole seconds. */
export const formatTimeout = (ms: number) => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

/**
 * Classify a failed call:
 * - no response: timeout if aborted, else github_down;
 * - 401 bad_token; 5xx github_down;
 * - 429, or 403 with `x-ratelimit-remaining: 0` / `retry-after` / a "rate limit" message (a secondary rate limit):
 *   rate_limited, retry_after from the headers or else now + RATE_LIMIT_DEFAULT_MS;
 * - other 403 / 404: no_access; any other 4xx: no_access; any other status (3xx, ...): github_down.
 */
export function classifyFailure(f: FailureInput): GithubError {
  const request_id = f.headers?.get("x-github-request-id") ?? null;
  const make = (reason: GithubError["reason"], message: string, retry_after: string | null = null): GithubError => ({
    reason,
    status: f.status,
    message: redact(message, f.secrets),
    request_id: request_id ? redact(request_id, f.secrets, 100) : null,
    retry_after,
  });
  if (f.status === null) {
    return f.timedOut
      ? make("timeout", `GitHub did not respond within ${formatTimeout(f.timeoutMs ?? GITHUB_TIMEOUT_MS)}`)
      : make("github_down", f.networkMessage || "Network error");
  }
  const message = githubMessage(f.body) || `HTTP ${f.status}`;
  const limited =
    f.status === 429 ||
    (f.status === 403 &&
      (f.headers?.get("x-ratelimit-remaining") === "0" || f.headers?.get("retry-after") != null || /rate limit/i.test(message)));
  if (limited) {
    const retryAfter = retryAfterFrom(f.headers, f.now) ?? new Date(f.now.getTime() + RATE_LIMIT_DEFAULT_MS).toISOString();
    return make("rate_limited", message, retryAfter);
  }
  if (f.status === 401) return make("bad_token", message);
  if (f.status >= 500) return make("github_down", message);
  if (f.status >= 400) return make("no_access", message);
  return make("github_down", message);
}
