import { describe, expect, it } from "vitest";
import { newId } from "./codes";
import { fromEditable, toEditable, type RecordKind } from "./record-markdown";
import type { Milestone, Project, Task } from "./types";

const pma: Project = {
  id: newId(),
  code: "PMA",
  title: "PM app",
  status: "active",
  priority: "P1",
  context: "personal",
  repos: [],
  detectors: [],
  created: "2026-09-01",
  last_milestone_number: 2,
  body: "Goal: a tiny PM app.",
};
const ops: Project = { ...pma, id: newId(), code: "OPS", title: "Ops", priority: "P2", deadline: "2026-12-31", body: "" };
const m1: Milestone = {
  id: newId(),
  code: "PMA-M1",
  number: 1,
  title: "Store",
  status: "in_progress",
  project: pma.id,
  created: "2026-09-01",
  last_task_number: 3,
  checks: {},
  deployments: {},
  body: "## Spec\n\nMarkdown store.",
};
const m2: Milestone = { ...m1, id: newId(), code: "PMA-M2", number: 2, title: "UI", status: "planned", priority: "P0", deadline: "2026-11-01", body: "" };
const task = (number: number, extra: Partial<Task> = {}): Task => ({
  id: newId(),
  code: `PMA-M1-T${number}`,
  number,
  title: `Task ${number}`,
  status: "todo",
  milestone: m1.id,
  spent: 0,
  depends_on: [],
  tags: [],
  created: "2026-09-02",
  body: "",
  ...extra,
});
const t1 = task(1, { estimate: 2, estimate_range: [1, 4], spent: 1.5, priority: "P0", tags: ["api", "backend"], deadline: "2026-10-15" });
const t2 = task(2, { depends_on: [t1.id], not_before: "2026-10-01", body: "Do the thing.\n\n## Log\n\n- 2026-09-03: 1h", order: 3 });
const t3 = task(3, { depends_on: [t2.id], status: "done", completed: "2026-09-10" });
const ws = { projects: [pma, ops], milestones: [m1, m2], tasks: [t1, t2, t3] };

/** Replace one frontmatter line (`key: …`), or drop it when `line` is empty. */
const edit = (text: string, key: string, line: string) => {
  const re = new RegExp(`^${key}:.*\\n`, "m");
  expect(text).toMatch(re);
  return text.replace(re, line ? `${line}\n` : "");
};
/** Insert a line just before the closing `---`. */
const add = (text: string, line: string) => text.replace(/\n---\n/, `\n${line}\n---\n`);

function patchOf(kind: RecordKind, text: string, record: Task | Milestone | Project) {
  const result = fromEditable(kind, text, record as never, ws);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.patch;
}
function errorsOf(kind: RecordKind, text: string, record: Task | Milestone | Project) {
  const result = fromEditable(kind, text, record as never, ws);
  if (result.ok) throw new Error(`expected errors, got patch ${JSON.stringify(result.patch)}`);
  return result.errors.join("\n");
}

describe("toEditable", () => {
  it("writes editable fields in schema order, references as codes, and the body", () => {
    expect(toEditable("task", t1, ws)).toBe(
      "---\ntitle: Task 1\nstatus: todo\npriority: P0\nmilestone: PMA-M1\nestimate: 2\ndeadline: 2026-10-15\ntags: [api, backend]\n---\n",
    );
    expect(toEditable("task", t2, ws)).toBe(
      "---\ntitle: Task 2\nstatus: todo\nmilestone: PMA-M1\nnot_before: 2026-10-01\ndepends_on: [PMA-M1-T1]\n---\n\nDo the thing.\n\n## Log\n\n- 2026-09-03: 1h\n",
    );
    expect(toEditable("milestone", m2, ws)).toBe("---\ntitle: UI\nstatus: planned\nproject: PMA\npriority: P0\ndeadline: 2026-11-01\n---\n");
    expect(toEditable("project", pma, ws)).toBe("---\ncode: PMA\ntitle: PM app\nstatus: active\npriority: P1\n---\n\nGoal: a tiny PM app.\n");
  });

  it("leaves out read-only fields", () => {
    const text = toEditable("task", t3, ws);
    for (const key of ["id", "code", "number", "spent", "estimate_range", "order", "created", "completed"]) expect(text).not.toMatch(new RegExp(`^${key}:`, "m"));
    expect(toEditable("milestone", m1, ws)).not.toMatch(/last_task_number|created|^code:/m);
  });

  it("is deterministic", () => {
    expect(toEditable("task", { ...t1 }, { ...ws })).toBe(toEditable("task", t1, ws));
  });
});

