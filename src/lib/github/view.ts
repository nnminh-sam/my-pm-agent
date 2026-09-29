/**
 * What a GitHub-backed page loads (T10 task page, T11 project page) and what Retry now runs. Server-only: it goes
 * through ./pull, which reads GITHUB_TOKEN. Nothing here throws on a GitHub failure, and everything returned is safe
 * to hand to a client component (no token, no raw last_error beyond the redacted reason / status / message / request id).
 */
import type { PrOverview, RepoPrItem } from "./overview";
import { pullPr, pullRepoOpenPrs, type PullOptions, type PullOutcome } from "./pull";
import { syncStatus } from "./sync";
import { parseSyncKey, type BadgeSync } from "./sync-view";

export interface GithubView<T> {
  /** The snapshot key the badge's Retry now uses. Null when the input wasn't a PR / repo. */
  key: string | null;
  /** The snapshot's data; null when never synced or refused. */
  data: T | null;
  sync: BadgeSync;
}

function toView<T>(outcome: PullOutcome<T>): GithubView<T> {
  if (!outcome.allowed) return { key: outcome.key, data: null, sync: { ...syncStatus(null), refusal: outcome.refusal } };
  return { key: outcome.key, data: outcome.data, sync: outcome.sync };
}

/** A PR page's data: pulls (serving a snapshot under 60s old, otherwise calling GitHub). `ref` is `owner/repo#123`. */
export async function loadPrView(ref: string, options: PullOptions = {}): Promise<GithubView<PrOverview>> {
  return toView(await pullPr(ref, options));
}

/** A project page's open PRs for one linked repo (`owner/repo` or `github.com/owner/repo`). */
export async function loadRepoView(repo: string, options: PullOptions = {}): Promise<GithubView<RepoPrItem[]>> {
  return toView(await pullRepoOpenPrs(repo, options));
}

export type RetryResult = { ok: true; sync: BadgeSync } | { ok: false; message: string };

/**
 * Retry now for a snapshot key (`pr:owner/repo#123` | `repo:owner/repo`): a forced pull. It skips the 60s window but
 * never `retry_after` (decidePull), so a rate-limited key comes back unchanged. Input is validated here, not trusted.
 */
export async function retrySync(key: unknown, options: PullOptions = {}): Promise<RetryResult> {
  const parsed = parseSyncKey(key);
  if (!parsed) return { ok: false, message: "Not a GitHub pull request or repo key" };
  const view =
    parsed.kind === "pr"
      ? await loadPrView(parsed.target, { ...options, force: true })
      : await loadRepoView(parsed.target, { ...options, force: true });
  return { ok: true, sync: view.sync };
}
