import type { MilestoneMeta, Priority, ProjectMeta, ProjectStatus } from "./types";

/**
 * Project → Milestone → Task. A task belongs to a project through its milestone;
 * priority and deadline are inherited downwards when a level doesn't set its own.
 */

export interface Lookup {
  milestones: Map<string, MilestoneMeta>;
  projects: Map<string, ProjectMeta>;
}

export function lookup(milestones: MilestoneMeta[] = [], projects: ProjectMeta[] = []): Lookup {
  return { milestones: new Map(milestones.map((m) => [m.id, m])), projects: new Map(projects.map((p) => [p.id, p])) };
}

export function lineage(task: { milestone: string }, { milestones, projects }: Lookup) {
  const milestone = milestones.get(task.milestone);
  const project = milestone ? projects.get(milestone.project) : undefined;
  return { milestone, project };
}

export function inheritedPriority(...levels: (Priority | undefined)[]): Priority {
  return levels.find((p) => p !== undefined) ?? "P2";
}

export function earliestDate(...dates: (string | undefined)[]): string | undefined {
  return dates.filter((d): d is string => Boolean(d)).sort()[0];
}

const SCHEDULABLE_PROJECT: ProjectStatus[] = ["planned", "active"];

/** Why a project keeps its tasks off the schedule, if it does. */
export function projectHold(project?: ProjectMeta): string | undefined {
  if (!project || SCHEDULABLE_PROJECT.includes(project.status)) return undefined;
  return `project ${project.code} is ${project.status.replace("_", " ")}`;
}
