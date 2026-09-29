import {
  prKey,
  parsePrRef,
  prOverviewOf,
  syncStatus,
  type SyncState,
} from "../github/sync";
import type { PrOverview } from "../github/overview";
import { lineage, lookup } from "../hierarchy";
import {
  getGithubSnapshot,
  githubRepoAccess,
  type GithubAccess,
  type Workspace,
} from "../repo";
import type { GithubSnapshot, Task } from "../types";

/** Why a PR shows no data beyond the GitHub failure reasons: its repo isn't (or no longer) linked to a personal project. */
type Refusal = Extract<GithubAccess, { allowed: false }>["refusal"];

export interface PrSync {
  sync: SyncState;
  fetched_at: string | null;
  /** A GitHub failure reason (the last attempt failed), or not_linked / company (served nothing: see prSection). */
  reason: string | null;
  /** The last failure's redacted message, clipped. */
  message?: string;
  retry_after?: string;
}

export interface PrEntry {
  ref: string;
  url: string;
  overview: PrOverview | null;
  sync: PrSync;
}

const MESSAGE_MAX = 200;

/** What the assembler needs per PR ref: its snapshot (by prKey) and whether its repo may be shown. */
export interface PrInputs {
  snapshots: ReadonlyMap<string, GithubSnapshot | null>;
  access: ReadonlyMap<string, GithubAccess>;
}

/**
 * A task's PRs for get_task, from snapshots only (this never calls GitHub). Each entry carries the overview and the
 * sync status from `syncStatus`. Read-time guard: stored `prs` can outlive the link that allowed them, so when the PR's
 * repo isn't linked to a personal project the snapshot is not served: overview null and
 * `sync: { sync: "never", reason: "not_linked" | "company" }`.
 * Returns undefined (section left out) when the task has no PRs or its project is a company one.
 */
export function prSection(
  task: Pick<Task, "prs">,
  project: { context: string } | undefined,
  { snapshots, access }: PrInputs,
): PrEntry[] | undefined {
  if (!task.prs.length || project?.context === "company") return undefined;
  return task.prs.map((ref) => {
    const parsed = parsePrRef(ref);
    const url = parsed
      ? `https://github.com/${parsed.repo}/pull/${parsed.number}`
      : ref;
    const denied = !parsed ? "not_linked" : refusalOf(access.get(parsed.repo));
    if (denied)
      return {
        ref,
        url,
        overview: null,
        sync: { sync: "never", fetched_at: null, reason: denied },
      };
    const snapshot = snapshots.get(prKey(ref)) ?? null;
    const status = syncStatus(snapshot);
    const overview = prOverviewOf(snapshot);
    const sync: PrSync = {
      sync: status.sync,
      fetched_at: status.fetched_at,
      reason: status.reason,
    };
    if (status.error?.message)
      sync.message = status.error.message.slice(0, MESSAGE_MAX);
    if (status.retry_after) sync.retry_after = status.retry_after;
    return { ref, url: overview?.url ?? url, overview, sync };
  });
}

function refusalOf(access: GithubAccess | undefined): Refusal | undefined {
  if (!access) return "not_linked";
  return access.allowed ? undefined : access.refusal;
}

/** Reads the snapshots and repo access for a task's PRs (database only) and assembles the section. */
export async function taskGithub(
  task: Task,
  ws: Pick<Workspace, "milestones" | "projects">,
) {
  if (!task.prs.length) return undefined;
  const { project } = lineage(task, lookup(ws.milestones, ws.projects));
  if (project?.context === "company") return undefined;
  const repos = [
    ...new Set(task.prs.flatMap((ref) => parsePrRef(ref)?.repo ?? [])),
  ];
  const [snapshots, accesses] = await Promise.all([
    Promise.all(
      task.prs.map(
        async (ref) =>
          [prKey(ref), await getGithubSnapshot(prKey(ref))] as const,
      ),
    ),
    Promise.all(
      repos.map(async (repo) => [repo, await githubRepoAccess(repo)] as const),
    ),
  ]);
  return prSection(task, project, {
    snapshots: new Map(snapshots),
    access: new Map(accesses),
  });
}