describe("fromEditable round trip", () => {
  const cases: [RecordKind, Task | Milestone | Project][] = [
    ["task", t1],
    ["task", t2],
    ["task", t3],
    ["task", task(9, { title: "  padded: with colon ", body: "  trailing  \n\n" })],
    ["milestone", m1],
    ["milestone", m2],
    ["project", pma],
    ["project", ops],
  ];
  it.each(cases)("%s %# gives an empty patch", (kind, record) => {
    expect(patchOf(kind, toEditable(kind, record as never, ws), record)).toEqual({});
  });

  it("ignores CRLF line breaks and a BOM", () => {
    const text = toEditable("task", t2, ws).replace(/\n/g, "\r\n");
    expect(patchOf("task", `﻿${text}`, t2)).toEqual({});
  });

  it("keeps a dangling dependency id", () => {
    const gone = newId();
    const t = task(5, { depends_on: [gone, t1.id] });
    const text = toEditable("task", t, ws);
    expect(text).toContain(`depends_on: [${gone}, PMA-M1-T1]`);
    expect(patchOf("task", text, t)).toEqual({});
  });
});

describe("fromEditable task changes", () => {
  const base = toEditable("task", t1, ws);
  it.each([
    ["title", "title: Renamed", { title: "Renamed" }],
    ["status", "status: in_progress", { status: "in_progress" }],
    ["priority", "priority: p3", { priority: "P3" }],
    ["priority", "", { priority: null }],
    ["milestone", "milestone: pma-m2", { milestone: m2.id }],
    ["estimate", "estimate: 3.5", { estimate: 3.5 }],
    ["deadline", "deadline: 2026-10-20", { deadline: "2026-10-20" }],
    ["deadline", "", { deadline: null }],
    ["deadline", "deadline:", { deadline: null }],
    ["tags", "tags: [api]", { tags: ["api"] }],
    ["tags", "tags: api, frontend", { tags: ["api", "frontend"] }],
    ["tags", "", { tags: [] }],
  ])("%s → %j", (key, line, patch) => {
    expect(patchOf("task", edit(base, key, line), t1)).toEqual(patch);
  });

  it("adds not_before and dependencies (as ids), deduplicated", () => {
    const t4 = task(4);
    const text = add(add(toEditable("task", t4, ws), "not_before: 2026-10-05"), "depends_on: [PMA-M1-T3, pma-m1-t2, PMA-M1-T3]");
    expect(patchOf("task", text, t4)).toEqual({
      not_before: "2026-10-05",
      depends_on: [t3.id, t2.id],
    });
    expect(patchOf("task", edit(toEditable("task", t2, ws), "depends_on", ""), t2)).toEqual({ depends_on: [] });
  });

  it("an unchanged estimate leaves the range alone; a changed one is patched", () => {
    expect(patchOf("task", base, t1)).not.toHaveProperty("estimate");
    expect(patchOf("task", edit(base, "estimate", "estimate: 2.0"), t1)).toEqual({});
    expect(patchOf("task", add(toEditable("task", t2, ws), "estimate: 1"), t2)).toEqual({ estimate: 1 });
  });

  it("body edits become the description", () => {
    expect(patchOf("task", `${base}\nNew description.\n`, t1)).toEqual({ description: "New description." });
    expect(patchOf("task", toEditable("task", t2, ws).replace(/\n\nDo the thing[\s\S]*$/, "\n"), t2)).toEqual({ description: "" });
  });
});

describe("fromEditable milestone and project changes", () => {
  it("milestone fields", () => {
    const base = toEditable("milestone", m2, ws);
    expect(patchOf("milestone", edit(base, "project", "project: ops"), m2)).toEqual({ project: ops.id });
    expect(patchOf("milestone", edit(base, "status", "status: idea"), m2)).toEqual({ status: "idea" });
    expect(patchOf("milestone", edit(edit(base, "priority", ""), "deadline", ""), m2)).toEqual({ priority: null, deadline: null });
    expect(patchOf("milestone", add(toEditable("milestone", m1, ws), "priority: P3"), m1)).toEqual({ priority: "P3" });
    expect(patchOf("milestone", `${base}\n## Spec v2\n`, m2)).toEqual({ description: "## Spec v2" });
  });

  it("project fields", () => {
    const base = toEditable("project", pma, ws);
    expect(patchOf("project", edit(base, "code", "code: pmx"), pma)).toEqual({ code: "PMX" });
    expect(patchOf("project", edit(base, "priority", "priority: P0"), pma)).toEqual({ priority: "P0" });
    expect(patchOf("project", edit(base, "status", "status: on_hold"), pma)).toEqual({ status: "on_hold" });
    expect(patchOf("project", add(base, "deadline: 2027-01-31"), pma)).toEqual({ deadline: "2027-01-31" });
    expect(patchOf("project", edit(toEditable("project", ops, ws), "deadline", ""), ops)).toEqual({ deadline: null });
    expect(patchOf("project", base.replace("Goal: a tiny PM app.", "Goal: a small PM app."), pma)).toEqual({ description: "Goal: a small PM app." });
  });
});

