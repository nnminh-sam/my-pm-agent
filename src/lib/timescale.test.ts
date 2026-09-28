import { describe, expect, it } from "vitest";
import { nowIn } from "./time";
import { clampToScale, makeScale, UNITS, viewScale, weekStart } from "./timescale";

// 2026-09-28 is a Monday.
describe("weekStart", () => {
  it("snaps to Monday, including Sundays", () => {
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2026-09-30")).toBe("2026-09-28");
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday belongs to the week before
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
  });
});

describe("makeScale", () => {
  it("week: snaps outwards to Monday–Sunday, one minor tick per week, months as major", () => {
    const s = makeScale("week", "2026-09-30", "2026-10-06"); // Wed → Tue
    expect([s.start, s.end]).toEqual(["2026-09-28", "2026-10-12"]);
    expect(s.minor.map((t) => t.label)).toEqual(["28 Sep", "5 Oct"]);
    expect(s.minor.every((t) => t.width === 140)).toBe(true);
    expect(s.width).toBe(280);
    expect(s.major.map((t) => [t.label, t.x, t.width])).toEqual([
      ["Sep 2026", 0, 60], // 3 days of September × 20px
      ["Oct 2026", 60, 220],
    ]);
  });

  it("day: one minor tick per day, weeks (Monday start) as major", () => {
    const s = makeScale("day", "2026-09-30", "2026-10-06");
    expect([s.start, s.end]).toEqual(["2026-09-30", "2026-10-07"]);
    expect(s.minor.map((t) => t.label)).toEqual(["Wed 30", "Thu 1", "Fri 2", "Sat 3", "Sun 4", "Mon 5", "Tue 6"]);
    expect(s.minor.every((t) => t.width === 48)).toBe(true);
    expect(s.major.map((t) => [t.label, t.x, t.width])).toEqual([
      ["Week of 28 Sep", 0, 5 * 48], // Wed–Sun
      ["Week of 5 Oct", 5 * 48, 2 * 48],
    ]);
  });

  it("hour: one minor tick per hour, days as major", () => {
    const s = makeScale("hour", "2026-09-28", "2026-09-29");
    expect(s.minor).toHaveLength(48);
    expect(s.minor[0]).toEqual({ x: 0, width: 64, label: "00:00" });
    expect(s.minor[9].label).toBe("09:00");
    expect(s.minor[24].label).toBe("00:00");
    expect(s.major.map((t) => [t.label, t.x, t.width])).toEqual([
      ["Mon 28 Sep", 0, 24 * 64],
      ["Tue 29 Sep", 24 * 64, 24 * 64],
    ]);
  });

  it("minute: a tick every 5 minutes, hours as major", () => {
    const s = makeScale("minute", "2026-09-28", "2026-09-28");
    expect(s.minor).toHaveLength(288);
    expect(s.minor[1]).toEqual({ x: 40, width: 40, label: "00:05" });
    expect(s.minor[109].label).toBe("09:05");
    expect(s.major).toHaveLength(24);
    expect(s.major[9]).toEqual({ x: 9 * 480, width: 480, label: "09:00" });
    expect(s.width).toBe(1440 * 8);
  });

  it("swaps a reversed range", () => {
    expect(makeScale("day", "2026-10-02", "2026-09-30").start).toBe("2026-09-30");
  });

  it.each(UNITS)("%s: ticks tile the axis without gaps and major rows span it fully", (unit) => {
    const s = makeScale(unit, "2026-09-28", "2026-10-04");
    for (const row of [s.minor, s.major]) {
      expect(row[0].x).toBe(0);
      row.slice(1).forEach((t, i) => expect(t.x).toBeCloseTo(row[i].x + row[i].width, 6));
      const last = row[row.length - 1];
      expect(last.x + last.width).toBeCloseTo(s.width, 6);
    }
  });

  it.each(UNITS)("%s: toX of a tick's own date/time equals the tick's x (bars align with header)", (unit) => {
    const s = makeScale(unit, "2026-09-28", "2026-09-30");
    const day = 1440 * s.pxPerMinute;
    // Day start, and 09:30 on the second day, should land where the tick maths says.
    expect(s.toX("2026-09-28")).toBe(0);
    expect(s.toX({ date: "2026-09-29", time: "09:30" })).toBeCloseTo(day + 570 * s.pxPerMinute, 6);
    if (unit === "day" || unit === "week") expect(s.minor.find((t) => t.x === s.toX("2026-09-28"))).toBeDefined();
    if (unit === "hour") expect(s.minor.find((t) => t.label === "09:00" && t.x === s.toX({ date: "2026-09-28", time: "09:00" }))).toBeDefined();
    if (unit === "minute") expect(s.minor.find((t) => t.label === "09:30" && t.x === s.toX({ date: "2026-09-28", time: "09:30" }))).toBeDefined();
  });

  it("spanWidth sizes work blocks, keeps the lunch gap visible and never goes negative", () => {
    const s = makeScale("hour", "2026-09-28", "2026-09-28");
    const morning = s.spanWidth({ date: "2026-09-28", time: "09:00" }, { date: "2026-09-28", time: "12:00" });
    const afternoon = { date: "2026-09-28", time: "13:00" };
    expect(morning).toBe(3 * 64);
    expect(s.toX(afternoon) - s.toX({ date: "2026-09-28", time: "12:00" })).toBe(64); // 1h gap
    expect(s.spanWidth(afternoon, { date: "2026-09-28", time: "09:00" })).toBe(0);
  });

  it("maps 'now' in Asia/Ho_Chi_Minh (UTC+7, no DST) onto the axis", () => {
    const now = nowIn("Asia/Ho_Chi_Minh", new Date("2026-09-28T02:30:00Z")); // 09:30 local
    expect(now).toEqual({ date: "2026-09-28", minutes: 570 });
    const s = makeScale("hour", "2026-09-28", "2026-09-28");
    expect(s.toX({ date: now.date, time: "09:30" })).toBeCloseTo(9.5 * 64, 6);
    // Every day is exactly 24h wide, whatever the month.
    const long = makeScale("day", "2026-03-01", "2026-11-30");
    expect(long.minor.every((t) => t.width === 48)).toBe(true);
  });
});

