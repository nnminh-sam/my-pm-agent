import { prCardView, prUrl } from "@/lib/github/pr-view";
import type { PrOverview } from "@/lib/github/overview";
import type { BadgeSync } from "@/lib/github/sync-view";
import { SyncBadge } from "./sync-badge";
import { Badge, Card, Markdown } from "./ui";

/**
 * One referenced PR on the task page: the overview from its snapshot (last known data stays visible when out of sync)
 * and the sync badge. `data` null: never synced or refused; only the reference, "Open in GitHub" and the badge show.
 * The body goes through the app's markdown renderer, which drops raw HTML; links are built from `prRef`.
 */
export function PrCard({
  prRef,
  data,
  sync,
  syncKey,
  now,
}: {
  prRef: string;
  data: PrOverview | null;
  sync: BadgeSync;
  syncKey: string | null;
  now: string;
}) {
  const href = prUrl(prRef);
  const view = data ? prCardView(data, prRef) : null;
  return (
    <Card className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-muted">{prRef}</span>
        {view && (
          <Badge tone={view.stateTone}>
            {view.state}
            {view.mergedAt && ` · ${view.mergedAt}`}
          </Badge>
        )}
        <SyncBadge sync={sync} syncKey={syncKey} url={href ?? undefined} now={now} />
        {href && (
          <a href={href} target="_blank" rel="noreferrer" className="ml-auto text-sm text-accent hover:underline">
            Open in GitHub
          </a>
        )}
      </div>
      {view ? (
        <>
          <h3 className="font-medium">{view.title}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Branches</dt>
            <dd className="font-mono text-xs leading-5 break-all">{view.branches}</dd>
            {view.author && (
              <>
                <dt className="text-muted">Author</dt>
                <dd>{view.author}</dd>
              </>
            )}
            {view.milestone && (
              <>
                <dt className="text-muted">Milestone</dt>
                <dd>{view.milestone}</dd>
              </>
            )}
            {view.assignees.length > 0 && (
              <>
                <dt className="text-muted">Assignees</dt>
                <dd>{view.assignees.join(", ")}</dd>
              </>
            )}
            {view.reviewers.length > 0 && (
              <>
                <dt className="text-muted">Reviewers</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {view.reviewers.map((r) => (
                    <span key={r.login} className="inline-flex items-center gap-1">
                      {r.login} <Badge tone={r.tone}>{r.text}</Badge>
                    </span>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-muted">Updated</dt>
            <dd>{view.updatedAt}</dd>
          </dl>
          <div className="max-h-96 overflow-auto rounded border border-border px-3 py-2">
            <Markdown>{data!.body}</Markdown>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">No overview yet.</p>
      )}
    </Card>
  );
}
