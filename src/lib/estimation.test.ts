import { describe, expect, it } from "vitest";
import { estimationStats, pert, rollup } from "./estimation";
import { parseMarkdown, toMarkdown } from "./markdown";
import { newId } from "./codes";
import { TaskMeta } from "./types";

const t = (fields: Partial<TaskMeta>) =>
  TaskMeta.parse({ id: newId(), code: "PMA-M1-T1", number: 1, title: "x", milestone: newId(), created: "2026-09-01", ...fields });

describe("pert", () => {
  it("returns the PERT mean rounded to 15 minutes and keeps the range", () => {
    expect(pert(2, 4, 9)).toEqual({ estimate: 4.5, estimate_range: [2, 9] });
  });
  it("rejects inconsistent ranges", () => {
    expect(() => pert(5, 4, 9)).toThrow(/optimistic ≤ likely ≤ pessimistic/);
  });
});

describe("rollup", () => {
  it("sums estimates and combines uncertainty, ignoring cancelled tasks", () => {
    const r = rollup([
      t({ estimate: 4, estimate_range: [1, 7], status: "done", spent: 5 }),
      t({ estimate: 2, estimate_range: [1, 9], spent: 1, status: "in_progress" }),
      t({}),
      t({ estimate: 100, status: "cancelled" }),
    ]);
    expect(r).toMatchObject({
      tasks: 3,
      unestimated: 1,
      estimate_hours: 6,
      spent_hours: 6,
      remaining_hours: 1,
      estimate_sd_hours: 1.67, // sqrt(1² + (8/6)²)
      progress: 0.67,
    });
  });
});

describe("estimationStats", () => {
  it("computes actual ÷ estimate overall and per tag, and suggests a buffer", () => {
    const done = (estimate: number, spent: number, tags: string[]) => t({ status: "done", estimate, spent, tags });
    const stats = estimationStats([
      done(2, 3, ["backend"]),
      done(4, 6, ["backend"]),
      done(1, 1, ["frontend"]),
      done(2, 2, ["frontend"]),
      done(3, 4.5, ["infra"]),
      t({ estimate: 5 }), // open: ignored
    ]);
    expect(stats.overall).toMatchObject({ samples: 5, estimated_hours: 12, actual_hours: 16.5, ratio: 1.38 });
    expect(stats.by_tag.backend.ratio).toBe(1.5);
    expect(stats.by_tag.frontend.ratio).toBe(1);
    expect(stats.by_tag.infra).toBeUndefined(); // needs 2+ samples
    expect(stats.suggested_buffer).toBe(1.4);
  });
});

describe("markdown", () => {
  it("round-trips frontmatter with inline lists and a body", () => {
    const text = toMarkdown(
      { id: "T-3", title: "Login: API", tags: ["api", "backend"], depends_on: [], deadline: "2026-10-01", spent: 0 },
      "Do the thing.\n\n- [ ] works",
    );
    expect(text).toBe(
      '---\nid: T-3\ntitle: "Login: API"\ntags: [api, backend]\ndeadline: 2026-10-01\nspent: 0\n---\n\nDo the thing.\n\n- [ ] works\n',
    );
    expect(parseMarkdown(text)).toEqual({
      data: { id: "T-3", title: "Login: API", tags: ["api", "backend"], deadline: "2026-10-01", spent: 0 },
      body: "Do the thing.\n\n- [ ] works",
    });
  });
});
