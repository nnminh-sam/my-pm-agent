import { addDays, daysBetween, weekday } from "./time";
import { WEEKDAYS } from "./types";

/**
 * Linear time axis for the Gantt chart. Dates are plain `YYYY-MM-DD` strings and times are
 * `HH:MM` in the user's timezone (the same wall-clock values the scheduler emits), so no
 * timezone conversion happens here and days are always 24h — nothing to get wrong around DST.
 *
 * Bars and ticks share one map (`toX`), so they align by construction; gaps outside working
 * hours are simply stretches of the axis without a bar.
 */

export const UNITS = ["week", "day", "hour", "minute"] as const;
export type Unit = (typeof UNITS)[number];

export interface TimePoint {
  date: string;
  /** "HH:MM"; midnight when omitted. */
  time?: string;
}

export interface Tick {
  x: number;
  width: number;
  label: string;
}

export interface TimeScale {
  unit: Unit;
  /** First date on the axis (a Monday for the week unit). */
  start: string;
  /** Exclusive end date. */
  end: string;
  pxPerMinute: number;
  /** Total axis width in px. */
  width: number;
  /** Coarse header row (months / weeks / days / hours). */
  major: Tick[];
  /** Fine header row: one tick per week / day / hour, or per 5 minutes for the minute unit. */
  minor: Tick[];
  toX(point: TimePoint | string): number;
  /** Pixel width of the span between two points (zero-clamped). */
  spanWidth(from: TimePoint, to: TimePoint): number;
  /** Inverse of `toX`, to the minute, clamped to the axis. */
  pointAt(x: number): { date: string; time: string };
}

const DAY = 1440;

/** Pixel density and minor tick size per unit. */
const CONFIG: Record<Unit, { pxPerMinute: number; minorMinutes: number }> = {
  week: { pxPerMinute: 20 / DAY, minorMinutes: 7 * DAY }, // 20px a day
  day: { pxPerMinute: 48 / DAY, minorMinutes: DAY }, // 48px a day
  hour: { pxPerMinute: 64 / 60, minorMinutes: 60 }, // 64px an hour
  minute: { pxPerMinute: 8, minorMinutes: 5 }, // 40px per 5-minute tick, wide enough for "09:05"
};

const minutesOf = (time = "00:00") => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -((WEEKDAYS.indexOf(weekday(date)) + 6) % 7));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const parts = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return { year: y, month: MONTHS[m - 1], day: d, weekday: DAYS[WEEKDAYS.indexOf(weekday(date))] };
};
/** "28 Sep" */
const dayMonth = (date: string) => `${parts(date).day} ${parts(date).month}`;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Scale for the inclusive date range `from`..`to`. The week unit snaps outwards to whole
 * Monday-to-Sunday weeks so tick columns are never cut off.
 */
export function makeScale(unit: Unit, from: string, to: string): TimeScale {
  if (to < from) [from, to] = [to, from];
  const start = unit === "week" ? weekStart(from) : from;
  const end = addDays(unit === "week" ? weekStart(to) : to, unit === "week" ? 7 : 1);
  const { pxPerMinute, minorMinutes } = CONFIG[unit];
  const total = daysBetween(start, end) * DAY;
  const px = (minutes: number) => minutes * pxPerMinute;
  const dateAt = (offset: number) => addDays(start, Math.floor(offset / DAY));

  const toX = (point: TimePoint | string) => {
    const p = typeof point === "string" ? { date: point } : point;
    return px(daysBetween(start, p.date) * DAY + minutesOf(p.time));
  };

  const minor: Tick[] = [];
  for (let off = 0; off < total; off += minorMinutes) {
    const d = dateAt(off);
    const mins = off % DAY;
    const label =
      unit === "week"
        ? dayMonth(d)
        : unit === "day"
          ? `${parts(d).weekday} ${parts(d).day}`
          : `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    minor.push({ x: px(off), width: px(minorMinutes), label });
  }

  // Major segments begin at each boundary offset (plus the axis start) and run to the next one.
  const boundaries: number[] = [0];
  const majorStep = unit === "minute" ? 60 : DAY;
  for (let off = majorStep; off < total; off += majorStep) {
    const d = dateAt(off);
    const isBoundary =
      unit === "week" ? d.endsWith("-01") : unit === "day" ? weekStart(d) === d : true; // hour → each day, minute → each hour
    if (isBoundary) boundaries.push(off);
  }
  const major = boundaries.map((off, i): Tick => {
    const d = dateAt(off);
    const label =
      unit === "week"
        ? `${parts(d).month} ${parts(d).year}`
        : unit === "day"
          ? `Week of ${dayMonth(weekStart(d))}`
          : unit === "hour"
            ? `${parts(d).weekday} ${dayMonth(d)}`
            : `${pad(Math.floor((off % DAY) / 60))}:00`;
    const next = boundaries[i + 1] ?? total;
    return { x: px(off), width: px(next - off), label };
  });

  return {
    unit,
    start,
    end,
    pxPerMinute,
    width: px(total),
    major,
    minor,
    toX,
    spanWidth: (a, b) => Math.max(0, toX(b) - toX(a)),
    pointAt: (x) => {
      const off = Math.min(Math.max(Math.round(x / pxPerMinute), 0), total - 1);
      const mins = off % DAY;
      return { date: dateAt(off), time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` };
    },
  };
}

/**
 * Days shown either side of the view centre in the dense units. A 90-day minute axis would be
 * hundreds of thousands of pixels and thousands of ticks; the other units show the whole range.
 */
export const VIEW_RADIUS_DAYS: Partial<Record<Unit, number>> = { hour: 14, minute: 1 };

/** Scale to render for a view centred on `center`, within the inclusive range `from`..`to`. */
export function viewScale(unit: Unit, from: string, to: string, center: TimePoint): TimeScale {
  if (to < from) [from, to] = [to, from];
  const radius = VIEW_RADIUS_DAYS[unit];
  if (radius === undefined) return makeScale(unit, from, to);
  const c = center.date < from ? from : center.date > to ? to : center.date;
  const lo = addDays(c, -radius);
  const hi = addDays(c, radius);
  return makeScale(unit, lo < from ? from : lo, hi > to ? to : hi);
}

/** Move `point` onto the axis if it falls outside it. */
export function clampToScale(scale: TimeScale, point: TimePoint): { date: string; time: string } {
  if (point.date < scale.start) return { date: scale.start, time: "00:00" };
  if (point.date >= scale.end) return { date: addDays(scale.end, -1), time: "23:59" };
  return { date: point.date, time: point.time ?? "00:00" };
}
