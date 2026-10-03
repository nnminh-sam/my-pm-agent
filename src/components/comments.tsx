"use client";

import { useActionState, useState, useTransition } from "react";
import { addCommentAction, deleteCommentAction } from "@/app/actions";
import { PendingButton } from "@/components/pending";
import { formatWhen } from "@/lib/github/sync-view";
import type { CommentResult } from "@/lib/comment-input";
import type { TaskComment } from "@/lib/types";

/**
 * A comment body as escaped text with its line breaks kept: React escapes the strings, and each line break becomes a
 * <br/>. No markdown, no autolinking, never dangerouslySetInnerHTML.
 */
export function CommentText({ body }: { body: string }) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  return (
    <p className="text-sm break-words">
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {line}
        </span>
      ))}
    </p>
  );
}

/**
 * A task's comments, oldest first, with add and delete (author "you"). Both actions return `{ ok, message }`, shown
 * here: production redacts thrown errors.
 */
export function Comments({ taskId, comments }: { taskId: string; comments: TaskComment[] }) {
  const [added, add, adding] = useActionState<CommentResult | null, FormData>(addCommentAction, null);
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const remove = (commentId: string) => {
    setDeleting(commentId);
    startTransition(async () => {
      try {
        const result = await deleteCommentAction(taskId, commentId);
        setFailure(result.ok ? null : result.message);
      } catch {
        setFailure("Couldn't delete the comment");
      }
      setDeleting(null);
    });
  };

  return (
    <div className="space-y-3">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
        Comments <span className="font-normal">({comments.length})</span>
      </h2>
      {comments.length > 0 && (
        <ul className="divide-y divide-border">
          {comments.map((c) => (
            <li key={c.id} className="py-2 first:pt-0">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                <span className="font-medium text-fg">{c.author}</span>
                <time dateTime={c.created_at}>{formatWhen(c.created_at)}</time>
                <span className="ml-auto">
                  <PendingButton
                    type="button"
                    onClick={() => remove(c.id)}
                    pending={pending && deleting === c.id}
                    pendingText="Deleting…"
                    disabled={pending}
                    className="hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Delete
                  </PendingButton>
                </span>
              </div>
              <CommentText body={c.body} />
            </li>
          ))}
        </ul>
      )}
      <form action={add} className="space-y-2">
        <input type="hidden" name="id" value={taskId} />
        <textarea
          name="body"
          required
          rows={3}
          maxLength={10_000}
          placeholder="Add a comment (plain text)"
          aria-label="Add a comment"
          className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
        />
        <div className="flex items-center gap-3">
          <PendingButton pending={adding} pendingText="Adding…" className="rounded bg-accent px-3 py-1 text-sm font-medium text-white dark:text-black">
            Comment
          </PendingButton>
          <p role="alert" className="text-xs text-danger">
            {failure ?? (added && !added.ok ? added.message : null)}
          </p>
        </div>
      </form>
    </div>
  );
}