describe("pointAt / viewScale", () => {
  it.each(UNITS)("%s: pointAt inverts toX to the minute and clamps to the axis", (unit) => {
    const s = makeScale(unit, "2026-09-28", "2026-09-30");
    const p = { date: "2026-09-29", time: "09:30" };
    expect(s.pointAt(s.toX(p))).toEqual(p);
    expect(s.pointAt(-50).date).toBe(s.start);
    // The week unit ends on Sunday; the others on the last date.
    expect(s.pointAt(s.width + 50)).toEqual({ date: unit === "week" ? "2026-10-04" : "2026-09-30", time: "23:59" });
  });

  it("keeps the centre when the unit changes", () => {
    const center = { date: "2026-09-30", time: "13:00" };
    const day = makeScale("day", "2026-09-28", "2026-10-09");
    const x = day.toX(center) + 100; // pretend the viewport centre sits here
    const picked = day.pointAt(x);
    const hour = viewScale("hour", "2026-09-28", "2026-10-09", picked);
    expect(hour.pointAt(hour.toX(picked))).toEqual(picked);
  });

  it("caps the minute unit to a day either side of the centre, within the range", () => {
    const m = viewScale("minute", "2026-09-01", "2026-12-01", { date: "2026-09-28", time: "09:00" });
    expect([m.start, m.end]).toEqual(["2026-09-27", "2026-09-30"]);
    const edge = viewScale("minute", "2026-09-28", "2026-09-29", { date: "2026-09-28", time: "09:00" });
    expect([edge.start, edge.end]).toEqual(["2026-09-28", "2026-09-30"]);
    const outside = viewScale("minute", "2026-09-28", "2026-09-29", { date: "2027-01-01" });
    expect(outside.start <= "2026-09-29" && outside.end > "2026-09-29").toBe(true);
    expect(viewScale("day", "2026-09-01", "2026-12-01", { date: "2026-09-28" }).start).toBe("2026-09-01");
  });

  it("caps the hour unit to two weeks either side, but keeps week and day whole", () => {
    const h = viewScale("hour", "2026-01-01", "2026-12-31", { date: "2026-09-28", time: "09:00" });
    expect([h.start, h.end]).toEqual(["2026-09-14", "2026-10-13"]);
    expect(h.minor).toHaveLength(29 * 24);
    expect(viewScale("hour", "2026-09-28", "2026-10-02", { date: "2026-09-28" }).minor).toHaveLength(5 * 24);
    // A quarter of a year of minutes would be 130k ticks; the view never exceeds three days of them.
    expect(viewScale("minute", "2026-07-01", "2026-09-30", { date: "2026-08-15" }).minor.length).toBeLessThanOrEqual(3 * 288);
  });

  it("clampToScale moves outside points onto the axis", () => {
    const s = makeScale("day", "2026-09-28", "2026-09-30");
    expect(clampToScale(s, { date: "2026-09-01" })).toEqual({ date: "2026-09-28", time: "00:00" });
    expect(clampToScale(s, { date: "2027-01-01" })).toEqual({ date: "2026-09-30", time: "23:59" });
    expect(clampToScale(s, { date: "2026-09-29", time: "10:00" })).toEqual({ date: "2026-09-29", time: "10:00" });
  });
});
