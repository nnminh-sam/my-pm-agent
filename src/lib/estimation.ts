import type { TaskMeta } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundQuarter = (n: number) => Math.round(n * 4) / 4;

/** Three-point (PERT) estimate: expected = (o + 4m + p) / 6, σ = (p − o) / 6. */
export function pert(optimistic: number, likely: number, pessimistic: number) {
  const [o, m, p] = [optimistic, likely, pessimistic];
  if (!(o <= m && m <= p)) throw new Error(`PERT estimate must satisfy optimistic ≤ likely ≤ pessimistic (got ${o}/${m}/${p})`);
  return { estimate: roundQuarter((o + 4 * m + p) / 6), estimate_range: [o, p] as [number, number] };
}

function sigma(task: TaskMeta) {
  return task.estimate_range ? (task.estimate_range[1] - task.estimate_range[0]) / 6 : 0;
}

/** Totals for a set of tasks (usually one milestone's). Cancelled tasks are ignored. */
export function rollup(tasks: TaskMeta[]) {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const counts: Record<string, number> = {};
  for (const t of live) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const estimated = live.filter((t) => t.estimate !== undefined);
  const total = estimated.reduce((sum, t) => sum + t.estimate!, 0);
  const spent = live.reduce((sum, t) => sum + t.spent, 0);
  const remaining = live
    .filter((t) => t.status !== "done" && t.estimate !== undefined)
    .reduce((sum, t) => sum + Math.max(t.estimate! - t.spent, 0), 0);
  // Independent tasks: variances add.
  const sd = Math.sqrt(estimated.reduce((sum, t) => sum + sigma(t) ** 2, 0));
  return {
    tasks: live.length,
    by_status: counts,
    unestimated: live.length - estimated.length,
    estimate_hours: round2(total),
    estimate_sd_hours: round2(sd),
    spent_hours: round2(spent),
    remaining_hours: round2(remaining),
    progress: total ? round2(live.filter((t) => t.status === "done").reduce((s, t) => s + (t.estimate ?? 0), 0) / total) : 0,
  };
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(tasks: TaskMeta[]) {
  const ratios = tasks.map((t) => t.spent / t.estimate!);
  const estimate = tasks.reduce((s, t) => s + t.estimate!, 0);
  const actual = tasks.reduce((s, t) => s + t.spent, 0);
  return {
    samples: tasks.length,
    estimated_hours: round2(estimate),
    actual_hours: round2(actual),
    /** actual ÷ estimated over all samples: > 1 means you under-estimate. */
    ratio: estimate ? round2(actual / estimate) : undefined,
    median_ratio: round2(median(ratios) ?? 0),
    within_25_percent: round2(ratios.filter((r) => r >= 0.75 && r <= 1.25).length / (ratios.length || 1)),
  };
}

/**
 * How accurate past estimates were, from done tasks that have both an estimate and logged time.
 * Agents should use this to calibrate new estimates and to suggest `settings.buffer`.
 */
export function estimationStats(tasks: TaskMeta[], recent = 20) {
  const samples = tasks
    .filter((t) => t.status === "done" && t.estimate && t.spent > 0)
    .sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  const overall = summarize(samples);
  const byTag: Record<string, ReturnType<typeof summarize>> = {};
  const tags = new Set(samples.flatMap((t) => t.tags));
  for (const tag of tags) {
    const tagged = samples.filter((t) => t.tags.includes(tag));
    if (tagged.length >= 2) byTag[tag] = summarize(tagged);
  }
  const suggestedBuffer =
    samples.length >= 5 && overall.ratio ? Math.min(Math.max(Math.round(overall.ratio * 20) / 20, 0.8), 2.5) : undefined;
  return {
    overall,
    by_tag: byTag,
    suggested_buffer: suggestedBuffer,
    note:
      samples.length < 5
        ? "Fewer than 5 completed tasks with logged time — calibration is not reliable yet. Log time with `log_time` to improve it."
        : "ratio = actual ÷ estimate. Multiply new estimates by the ratio for similar work, or set settings.buffer to suggested_buffer.",
    recent: samples.slice(0, recent).map((t) => ({
      code: t.code,
      title: t.title,
      tags: t.tags,
      estimate: t.estimate,
      actual: t.spent,
    })),
  };
}
