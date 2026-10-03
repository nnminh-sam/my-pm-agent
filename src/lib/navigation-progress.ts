/**
 * Which App Router navigation is in flight, if any: started by onRouterTransitionStart (src/instrumentation-client.ts),
 * finished by NavigationProgress when the new URL commits. Browser-only module state.
 */

type Listener = () => void;

let current: string | null = null;
let fallback: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();

const emit = () => listeners.forEach((l) => l());
const withoutHash = (url: URL) => url.href.replace(/#.*$/, "");

export function startNavigation(url: string) {
  if (typeof window === "undefined") return;
  const target = new URL(url, window.location.href);
  // A hash-only change or the same URL never commits a new route.
  if (withoutHash(target) === withoutHash(new URL(window.location.href))) return;
  current = target.href;
  clearTimeout(fallback);
  // Never leave the bar up forever if a navigation is dropped without committing.
  fallback = setTimeout(finishNavigation, 30_000);
  emit();
}

export function finishNavigation() {
  clearTimeout(fallback);
  if (current === null) return;
  current = null;
  emit();
}

export const getNavigation = () => current;

export function subscribeNavigation(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
