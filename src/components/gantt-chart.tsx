"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GanttProject, GanttTask } from "@/lib/gantt";
import { dependencyArrows, deadlineX, groupSpan, nowX, segment, taskSegments, taskTooltip, visibleRows } from "@/lib/gantt-layout";
import { addDays, fmtDay } from "@/lib/time";
import { clampToScale, UNITS, VIEW_RADIUS_DAYS, viewScale, type TimeScale, type Unit } from "@/lib/timescale";

/** Label column width: wide on desktop, narrow on a phone so the timeline keeps room. */
const LABEL_W_WIDE = 240;
const LABEL_W_NARROW = 132;
const NARROW_BELOW = 640;
const ROW_H = 32;
const HEAD_H = 24;

/**
 * Timeline frame: two-level sticky header, vertical grid and a sticky label column, scrolling
 * horizontally. The unit lives in the URL; switching unit sends the timestamp at the middle of the
 * viewport as `at`, and the next render scrolls that timestamp back to the middle.
 */
export function GanttChart(props: {
  rows: GanttProject[];
  unit: Unit;
  from: string;
  to: string;
  /** View centre: the `at` param, else "now". */
  center: { date: string; time: string };
  now: { date: string; time: string };
  /** Filter params to keep when switching unit (already URL-encoded, no unit/at). */
  query: string;
}) {
  const { rows, unit, from, to, center, now, query } = props;
  const router = useRouter();
  const scroller = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const scale = useMemo(() => viewScale(unit, from, to, center), [unit, from, to, center]);
  const mid = clampToScale(scale, center);
  const midKey = `${mid.date}T${mid.time}`;
  const [hovered, setHovered] = useState<string | null>(null);
  const [LABEL_W, setLabelW] = useState(LABEL_W_WIDE);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setLabelW(el.clientWidth < NARROW_BELOW ? LABEL_W_NARROW : LABEL_W_WIDE);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bring the centre timestamp to the middle of the visible timeline (right of the label column).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = scale.toX(mid) - (el.clientWidth - LABEL_W) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, midKey, from, to, LABEL_W]);

  const go = (next: Unit, at: { date: string; time: string }) => {
    const params = new URLSearchParams(query);
    params.set("unit", next);
    params.set("at", `${at.date}T${at.time}`);
    router.replace(`/gantt?${params}`, { scroll: false });
  };
  const viewCentre = () => {
    const el = scroller.current;
    // An axis narrower than the viewport can't scroll, so its middle isn't where the user is looking.
    if (!el || scale.width <= el.clientWidth - LABEL_W) return mid;
    return scale.pointAt(el.scrollLeft + (el.clientWidth - LABEL_W) / 2);
  };
  const switchUnit = (next: Unit) => next !== unit && go(next, viewCentre());
  // Hour and minute views show a window around the centre; these page it by a window's radius.
  const radius = VIEW_RADIUS_DAYS[unit];
  const page = (dir: -1 | 1) => {
    if (radius === undefined) return;
    const c = viewCentre();
    const date = addDays(c.date, dir * radius);
    go(unit, { date: date < from ? from : date > to ? to : date, time: c.time });
  };

  const list = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const arrows = useMemo(() => dependencyArrows(list, scale, ROW_H), [list, scale]);

  const grid = {
    backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px)",
    backgroundSize: `${scale.minor[0]?.width ?? scale.width}px 100%`,
  };
  const width = LABEL_W + scale.width;
  const todayX = nowX(now, scale);
  const label = "sticky left-0 z-10 flex items-center overflow-hidden border-r border-border bg-surface px-3 text-sm";

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Time unit" className="inline-flex overflow-hidden rounded border border-border text-sm">
        {UNITS.map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={u === unit}
            onClick={() => switchUnit(u)}
            className={`px-3 py-1 capitalize ${u === unit ? "bg-accent text-bg" : "bg-surface text-muted hover:text-fg"}`}
          >
            {u}
          </button>
        ))}
      </div>
      {radius !== undefined && (
        <div className="ml-2 inline-flex gap-1 text-sm">
          <button type="button" onClick={() => page(-1)} className="rounded border border-border bg-surface px-2 py-1 text-muted hover:text-fg" aria-label="Earlier">
            ←
          </button>
          <button type="button" onClick={() => page(1)} className="rounded border border-border bg-surface px-2 py-1 text-muted hover:text-fg" aria-label="Later">
            →
          </button>
        </div>
      )}

      <div ref={scroller} className="max-h-[75vh] overflow-auto rounded-lg border border-border bg-surface" data-testid="gantt-scroller">
        <div className="relative" style={{ width }}>
          {/* Header: sticky to the top; its corner is also sticky to the left. */}
          <div className="sticky top-0 z-20 border-b border-border bg-surface" style={{ height: HEAD_H * 2 + 1 }}>
            <div className={`${label} absolute top-0 left-0 z-30 h-full text-xs text-muted`} style={{ width: LABEL_W }}>
              Project / milestone / task
            </div>
            {[scale.major, scale.minor].map((ticks, level) => (
              <div key={level} className="absolute" style={{ left: LABEL_W, top: level * HEAD_H, height: HEAD_H, width: scale.width }}>
                {ticks.map((t) => (
                  <div
                    key={t.x}
                    className={`absolute top-0 h-full overflow-clip border-l border-border ${level ? "truncate px-0.5 text-[10px] text-muted" : "px-1 font-medium text-[11px]"} leading-6`}
                    style={{ left: t.x, width: t.width }}
                    title={t.label}
                  >
                    {/* Major labels stay in view (just right of the label column) while their span is on screen. */}
                    {level ? t.label : <span className="sticky inline-block whitespace-nowrap" style={{ left: LABEL_W + 4 }}>{t.label}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {rows.length === 0 && <p className="sticky left-0 px-4 py-6 text-sm text-muted">No scheduled tasks match these filters.</p>}

          {list.map((row) => {
            if (row.kind === "project") {
              const { project } = row;
              return (
                <Row
                  key={row.key}
                  grid={grid}
                  labelW={LABEL_W}
                  labelClass={`${label} gap-1 font-semibold`}
                  lane={<Group scale={scale} tasks={project.milestones.flatMap((m) => m.tasks)} deadline={project.deadline} what="Project deadline" />}
                >
                  <Toggle open={!collapsed.has(row.key)} onClick={() => toggle(row.key)} name={project.title} />
                  <Link href={`/projects/${project.code}`} className="truncate hover:underline">
                    <span className="mr-1.5 font-mono text-xs font-normal text-muted">{project.code}</span>
                    {project.title}
                  </Link>
                </Row>
              );
            }
            if (row.kind === "milestone") {
              const { milestone } = row;
              return (
                <Row
                  key={row.key}
                  grid={grid}
                  labelW={LABEL_W}
                  labelClass={`${label} gap-1 pl-4 font-medium sm:pl-6`}
                  lane={<Group scale={scale} tasks={milestone.tasks} deadline={milestone.deadline} what="Milestone deadline" />}
                >
                  <Toggle open={!collapsed.has(row.key)} onClick={() => toggle(row.key)} name={milestone.title} />
                  <Link href={`/milestones/${milestone.code}`} className="truncate hover:underline">
                    <span className="mr-1.5 font-mono text-xs font-normal text-muted">{milestone.code}</span>
                    {milestone.title}
                  </Link>
                </Row>
              );
            }
            const { task } = row;
            return (
              <Row
                key={row.key}
                grid={grid}
                labelW={LABEL_W}
                labelClass={`${label} pl-6 sm:pl-12`}
                lane={<Bars task={task} scale={scale} />}
                onHover={(on) => setHovered(on ? task.id : null)}
              >
                <Link href={`/tasks/${task.code}`} className="truncate hover:underline" title={taskTooltip(task)}>
                  <span className={`mr-1.5 font-mono text-xs ${task.at_risk ? "text-danger" : "text-muted"}`}>{task.code}</span>
                  {task.title}
                </Link>
              </Row>
            );
          })}

          {arrows.length > 0 && (
            <svg
              aria-hidden
              className="pointer-events-none absolute z-[3] overflow-visible text-muted"
              style={{ left: LABEL_W, top: HEAD_H * 2 + 1 }}
              width={scale.width}
              height={list.length * ROW_H}
            >
              <defs>
                <marker id="gantt-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0 L6 3 L0 6 z" fill="currentColor" />
                </marker>
              </defs>
              {arrows.map((a) => {
                const k = Math.min(24, Math.max(8, Math.abs(a.x2 - a.x1) / 2));
                // Faint by default so dense plans stay readable; a hovered task lights up its own links.
                const on = hovered === a.from || hovered === a.to;
                return (
                  <path
                    key={`${a.from}>${a.to}`}
                    d={`M${a.x1} ${a.y1} C${a.x1 + k} ${a.y1} ${a.x2 - k} ${a.y2} ${a.x2} ${a.y2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={on ? 1.5 : 1}
                    opacity={on ? 1 : hovered ? 0.15 : 0.35}
                    markerEnd="url(#gantt-arrow)"
                  />
                );
              })}
            </svg>
          )}

          {todayX !== undefined && (
            <div
              aria-label={`Today, ${fmtDay(now.date)} ${now.time}`}
              className="pointer-events-none absolute z-[5] w-px bg-danger"
              style={{ left: LABEL_W + todayX, top: HEAD_H * 2 + 1, bottom: 0 }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const PRIORITY_FILL = { P0: "bg-danger", P1: "bg-warn", P2: "bg-accent", P3: "bg-muted" } as const;

function Toggle({ open, onClick, name }: { open: boolean; onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
      className="w-5 flex-none text-xs text-muted hover:text-fg"
    >
      {open ? "▾" : "▸"}
    </button>
  );
}

/** One task: a bar per work block (or a single span in week/day view), plus its deadline marker. */
function Bars({ task, scale }: { task: GanttTask; scale: TimeScale }) {
  const tip = taskTooltip(task);
  const due = deadlineX(task.deadline, scale);
  return (
    <>
      {taskSegments(task, scale).map((seg, i) => (
        <Link
          key={i}
          href={`/tasks/${task.code}`}
          title={tip}
          aria-label={tip.replaceAll("\n", ", ")}
          className={`absolute top-1.5 h-5 rounded-sm ${PRIORITY_FILL[task.priority]} ${task.status === "in_progress" ? "" : "opacity-70"} ${task.at_risk ? "ring-2 ring-danger ring-offset-1 ring-offset-surface" : ""} hover:opacity-100`}
          style={{ left: seg.x, width: seg.width }}
        />
      ))}
      {due !== undefined && (
        <Diamond x={due} tone={task.at_risk ? "bg-danger" : "bg-fg"} title={`Due ${fmtDay(task.deadline!)}${task.at_risk ? ` — ${task.late_days}d late` : ""}`} />
      )}
    </>
  );
}

/** Project / milestone row: a thin summary bar over all its tasks, and its own deadline. */
function Group({ scale, tasks, deadline, what }: { scale: TimeScale; tasks: GanttTask[]; deadline?: string; what: string }) {
  const span = groupSpan(tasks);
  const seg = span && segment(scale, span.start, span.end);
  const due = deadlineX(deadline, scale);
  return (
    <>
      {seg && <div className="absolute top-3.5 h-1.5 rounded-full bg-muted/60" style={{ left: seg.x, width: seg.width }} />}
      {due !== undefined && <Diamond x={due} tone="bg-fg" title={`${what}: ${fmtDay(deadline!)}`} />}
    </>
  );
}

function Diamond({ x, tone, title }: { x: number; tone: string; title: string }) {
  return (
    <span
      title={title}
      role="img"
      aria-label={title}
      className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 ${tone}`}
      style={{ left: x }}
    />
  );
}

function Row(props: {
  grid: React.CSSProperties;
  labelW: number;
  labelClass: string;
  lane: React.ReactNode;
  onHover?: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex border-b border-border"
      style={{ height: ROW_H }}
      onMouseEnter={props.onHover && (() => props.onHover?.(true))}
      onMouseLeave={props.onHover && (() => props.onHover?.(false))}
    >
      <div className={props.labelClass} style={{ width: props.labelW, flex: "none" }}>
        {props.children}
      </div>
      <div className="relative flex-1" style={props.grid}>
        {props.lane}
      </div>
    </div>
  );
}
