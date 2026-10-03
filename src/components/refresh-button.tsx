"use client";

import { Suspense, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PendingButton } from "@/components/pending";
import { relativeTime } from "@/lib/github/sync-view";

/**
 * Does a keydown press the refresh shortcut? A bare `r`: no modifiers, no auto-repeat, and the focus isn't somewhere
 * the user types (input, textarea, select, contenteditable) or a composition in progress. Pure, for tests (PF-3.4).
 */
export function isRefreshShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: unknown;
}): boolean {
  if (e.key !== "r" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.isComposing || e.defaultPrevented) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = t?.tagName?.toLowerCase();
  return !(tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable);
}

function Refresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // When the data on screen was fetched: page load, each finished refresh, each navigation (a fresh render: the parent re-keys this on navigation).
  const [at, setAt] = useState(() => Date.now());
  const [clock, setClock] = useState(at);
  // Reset on each finished refresh (the `true -> false` edge of `pending`).
  const wasPending = useRef(false);
  useEffect(() => {
    const finished = wasPending.current && !pending;
    wasPending.current = pending;
    if (!finished) return;
    const now = Date.now();
    setAt(now);
    setClock(now);
  }, [pending]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = () => startTransition(() => router.refresh());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isRefreshShortcut(e)) return;
      e.preventDefault();
      refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span className="flex items-center gap-1.5">
      <span data-refreshed-at="" className="text-xs text-muted">
        Updated {relativeTime(new Date(at).toISOString(), new Date(Math.max(clock, at)))}
      </span>
      <PendingButton
        type="button"
        onClick={refresh}
        pending={pending}
        pendingText="Refreshing…"
        title="Refresh (r)"
        aria-keyshortcuts="r"
        className="rounded px-2 py-1 text-muted hover:bg-bg hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        Refresh
      </PendingButton>
    </span>
  );
}

/** Remounted on every navigation (path or query), which restarts the age of the data. */
function ByPlace() {
  const place = `${usePathname()}?${useSearchParams().toString()}`;
  return <Refresh key={place} />;
}

/** Re-renders the server components of the current page, keeping client state (filters, scroll, open editors). */
export function RefreshButton() {
  return (
    <Suspense fallback={null}>
      <ByPlace />
    </Suspense>
  );
}
