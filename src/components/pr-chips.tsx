import { prChip } from "@/lib/github/pr-view";
import type { PrEntry } from "@/lib/mcp/task-github";
import { Badge } from "./ui";

/**
 * A small chip per PR of a task, e.g. `PR #123 · approved` or `PR #123 · merged`, from snapshots only (never GitHub).
 * An amber dot marks a snapshot that is out of sync; details are on the task page. Links are built from the ref.
 */
export function PrChips({ entries, now }: { entries: PrEntry[]; now: Date }) {
  if (!entries.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {entries.map((entry) => {
        const chip = prChip(entry, now);
        const body = (
          <Badge tone={chip.tone} title={chip.title}>
            {chip.text}
            {chip.outOfSync && (
              <>
                <span aria-hidden className="ml-1 inline-block size-1.5 rounded-full bg-warn" />
                <span className="sr-only"> (out of sync)</span>
              </>
            )}
          </Badge>
        );
        return chip.href ? (
          <a key={entry.ref} href={chip.href} target="_blank" rel="noreferrer">
            {body}
          </a>
        ) : (
          <span key={entry.ref}>{body}</span>
        );
      })}
    </span>
  );
}
