"use client";

import { useEffect, useState, useTransition } from "react";
import { retryGithubSync } from "@/app/actions";
import { badgeView, type BadgeSync, type BadgeTone } from "@/lib/github/sync-view";

const TONE: Record<BadgeTone, string> = {
  quiet: "text-muted",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};

/**
 * Sync status of a GitHub-backed view: a quiet "synced 2m ago", an amber "Out of sync · last synced 14m ago" or a red
 * "Never synced", the latter two opening a details panel (reason, HTTP status, GitHub's message, request id, last
 * attempt, retry_after, Retry now, links). Only the redacted sync status reaches the browser.
 *
 * `now` is the server's render time (ISO): the first client render uses it, so relative times match the server's HTML;
 * after mount a timer keeps them current.
 */
export function SyncBadge({
  sync,
  syncKey,
  url,
  now,
}: {
  sync: BadgeSync;
  /** `pr:owner/repo#123` or `repo:owner/repo`; without it (or on a refusal) there is no Retry now. */
  syncKey: string | null;
  /** The PR / repo on github.com, for "Open in GitHub". */
  url?: string;
  now: string;
}) {
  const [clock, setClock] = useState(() => new Date(now));
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  const view = badgeView(sync, clock);
  if (!view.hasDetails) return <span className={`text-[11px] ${TONE.quiet}`}>{view.label}</span>;

  const retry = () =>
    startTransition(async () => {
      try {
        const result = await retryGithubSync(syncKey!);
        setFailure(result.ok ? null : result.message);
      } catch {
        setFailure("Retry failed");
      }
    });

  return (
    <details className="relative inline-block text-[11px]">
      <summary
        className={`inline-flex cursor-pointer list-none items-center rounded px-1.5 py-0.5 font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent ${TONE[view.tone]}`}
      >
        {view.label}
      </summary>
      <div className="absolute left-0 z-10 mt-1 w-72 rounded border border-border bg-surface p-3 text-xs text-fg shadow-lg">
        {view.reason && <p className="font-medium">{view.reason}</p>}
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted">
          {view.status !== null && (
            <>
              <dt>HTTP status</dt>
              <dd className="text-fg">{view.status}</dd>
            </>
          )}
          {view.message && (
            <>
              <dt>GitHub said</dt>
              <dd className="break-words text-fg">{view.message}</dd>
            </>
          )}
          {view.requestId && (
            <>
              <dt>Request id</dt>
              <dd className="font-mono break-all text-fg">{view.requestId}</dd>
            </>
          )}
          {view.lastAttempt && (
            <>
              <dt>Last attempt</dt>
              <dd className="text-fg">{view.lastAttempt}</dd>
            </>
          )}
          {view.retryAfter && (
            <>
              <dt>Retry after</dt>
              <dd className="text-fg">{view.retryAfter}</dd>
            </>
          )}
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {syncKey && !sync.refusal && (
            <button
              type="button"
              onClick={retry}
              disabled={pending || !view.canRetry}
              className="rounded border border-border px-2 py-0.5 hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {pending ? "Retrying…" : view.retryBlocked ?? "Retry now"}
            </button>
          )}
          {view.state === "never" && url && (
            <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Open in GitHub
            </a>
          )}
          {view.state === "out_of_sync" && (
            <a href="https://www.githubstatus.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">
              githubstatus.com
            </a>
          )}
        </div>
        <p role="alert" className={failure ? "mt-2 text-danger" : "sr-only"}>
          {failure}
        </p>
      </div>
    </details>
  );
}
