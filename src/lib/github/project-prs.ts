/**
 * The project page's open PRs: one entry per linked GitHub repo, loaded in parallel (each is one non-forced pull, so a
 * snapshot under 60s old costs no GitHub call). Server-only, via ./view. Nothing here throws on a GitHub failure.
 *
 * Graceful absence: a company project never contacts GitHub, and a project with no github.com repo has no PR section
 * (null), so neither gets a badge. Other hosts' remotes are ignored here (they only feed local hooks).
 */
import type { Project } from "../types";
import type { RepoPrItem } from "./overview";
import { toGithubRepo } from "./sync";
import { loadRepoView, type GithubView } from "./view";
import type { PullOptions } from "./pull";

export interface RepoPrSection {
  /** `owner/repo`. */
  repo: string;
  view: GithubView<RepoPrItem[]>;
}

export interface ProjectPrs {
  sections: RepoPrSection[];
  /** Several repos: each list carries its repo name. One repo: no label. */
  labeled: boolean;
}

/** The distinct `owner/repo` of a project's github.com remotes, in stored order. */
export function githubReposOf(project: Pick<Project, "repos">): string[] {
  const repos = project.repos.flatMap((remote) => {
    const repo = remote.trim().toLowerCase().startsWith("github.com/") ? toGithubRepo(remote) : null;
    return repo ? [repo] : [];
  });
  return [...new Set(repos)];
}

export async function loadProjectPrs(
  project: Pick<Project, "repos" | "context">,
  options: PullOptions = {},
): Promise<ProjectPrs | null> {
  if (project.context === "company") return null;
  const repos = githubReposOf(project);
  if (!repos.length) return null;
  const sections = await Promise.all(repos.map(async (repo) => ({ repo, view: await loadRepoView(repo, options) })));
  return { sections, labeled: sections.length > 1 };
}
