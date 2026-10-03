import { startNavigation } from "@/lib/navigation-progress";

/** Starts the top progress bar (NavigationProgress) for every App Router navigation (PF-2). */
export function onRouterTransitionStart(url: string) {
  startNavigation(url);
}
