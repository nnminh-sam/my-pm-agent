import type { RepoPrItem } from "@/lib/github/overview";
import type { ProjectPrs } from "@/lib/github/project-prs";
import { prUrl } from "@/lib/github/pr-view";
import { SyncBadge } from "./sync-badge";
import { Badge, Card } from "./ui";

/** One open PR row: title (linked from `owner/repo` + number, never the snapshot's url), author, reviewers, assignees. */
export function RepoPrRow({ repo, pr }: { repo: string; pr: RepoPrItem }) {
  const href = prUrl(`${repo}#${pr.number}`);
  const title = (
    <>
      <span className="font-mono text-xs text-muted">#{pr.number}</span> <span>{pr.title}</span>
    </>
  );
  return (
    <li className="space-y-0.5 px-4 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="min-w-0 hover:underline">
            {title}
          </a>
        ) : (
          <span>{title}</span>
        )}
        {pr.state === "draft" && <Badge tone="muted">draft</Badge>}
      </div>
      <p className="text-xs text-muted">
        {pr.author ? `by ${pr.author}` : "author unknown"}
        {pr.reviewers.length > 0 && ` · reviewers: ${pr.reviewers.join(", ")}`}
        {pr.assignees.length > 0 && ` · assignees: ${pr.assignees.join(", ")}`}
      </p>
    </li>
  );
}

/**
 * The project page's open PRs: one list per linked GitHub repo, each with its own sync badge and, when there are
 * several repos, the repo's name. `null` (no github.com repo) renders nothing: no section, no badge.
 * A repo never synced shows its badge (with the reason) and no rows; one out of sync shows the last rows it had.
 */
export function RepoPrs({ prs, now }: { prs: ProjectPrs | null; now: string }) {
  if (!prs) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Open pull requests</h2>
      {prs.sections.map(({ repo, view }) => (
        <Card key={repo}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
            {prs.labeled && <span className="font-mono text-sm font-medium">{repo}</span>}
            <span className="text-sm text-muted">
              {view.data ? `${view.data.length} open` : "no data yet"}
            </span>
            <span className="ml-auto">
              <SyncBadge sync={view.sync} syncKey={view.key} url={`https://github.com/${repo}/pulls`} now={now} />
            </span>
          </div>
          {view.data && view.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {view.data.map((pr) => (
                <RepoPrRow key={pr.number} repo={repo} pr={pr} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">{view.data ? "No open pull requests." : "Nothing fetched from GitHub yet."}</p>
          )}
        </Card>
      ))}
    </section>
  );
}
