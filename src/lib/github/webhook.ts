/**
 * The GitHub webhook, pure: signature verification and how a delivery updates snapshots. No I/O (node:crypto only);
 * the route is src/app/api/github/webhook/route.ts, which checks the personal-repo link and does the storage.
 *
 * A delivery carries the PR itself, so it is written straight into the snapshot and GitHub is never called back.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { GithubSnapshot } from "../types";
import { applyReview, mapPr, mapRepoPrItem, mergeReviewers, PrOverview, RepoPrItem, type PrReviewer } from "./overview";
import { prKey, prOverviewOf, repoKey, repoPrsOf, toGithubRepo } from "./sync";

export const SIGNATURE_HEADER = "x-hub-signature-256";
export const EVENT_HEADER = "x-github-event";

/** `sha256=` then the HMAC as 64 hex digits (GitHub sends lowercase; either case is accepted). */
const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * Whether `header` (X-Hub-Signature-256) is the HMAC-SHA256 of the exact body bytes under `secret`, compared in
 * constant time. False for a missing header, a missing or empty secret, a missing `sha256=` prefix or malformed hex.
 */
export function verifySignature(
  rawBody: Uint8Array | string,
  header: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || !header) return false;
  const match = SIGNATURE.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Events that update snapshots. `ping` and everything else are acknowledged and ignored. */
export const HANDLED_EVENTS = ["pull_request", "pull_request_review"] as const;
export type WebhookEvent = (typeof HANDLED_EVENTS)[number];
export const isHandledEvent = (event: string | null | undefined): event is WebhookEvent =>
  (HANDLED_EVENTS as readonly string[]).includes(event ?? "");

