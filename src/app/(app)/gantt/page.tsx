import { GanttChart } from "@/components/gantt-chart";
import { GanttFilters } from "@/components/gantt-filters";
import { ganttRange, ganttRows, milestoneOptions, parseGanttQuery } from "@/lib/gantt";
import { scheduleFor } from "@/lib/planning";
import { loadWorkspace } from "@/lib/repo";
import { fmtTime, nowIn } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function GanttPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ws = await loadWorkspace();
  const { filters, unit, at } = parseGanttQuery(await searchParams, ws);
  const rows = ganttRows(scheduleFor(ws), ws, filters);
  const clock = nowIn(ws.settings.timezone);
  const now = { date: clock.date, time: fmtTime(clock.minutes) };
  const range = ganttRange(rows, clock.date, filters);

  // Filters to keep when the unit switcher rewrites the URL.
  const keep = new URLSearchParams();
  filters.projects.forEach((p) => keep.append("project", p));
  filters.milestones.forEach((m) => keep.append("milestone", m));
  if (filters.from) keep.set("from", filters.from);
  if (filters.to) keep.set("to", filters.to);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Gantt</h1>
      <GanttFilters
        projects={ws.projects.map((p) => ({ code: p.code, title: p.title }))}
        milestones={milestoneOptions(ws.milestones, ws.projects, filters.projects).map((m) => ({ code: m.code, title: m.title }))}
        selected={filters}
        unit={unit}
      />
      <GanttChart
        rows={rows}
        unit={unit}
        from={range.from}
        to={range.to}
        center={at ?? now}
        now={now}
        query={keep.toString()}
      />
    </div>
  );
}
