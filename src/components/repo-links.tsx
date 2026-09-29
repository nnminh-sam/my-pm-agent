"use client";

import { useActionState, useState, useTransition } from "react";
import { addProjectRepoAction, removeProjectRepoAction } from "@/app/actions";
import type { RepoLinkResult } from "@/lib/repo-link-input";

/**
 * A project's linked repos, normalized, each with a remove button, and an add input that takes any git remote form
 * (`owner/repo` means github.com). Both actions return `{ ok, message }`, shown here: production redacts thrown errors.
 */
export function RepoLinks({ project, repos }: { project: string; repos: string[] }) {
  const [added, add, adding] = useActionState<RepoLinkResult | null, FormData>(addProjectRepoAction, null);
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  const remove = (repo: string) =>
    startTransition(async () => {
      try {
        const result = await removeProjectRepoAction(project, repo);
        setFailure(result.ok ? null : result.message);
      } catch {
        setFailure("Couldn't update the repositories");
      }
    });

  return (
    <div className="space-y-3">
      {repos.length > 0 ? (
        <ul className="divide-y divide-border">
          {repos.map((repo) => (
            <li key={repo} className="flex items-center gap-2 py-1.5 first:pt-0">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{repo}</span>
              <button
                type="button"
                onClick={() => remove(repo)}
                disabled={pending}
                aria-label={`Remove ${repo}`}
                className="text-xs text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No repositories linked.</p>
      )}
      <form action={add} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="project" value={project} />
        <input
          name="remote"
          required
          placeholder="owner/repo or a git remote"
          aria-label="Repository to link"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-sm"
        />
        <button disabled={adding} className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50 dark:text-black">
          {adding ? "Adding…" : "Add"}
        </button>
      </form>
      <p role="alert" className="text-xs text-danger">
        {failure ?? (added && !added.ok ? added.message : null)}
      </p>
    </div>
  );
}