describe("fromEditable errors", () => {
  const base = toEditable("task", t2, ws);
  it.each([
    ["no frontmatter", "just text", /must start with frontmatter/],
    ["unclosed frontmatter", "---\ntitle: x\n", /must start with frontmatter/],
    ["YAML syntax", "---\ntitle: [unclosed\n---\n", /isn't valid YAML: .+/],
    ["duplicate keys", add(base, "title: again"), /isn't valid YAML: .*unique/],
    ["not a mapping", "---\n- a\n- b\n---\n", /must be a list of `key: value` fields/],
    ["missing title", edit(base, "title", ""), /"title" is required/],
    ["empty title", edit(base, "title", 'title: "  "'), /"title" is required and can't be empty/],
    ["missing status", edit(base, "status", ""), /"status" is required \(one of: todo, in_progress, blocked, done, cancelled\)/],
    ["bad status", edit(base, "status", "status: doing"), /"status" must be one of: todo, in_progress, blocked, done, cancelled; got "doing"/],
    ["bad priority", add(base, "priority: high"), /"priority" must be one of: P0, P1, P2, P3/],
    ["bad date", edit(base, "not_before", "not_before: 10/01/2026"), /"not_before" must be a date like 2026-10-31 \(YYYY-MM-DD\)/],
    ["impossible date", add(base, "deadline: 2026-02-30"), /"deadline" must be a date/],
    ["bad estimate", add(base, "estimate: two"), /"estimate" must be a number of hours/],
    ["negative estimate", add(base, "estimate: -1"), /"estimate" must be a number of hours/],
    ["missing milestone", edit(base, "milestone", ""), /"milestone" is required \(a milestone code like PMA-M1\)/],
    ["unknown milestone", edit(base, "milestone", "milestone: PMA-M9"), /"milestone": Milestone PMA-M9 not found/],
    ["not a milestone code", edit(base, "milestone", "milestone: PMA"), /"milestone": "PMA" is not a milestone code/],
    ["unknown dependency", edit(base, "depends_on", "depends_on: [PMA-M1-T7]"), /"depends_on": Task PMA-M1-T7 not found/],
    ["self dependency", edit(base, "depends_on", "depends_on: [PMA-M1-T2]"), /"depends_on": PMA-M1-T2 can't depend on itself/],
    ["dependency cycle", edit(base, "depends_on", "depends_on: [PMA-M1-T3]"), /dependency cycle, PMA-M1-T3 already depends on PMA-M1-T2/],
    ["nested tags", add(base, "tags: [[a]]"), /"tags" must be a list/],
    ["read-only key", add(base, "spent: 3"), /"spent" can't be edited here/],
    ["id", add(base, `id: ${t2.id}`), /"id" can't be edited here/],
    ["body as key", add(base, "description: x"), /the description goes below the frontmatter/],
    ["unknown key", add(base, "colour: red"), /Unknown field "colour" \(fields: title, status, priority, milestone, estimate/],
  ])("%s", (_, text, message) => {
    expect(errorsOf("task", text, t2)).toMatch(message);
  });

  it("removing an estimate is an error", () => {
    expect(errorsOf("task", edit(toEditable("task", t1, ws), "estimate", ""), t1)).toMatch(/"estimate" can't be removed/);
  });

  it("reports every problem at once", () => {
    const text = edit(edit(add(base, "spent: 1"), "status", "status: nope"), "title", "");
    expect(fromEditable("task", text, t2, ws)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/spent/), expect.stringMatching(/status/), expect.stringMatching(/title/)]) });
  });

  it("milestone and project errors", () => {
    const milestone = toEditable("milestone", m1, ws);
    expect(errorsOf("milestone", edit(milestone, "project", "project: NOPE"), m1)).toMatch(/"project": Project NOPE not found/);
    expect(errorsOf("milestone", edit(milestone, "status", "status: todo"), m1)).toMatch(/one of: idea, planned, in_progress, done, cancelled/);
    expect(errorsOf("milestone", add(milestone, "last_task_number: 9"), m1)).toMatch(/"last_task_number" can't be edited here/);
    expect(errorsOf("milestone", add(milestone, "spec: x"), m1)).toMatch(/the spec goes below the frontmatter/);

    const project = toEditable("project", pma, ws);
    expect(errorsOf("project", edit(project, "priority", ""), pma)).toMatch(/"priority" can't be removed from a project/);
    expect(errorsOf("project", edit(project, "code", "code: ops"), pma)).toMatch(/"code": OPS is already used by "Ops"/);
    expect(errorsOf("project", edit(project, "code", "code: P-M-A"), pma)).toMatch(/"code": Project code must be 2–6 letters or digits/);
    expect(errorsOf("project", edit(project, "code", ""), pma)).toMatch(/"code" is required/);
    expect(errorsOf("project", edit(project, "status", "status: paused"), pma)).toMatch(/one of: planned, active, on_hold, done, cancelled/);
  });
});
