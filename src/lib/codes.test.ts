import { describe, expect, it } from "vitest";
import { codeKind, compareCodes, isId, isLegacyId, milestoneCode, newId, normalizeCode, renameMentions, taskCode } from "./codes";
import { TaskMeta } from "./types";

describe("codes", () => {
  it("builds milestone and task codes from their parents", () => {
    expect(milestoneCode("PMA", 1)).toBe("PMA-M1");
    expect(taskCode(milestoneCode("PMA", 12), 3)).toBe("PMA-M12-T3");
  });

  it("tells what a code refers to, after normalizing it", () => {
    expect(normalizeCode("  pma-m1-t3 ")).toBe("PMA-M1-T3");
    expect(["PMA", "P1", "AB12CD"].map(codeKind)).toEqual(["project", "project", "project"]);
    expect(["PMA-M1", "P1-M10"].map(codeKind)).toEqual(["milestone", "milestone"]);
    expect(["PMA-M1-T3", "P1-M2-T10"].map(codeKind)).toEqual(["task", "task"]);
    for (const code of ["", "P", "1AB", "TOOLONG", "PMA-M0", "PMA-M1-T0", "PMA-M01", "PMA-T1", "PMA-M1-T1-X", "pma"]) {
      expect(codeKind(code)).toBeUndefined();
    }
  });

  it("recognises uuids and the ids from before milestones", () => {
    expect(isId(newId())).toBe(true);
    expect(isId(newId().toUpperCase())).toBe(true);
    expect(isId("PMA-M1-T1")).toBe(false);
    expect(["T-12", "f-3", "PRJ-1"].every(isLegacyId)).toBe(true);
    expect(isLegacyId("PMA-M1-T1")).toBe(false);
  });

  it("sorts codes naturally and deterministically", () => {
    const codes = ["PMA-M1-T10", "PMA-M10", "PMA-M1-T2", "PMA", "PMA-M2", "AB-M1", "PMA-M1"];
    expect([...codes].sort(compareCodes)).toEqual(["AB-M1", "PMA", "PMA-M1", "PMA-M1-T2", "PMA-M1-T10", "PMA-M2", "PMA-M10"]);
    expect(compareCodes("PMA-M1-T3", "PMA-M1-T3")).toBe(0);
  });
});

describe("renameMentions", () => {
  const renames = new Map([
    ["P1", "PMA"],
    ["P1-M1", "PMA-M1"],
    ["P1-M1-T2", "PMA-M1-T2"],
    ["P1-M1-T3", "P1-M1-T2"],
  ]);

  it("rewrites whole milestone and task codes, in one pass", () => {
    expect(renameMentions("After P1-M1-T2 (see P1-M1), then `P1-M1-T3`.", renames)).toBe("After PMA-M1-T2 (see PMA-M1), then `P1-M1-T2`.");
    expect(renameMentions("/milestones/P1-M1\n- P1-M1-T2: done", renames)).toBe("/milestones/PMA-M1\n- PMA-M1-T2: done");
  });

  it("leaves partial matches, other codes and bare project codes alone", () => {
    const text = "P1-M10, P1-M1-T20, XP1-M1, P1-M1-T2X, P1-M1-T4, priority P1, project P1";
    expect(renameMentions(text, renames)).toBe(text);
    expect(renameMentions("P1-M1", new Map())).toBe("P1-M1");
  });
});

describe("newId", () => {
  it("makes a valid, time-ordered UUID v7", () => {
    const id = newId(Date.UTC(2026, 8, 27));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.replace(/-/g, "").slice(0, 12)).toBe(Date.UTC(2026, 8, 27).toString(16).padStart(12, "0"));
    expect(newId(1000) < newId(2000)).toBe(true);
    expect(new Set(Array.from({ length: 100 }, () => newId(0))).size).toBe(100);
    // Accepted wherever the schemas expect an id.
    expect(() => TaskMeta.parse({ id, code: "PMA-M1-T1", number: 1, title: "x", milestone: newId(), created: "2026-09-27" })).not.toThrow();
  });
});
