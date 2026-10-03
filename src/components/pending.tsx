"use client";

import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import { getNavigation, skeletonMounted, subscribeNavigation, urlCommitted } from "@/lib/navigation-progress";

/**
 * Pending feedback shared by every call site (docs/features/pending-feedback): a spinner, buttons that turn pending
 * while their server action runs, the page skeleton and the top navigation progress bar.
 */

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/** Inline spinner. Hidden from assistive technology; static under prefers-reduced-motion (PF-1.6). */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-spinner=""
      className={cx(
        "inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px] motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/** Visually hidden live status naming the pending action (PF-1.5); empty while idle. */
export function PendingStatus({ pending, text }: { pending: boolean; text: string }) {
  return (
    <span role="status" className="sr-only">
      {pending ? text : ""}
    </span>
  );
}

const BUTTON_BASE = "inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-60";

export type PendingButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  /** Visually hidden status while pending, e.g. "Saving…". */
  pendingText: string;
};

/**
 * A button whose pending state comes from the caller (useTransition / useActionState). While pending it is disabled
 * (so it can't be used twice), aria-busy, and shows a spinner and the status text.
 */
export function PendingButton({ pending, pendingText, className, children, disabled, onClick, ...rest }: PendingButtonProps) {
  return (
    <>
      <button
        {...rest}
        disabled={pending || disabled}
        aria-busy={pending || undefined}
        onClick={(e) => {
          if (pending) return e.preventDefault();
          onClick?.(e);
        }}
        className={cx(BUTTON_BASE, className)}
      >
        {children}
        {pending && <Spinner />}
      </button>
      <PendingStatus pending={pending} text={pendingText} />
    </>
  );
}

/** Submit button of a `<form action={serverAction}>`: pending while that form's action runs (useFormStatus). */
export function SubmitButton(props: Omit<PendingButtonProps, "pending" | "type">) {
  const { pending } = useFormStatus();
  return <PendingButton {...props} type="submit" pending={pending} />;
}

const BAR_DELAY_MS = 150;

/** True once `active` has stayed true for 150 ms (PF-2a: fast navigations don't flash). */
function useDelayed(active: boolean) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setShown(true), BAR_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [active]);
  return active && shown;
}

/** `kind` tells the router-driven bar from the skeleton's own one. */
function Bar({ kind }: { kind: "router" | "skeleton" }) {
  return (
    <div aria-hidden="true" data-navigation-progress={kind} className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-accent-soft">
      <div className="h-full w-1/3 animate-[nav-progress_1.2s_ease-in-out_infinite] bg-accent motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  );
}

/** A bar shown 150 ms after mount, for as long as it's mounted. */
function DelayedBar() {
  return useDelayed(true) ? <Bar kind="skeleton" /> : null;
}

function NavigationWatcher() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // The new URL committed (also on an error page, PF-2b); a skeleton still showing ends it when it unmounts.
  useEffect(() => urlCommitted(), [pathname, search]);
  const navigation = useSyncExternalStore(subscribeNavigation, getNavigation, () => null);
  return useDelayed(navigation !== null) ? <Bar kind="router" /> : null;
}

/** The top progress bar for App Router navigations, started by onRouterTransitionStart (src/instrumentation-client.ts). */
export function NavigationProgress() {
  return (
    <Suspense fallback={null}>
      <NavigationWatcher />
    </Suspense>
  );
}

/** The page area while a route segment loads (loading.tsx): skeleton blocks, aria-busy, a "Loading…" status. */
export function PageSkeleton() {
  useEffect(() => skeletonMounted(), []);
  return (
    <div aria-busy="true" data-page-skeleton="" className="space-y-4">
      <DelayedBar />
      <span role="status" className="sr-only">
        Loading…
      </span>
      <div aria-hidden="true" className="animate-pulse space-y-4 motion-reduce:animate-none">
        <div className="h-6 w-1/3 rounded bg-border" />
        <div className="h-4 w-2/3 rounded bg-border" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="h-16 rounded-lg bg-border" />
          <div className="h-16 rounded-lg bg-border" />
          <div className="h-16 rounded-lg bg-border" />
        </div>
        <div className="h-48 rounded-xl bg-border" />
      </div>
    </div>
  );
}
