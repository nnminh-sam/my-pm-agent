"use client";

import { useTransition } from "react";
import { setTaskStatus } from "@/app/actions";
import { PendingStatus, Spinner } from "@/components/pending";
import { TASK_STATUSES, type TaskStatus } from "@/lib/types";

export function StatusSelect({ id, status }: { id: string; status: TaskStatus }) {
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex items-center gap-1">
      <select
        // Remount when the server-side status changes (e.g. logging time moves todo → in_progress).
        key={status}
        aria-label={`Status of ${id}`}
        defaultValue={status}
        disabled={pending}
        aria-busy={pending || undefined}
        onChange={(e) => {
          const value = e.target.value;
          startTransition(() => setTaskStatus(id, value));
        }}
        className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs disabled:opacity-60"
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace("_", " ")}
          </option>
        ))}
      </select>
      {pending && <Spinner className="text-muted" />}
      <PendingStatus pending={pending} text="Updating…" />
    </span>
  );
}
