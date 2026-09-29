/**
 * View models for a PR on the task page (card) and in task lists (chip), pure. Everything a link needs is rebuilt from
 * the normalized ref (`owner/repo#123`), never taken from a snapshot's `url`.
 */
import type { PrOverview, PrReviewer } from "./overview";
import { parsePrRef, type SyncState } from "./sync";
import { formatWhen, relativeTime } from "./sync-view";

/** `https://github.com/owner/repo/pull/123` from a normalized ref; null when the ref isn't one. */
export function prUrl(ref: string): string | null {
  const pr = parsePrRef(ref);
  return pr ? `https://github.com/${pr.repo}/pull/${pr.number}` : null;
}

export type PrTone = "neutral" | "accent" | "danger" | "warn" | "ok" | "muted";

const STATE_TONE: Record<PrOverview["state"], PrTone> = { open: "neutral", draft: "muted", merged: "accent", closed: "muted" };
const REVIEW_TEXT: Record<PrReviewer["state"], string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
  pending: "pending",
};
const REVIEW_TONE: Record<PrReviewer["state"], PrTone> = { approved: "ok", changes_requested: "danger", commented: "neutral", pending: "muted" };

/** The PR's review outcome: changes requested beats approved; null when nobody has decided. */
export function reviewOutcome(reviewers: PrReviewer[]): "approved" | "changes_requested" | null {
  if (reviewers.some((r) => r.state === "changes_requested")) return "changes_requested";
  return reviewers.some((r) => r.state === "approved") ? "approved" : null;
}

export interface PrChipInput {
  ref: string;
  overview: PrOverview | null;
  sync: { sync: SyncState; fetched_at: string | null };
}

export interface PrChipView {
  /** `PR #123 · approved`, `PR #123 · merged`, ... */
  text: string;
  tone: PrTone;
  /** Out of sync: the chip shows an amber dot. */
  outOfSync: boolean;
  /** Tooltip: the PR and its sync state in words. */
  title: string;
  /** github.com link built from the ref; null when the ref isn't a PR. */
  href: string | null;
}

/** A list chip for one referenced PR, from its snapshot (`overview` null: never synced or not readable). */
export function prChip(input: PrChipInput, now: Date): PrChipView {
  const parsed = parsePrRef(input.ref);
  const label = parsed ? `PR #${parsed.number}` : `PR ${input.ref}`;
  const { overview, sync } = input;
  let status: string;
  let tone: PrTone;
  if (!overview) {
    status = "not synced";
    tone = "muted";
  } else if (overview.state === "open") {
    const outcome = reviewOutcome(overview.reviewers);
    status = outcome ? REVIEW_TEXT[outcome] : "open";
    tone = outcome === "approved" ? "ok" : outcome === "changes_requested" ? "danger" : "neutral";
  } else {
    status = overview.state;
    tone = STATE_TONE[overview.state];
  }
  const syncText =
    sync.sync === "out_of_sync" && sync.fetched_at
      ? `Out of sync, last synced ${relativeTime(sync.fetched_at, now)}`
      : sync.sync === "never"
        ? "Never synced"
        : sync.fetched_at
          ? `synced ${relativeTime(sync.fetched_at, now)}`
          : "";
  return {
    text: `${label} · ${status}`,
    tone,
    outOfSync: sync.sync === "out_of_sync",
    title: [input.ref, overview?.title, syncText].filter(Boolean).join(" · "),
    href: prUrl(input.ref),
  };
}

export interface PrCardView {
  title: string;
  /** `open`, `draft`, `closed`, or `merged` (`merged_at` is a separate line). */
  state: PrOverview["state"];
  stateTone: PrTone;
  mergedAt: string | null;
  milestone: string | null;
  reviewers: { login: string; text: string; tone: PrTone }[];
  assignees: string[];
  author: string | null;
  /** `main ← feature`. */
  branches: string;
  updatedAt: string;
  href: string | null;
}

/** The task page's card fields for a PR overview. `ref` supplies the link. */
export function prCardView(overview: PrOverview, ref: string): PrCardView {
  return {
    title: overview.title,
    state: overview.state,
    stateTone: STATE_TONE[overview.state],
    mergedAt: overview.state === "merged" && overview.merged_at ? formatWhen(overview.merged_at) : null,
    milestone: overview.milestone,
    reviewers: overview.reviewers.map((r) => ({ login: r.login, text: REVIEW_TEXT[r.state], tone: REVIEW_TONE[r.state] })),
    assignees: overview.assignees,
    author: overview.author,
    branches: `${overview.base} ← ${overview.head}`,
    updatedAt: formatWhen(overview.updated_at),
    href: prUrl(ref),
  };
}
