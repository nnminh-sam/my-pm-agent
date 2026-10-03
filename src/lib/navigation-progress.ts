/**
 * Which App Router navigation is in flight, if any: started by onRouterTransitionStart (src/instrumentation-client.ts),
 * finished by NavigationProgress when the new URL commits. Browser-only module state.
 */

type Listener = () => void;

let current: string | null = null;
let skeletons = 0;
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

/**
 * A loading skeleton is showing. With a prefetched loading state the URL commits before the page arrives, so the
 * navigation only ends once no skeleton is left. Returns the unmount cleanup.
 */
export function skeletonMounted() {
  skeletons++;
  return () => {
    skeletons--;
    if (skeletons === 0) finishNavigation();
  };
}

/**
 * The new URL committed: the navigation is over unless a skeleton stands in for the page. The skeleton can commit a
 * moment after the URL does, so look again after a short settle.
 */
export function urlCommitted() {
  const target = current;
  if (target === null) return;
  setTimeout(() => {
    if (current === target && skeletons === 0) finishNavigation();
  }, 50);
}

export function subscribeNavigation(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
