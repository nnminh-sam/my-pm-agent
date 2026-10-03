"use client";

import { startTransition, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveRecordAction, type SaveRecordState } from "@/app/actions";
import { copyText } from "@/components/copy-code";
import { PendingButton } from "@/components/pending";
// Type-only: record-markdown.ts is server code.
import type { RecordKind } from "@/lib/record-markdown";

const ROUTE: Record<RecordKind, string> = { task: "tasks", milestone: "milestones", project: "projects" };

const HINT: Record<RecordKind, string> = {
  task: "Frontmatter holds the fields; the text below it is the description. Remove priority to inherit the milestone's.",
  milestone: "Frontmatter holds the fields; the text below it is the spec. Remove priority to inherit the project's.",
  project: "Frontmatter holds the fields; the text below it is the description. Changing the code renames its milestones and tasks.",
};

/** The browser submits CRLF and the server normalizes it (record-edit.ts); neither is an edit. */
const same = (a: string, b: string) => a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");

const BUTTON = "rounded-lg border border-border bg-surface px-3 py-1 text-sm hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const PRIMARY =
  "rounded-lg bg-accent px-3 py-1 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 dark:text-black";

/**
 * A record's detail view with an Edit button that swaps it for the whole record as markdown (YAML frontmatter +
 * body, from toEditable), saved through saveRecordAction. `children` is the server-rendered read-only view;
 * `editable` is toEditable's text for the same render, and `code` the record's current code (a save that changes
 * it, e.g. a move or a project recode, navigates to the new URL).
 *
 * Renders a right-aligned toolbar row (Edit; Cancel/Save while editing) above the wrapped area. Saving sends the
 * text the session opened with as `base`, so an edit made elsewhere meanwhile (usually by an agent) is refused.
 */
export function RecordEditor({
  kind,
  id,
  code,
  editable,
  children,
}: {
  kind: RecordKind;
  id: string;
  code: string;
  editable: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  // null: read-only. `base` is the text the session opened with; `text` the user's edits.
  const [session, setSession] = useState<{ base: string; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const focusEdit = useRef(false);

  const [state, save, pending] = useActionState<SaveRecordState, FormData>(async (prev, formData) => {
    const result = await saveRecordAction(prev, formData);
    if (result?.ok) {
      // One transition: the editor closes when the fresh view arrives, not before (no flash of the old one).
      startTransition(() => {
        focusEdit.current = true;
        setSession(null);
        if (result.code !== code) router.replace(`/${ROUTE[kind]}/${result.code}`);
        else router.refresh();
      });
    }
    return result;
  }, null);
  // Errors belong to one session: a new one (Edit, Reload) hides the last result.
  const [dismissed, setDismissed] = useState<SaveRecordState>(null);
  // Feedback for "Copy my edits"; cleared by each save attempt (the stale panel only follows one).
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const result = state !== dismissed ? state : null;

  // A refresh brought newer text (Reload, or a revalidation after another action): an untouched session follows it.
  const [reloading, startReload] = useTransition();
  const [seen, setSeen] = useState(editable);
  if (seen !== editable) {
    setSeen(editable);
    if (session && same(session.text, session.base)) setSession({ base: editable, text: editable });
  }

  const dirty = session !== null && !same(session.text, session.base);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const start = () => {
    setDismissed(state);
    setSession({ base: editable, text: editable });
  };

  const cancel = () => {
    if (pending) return;
    if (dirty && !confirm("Discard your edits?")) return;
    focusEdit.current = true;
    setDismissed(state);
    setSession(null);
  };

  const reload = async () => {
    const copied = dirty && (await copyText(session.text));
    const message = !dirty
      ? "Load the latest version?"
      : copied
        ? "Load the latest version? Your edits are replaced; they were copied to the clipboard."
        : "Load the latest version? Your edits will be lost.";
    if (!confirm(message)) return;
    setDismissed(state);
    // Untouched, so the fresh `editable` from the refresh replaces it (see above).
    setSession({ base: editable, text: editable });
    startReload(() => router.refresh());
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!session || pending) return;
    setCopyNote(null);
    // Built here rather than from hidden inputs so `base` keeps its exact text (and no form reset after the action).
    const formData = new FormData();
    formData.set("kind", kind);
    formData.set("id", id);
    formData.set("base", session.base);
    formData.set("text", session.text);
    startTransition(() => save(formData));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (!session) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-end gap-3">
          {result?.ok && (
            <span role="status" className="text-xs text-muted">
              {result.changed ? "Saved" : "No changes"}
            </span>
          )}
          <button
            type="button"
            onClick={start}
            ref={(el) => {
              if (el && focusEdit.current) {
                focusEdit.current = false;
                el.focus();
              }
            }}
            className={BUTTON}
          >
            Edit
          </button>
        </div>
        {children}
      </div>
    );
  }

  const errors = result && !result.ok ? result : null;
  return (
    <form ref={formRef} onSubmit={submit} onKeyDown={onKeyDown} className="space-y-3">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 bg-bg px-1 py-1">
        <span className="mr-auto text-xs text-muted">
          <kbd className="font-sans">⌘/Ctrl+Enter</kbd> saves, <kbd className="font-sans">Esc</kbd> cancels
        </span>
        <button type="button" onClick={cancel} disabled={pending} className={BUTTON}>
          Cancel
        </button>
        <PendingButton type="submit" pending={pending} pendingText="Saving…" className={PRIMARY}>
          Save
        </PendingButton>
      </div>

      {errors?.stale ? (
        <div role="alert" className="space-y-2 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm">
          <div className="font-medium text-danger">Changed elsewhere</div>
          {errors.errors.map((error, i) => (
            <p key={i}>{error}</p>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => setCopyNote((await copyText(session.text)) ? "Copied" : "Couldn't copy; select the text and copy it yourself.")}
              className={BUTTON}
            >
              Copy my edits
            </button>
            <PendingButton type="button" onClick={reload} pending={reloading} pendingText="Reloading…" className={BUTTON}>
              Reload
            </PendingButton>
            <span role="status" className="self-center text-xs text-muted">
              {copyNote}
            </span>
          </div>
        </div>
      ) : (
        errors && (
          <div role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm">
            <div className="font-medium text-danger">Not saved</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {errors.errors.map((error, i) => (
                <li key={i} className="whitespace-pre-wrap">
                  {error}
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      <p className="text-xs text-muted">{HINT[kind]}</p>
      <textarea
        name="text"
        value={session.text}
        onChange={(e) => setSession({ base: session.base, text: e.target.value })}
        readOnly={pending}
        autoFocus
        spellCheck={false}
        aria-label={`${code} as markdown`}
        aria-invalid={errors ? true : undefined}
        className="block min-h-[60vh] w-full resize-y rounded-xl border border-border bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed field-sizing-content focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent/40 read-only:opacity-70"
      />
    </form>
  );
}
