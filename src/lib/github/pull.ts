/**
 * The snapshot pull path (server-only: it reaches GitHub through ./client, which reads GITHUB_TOKEN): read the
 * snapshot, decide, call GitHub if needed, store the result, and hand back the snapshot with its sync status.
 * GitHub failures never throw; they end up in the snapshot's `last_error` and the returned status. Storage goes
 * through src/lib/repo.ts.
 */
import { z } from "zod";
import { getGithubSnapshot, githubRepoAccess, recordGithubFailure, upsertGithubSnapshot } from "../repo";
import type { GithubSnapshot } from "../types";
import { fetchOpenPrs, fetchPr, type GithubClientOptions } from "./client";
import { PrOverview, RepoPrItem, unreadableResponse, type GithubResult } from "./overview";
import {
  applyFetchResult,
  decidePull,
  failureOf,
  parsePrRef,
  prKey,
  prOverviewOf,
  repoKey,
  repoPrsOf,
  syncStatus,
  toGithubRepo,
  type PullDecision,
  type SyncStatus,
} from "./sync";

export interface PullOptions {
  /** Retry now: skip the FRESH_MS window (never `retry_after`). */
  force?: boolean;
  now?: () => Date;
  /** Injected fetch, token, base URL, ... (tests). */
  client?: GithubClientOptions;
}

/** Served (from the stored snapshot, or a fresh fetch just stored). */
export interface Pulled<T> {
  allowed: true;
  key: string;
  /** Null only when GitHub hasn't been asked yet and nothing is stored. */
  snapshot: GithubSnapshot | null;
  /** The snapshot's data, typed; null when never synced. */
  data: T | null;
  sync: SyncStatus;
  decision: PullDecision;
}

/**
 * Not allowed: no GitHub call was made and nothing was stored or served.
 * - invalid: not an `owner/repo#123` / `owner/repo` (or `github.com/owner/repo`);
 * - not_linked: the repo isn't linked to any project;
 * - company: it's linked only to company projects, which never contact GitHub.
 */
export interface Refused {
  allowed: false;
  key: string | null;
  refusal: "invalid" | "not_linked" | "company";
  message: string;
}

export type PullOutcome<T> = Pulled<T> | Refused;

async function pull<T extends PrOverview | RepoPrItem[]>(
  repo: string,
  key: string,
  options: PullOptions,
  fetcher: (client: GithubClientOptions) => Promise<GithubResult<T>>,
  schema: z.ZodType<T>,
  read: (snapshot: GithubSnapshot | null) => T | null,
): Promise<PullOutcome<T>> {
  const access = await githubRepoAccess(repo);
  if (!access.allowed) return { allowed: false, key, refusal: access.refusal, message: access.message };

  const now = options.now ?? (() => new Date());
  let snapshot = await getGithubSnapshot(key);
  const decision = decidePull(snapshot, now(), { force: options.force });
  if (decision.action === "fetch") {
    let result: GithubResult<T>;
    try {
      result = await fetcher({ now, ...options.client });
    } catch {
      // The client doesn't throw; this only guards against the unexpected.
      result = { ok: false, error: { reason: "github_down", status: null, message: "Unexpected error", request_id: null, retry_after: null } };
    }
    if (result.ok) {
      // A 2xx that doesn't map to a valid overview / list (e.g. `{}` → number NaN) is a failed fetch.
      const parsed = schema.safeParse(result.data);
      result = parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: unreadableResponse() };
    }
    if (result.ok) {
      snapshot = applyFetchResult(key, snapshot, result, now());
      await upsertGithubSnapshot(snapshot);
    } else {
      // Only the failure columns: a webhook write that landed during the fetch keeps its data and fetched_at.
      snapshot = await recordGithubFailure(key, failureOf(result.error, now()));
    }
  }
  return { allowed: true, key, snapshot, data: read(snapshot), sync: syncStatus(snapshot), decision };
}

/** A PR's overview (`owner/repo#123`), from its snapshot or GitHub. Never throws on a GitHub failure. */
export async function pullPr(ref: string, options: PullOptions = {}): Promise<PullOutcome<PrOverview>> {
  const pr = parsePrRef(ref.trim().toLowerCase());
  if (!pr) return { allowed: false, key: null, refusal: "invalid", message: `"${ref}" isn't a PR reference like owner/repo#123.` };
  const key = prKey(`${pr.repo}#${pr.number}`);
  return pull(pr.repo, key, options, (client) => fetchPr(pr.repo, pr.number, client), PrOverview, prOverviewOf);
}

/**
 * A repo's open PRs, from its snapshot or GitHub. Takes `owner/repo` or a project remote (`github.com/owner/repo`).
 * Never throws on a GitHub failure.
 */
export async function pullRepoOpenPrs(repoOrRemote: string, options: PullOptions = {}): Promise<PullOutcome<RepoPrItem[]>> {
  const repo = toGithubRepo(repoOrRemote);
  if (!repo) return { allowed: false, key: null, refusal: "invalid", message: `"${repoOrRemote}" isn't a GitHub repo like owner/repo.` };
  return pull(repo, repoKey(repo), options, (client) => fetchOpenPrs(repo, client), z.array(RepoPrItem), repoPrsOf);
}