/** Review actions that change a reviewer's state; `edited` only changes the text, which isn't stored. */
const REVIEW_ACTIONS = new Set(["submitted", "dismissed"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** The repo a delivery is about (`repository.full_name`), as `owner/repo` in lowercase; null when there's none. */
export function webhookRepo(payload: unknown): string | null {
  const name = obj(obj(payload).repository).full_name;
  return typeof name === "string" ? toGithubRepo(name) : null;
}

function prNumber(payload: unknown): number | null {
  const n = obj(obj(payload).pull_request).number;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The snapshot keys a delivery may update: its PR, and for `pull_request` also its repo's open-PR list. Empty when
 * the payload has no repo or PR number.
 */
export function webhookKeys(event: WebhookEvent, payload: unknown): string[] {
  const repo = webhookRepo(payload);
  const number = prNumber(payload);
  if (!repo || number === null) return [];
  const pr = prKey(`${repo}#${number}`);
  return event === "pull_request" ? [pr, repoKey(repo)] : [pr];
}

/** `a` is strictly later than `b` (unparseable times never are). */
const later = (a: string, b: string) => Date.parse(a) > Date.parse(b);

/** Reviewers who have a review state, keyed by lowercase login (pending ones are just requested). */
function reviewStates(overview: PrOverview | null): Map<string, PrReviewer> {
  const states = new Map<string, PrReviewer>();
  for (const r of overview?.reviewers ?? []) if (r.state !== "pending") states.set(r.login.toLowerCase(), r);
  return states;
}

/**
 * A PR snapshot holding `data`, delivered at `now`: `fetched_at` set (the data is GitHub's own, just now) and
 * `last_error` cleared (what's shown is no longer out of date). `last_attempt_at` and `retry_after` are kept: they
 * describe calls to GitHub, and a delivery says nothing about those, least of all about a rate limit.
 */
function delivered(key: string, snapshot: GithubSnapshot | null, data: PrOverview, now: Date): GithubSnapshot {
  const next: GithubSnapshot = { key, data, fetched_at: now.toISOString() };
  if (snapshot?.last_attempt_at) next.last_attempt_at = snapshot.last_attempt_at;
  if (snapshot?.retry_after) next.retry_after = snapshot.retry_after;
  return next;
}

/** `pull_request`: the PR fields from the payload; reviewer states kept, requested reviewers from the payload. */
function applyPullRequest(key: string, snapshot: GithubSnapshot | null, repo: string, payload: Json, now: Date) {
  const incoming = PrOverview.safeParse(mapPr(repo, payload.pull_request, []));
  if (!incoming.success) return null;
  const current = prOverviewOf(snapshot);
  // An out-of-order delivery older than what's stored changes nothing.
  if (current && later(current.updated_at, incoming.data.updated_at)) return null;
  // Without reviews, mapPr lists exactly the requested reviewers, as pending.
  const requested = incoming.data.reviewers.map((r) => r.login);
  const data = { ...incoming.data, reviewers: mergeReviewers(requested, reviewStates(current)) };
  return delivered(key, snapshot, data, now);
}

/**
 * `pull_request_review` (submitted or dismissed): that one reviewer's state, by the rules of reduceReviews. With no
 * overview stored yet, one is built from the payload's `pull_request`, its reviewer states starting from this review.
 */
function applyPullRequestReview(key: string, snapshot: GithubSnapshot | null, repo: string, payload: Json, now: Date) {
  if (!REVIEW_ACTIONS.has(String(payload.action))) return null;
  const review = obj(payload.review);
  if (typeof obj(review.user).login !== "string") return null;
  const current = prOverviewOf(snapshot);
  if (!current) {
    const built = PrOverview.safeParse(mapPr(repo, payload.pull_request, [review]));
    return built.success ? delivered(key, snapshot, built.data, now) : null;
  }
  const states = applyReview(reviewStates(current), review);
  // Still-requested reviewers are the pending ones stored; one who just reviewed now has a state instead.
  const requested = current.reviewers.filter((r) => r.state === "pending").map((r) => r.login);
  return delivered(key, snapshot, { ...current, reviewers: mergeReviewers(requested, states) }, now);
}

/**
 * `pull_request` on a repo's open-PR list: upsert the PR while it's open, remove it once closed or merged. Only a
 * list that was already fetched is touched (one delivery can't make a whole list), and only its data: `fetched_at`
 * still says when the whole list was last read from GitHub, so the next pull after the window corrects any drift.
 */
function applyToRepoList(snapshot: GithubSnapshot | null, repo: string, payload: Json) {
  const list = repoPrsOf(snapshot);
  if (!snapshot || !list) return null;
  const pr = obj(payload.pull_request);
  const item = RepoPrItem.safeParse(mapRepoPrItem(repo, pr));
  if (!item.success) return null;
  const i = list.findIndex((p) => p.number === item.data.number);
  if (i >= 0 && later(list[i].updated_at, item.data.updated_at)) return null;
  const open = pr.state === "open" && pr.merged !== true && !pr.merged_at;
  let data: RepoPrItem[];
  if (open) data = i >= 0 ? list.map((p, j) => (j === i ? item.data : p)) : [item.data, ...list];
  else if (i >= 0) data = list.filter((_, j) => j !== i);
  else return null;
  return { ...snapshot, data };
}

/**
 * The snapshot under `key` after a delivery at `now`, or null when it changes nothing (a stale or unusable payload,
 * an action that doesn't change state, a repo list never fetched). `key` is one of webhookKeys(event, payload).
 */
export function applyWebhookEvent(
  key: string,
  snapshot: GithubSnapshot | null,
  event: WebhookEvent,
  payload: unknown,
  now: Date,
): GithubSnapshot | null {
  const repo = webhookRepo(payload);
  if (!repo || !webhookKeys(event, payload).includes(key)) return null;
  const p = obj(payload);
  if (key.startsWith("repo:")) return event === "pull_request" ? applyToRepoList(snapshot, repo, p) : null;
  return event === "pull_request" ? applyPullRequest(key, snapshot, repo, p, now) : applyPullRequestReview(key, snapshot, repo, p, now);
}
