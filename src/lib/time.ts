import { WEEKDAYS, type Weekday } from "./types";

/** Dates are plain `YYYY-MM-DD` strings in the user's timezone; times are minutes after midnight. */

export function nowIn(timeZone: string, at: Date = new Date()): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function todayIn(timeZone: string): string {
  return nowIn(timeZone).date;
}

function toUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

export function weekday(date: string): Weekday {
  return WEEKDAYS[toUtc(date).getUTCDay()];
}

export function parseInterval(spec: string): [number, number] {
  const [start, end] = spec.split("-").map((hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  });
  return [start, end];
}

export function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtHours(hours: number): string {
  return `${Math.round(hours * 100) / 100}h`;
}

/** "Mon 29 Sep" */
export function fmtDay(date: string): string {
  const d = toUtc(date);
  const part = (opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
  return `${part({ weekday: "short" })} ${d.getUTCDate()} ${part({ month: "short" })}`;
}
