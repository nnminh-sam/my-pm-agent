import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveEditedRecord } from "./record-edit";
import { toEditable } from "./record-markdown";
import * as repo from "./repo";
import { setRepository } from "./repository";
import { FileRepository } from "./repository/file";
import { FsStore } from "./store/fs";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "my-pm-edit-"));
  setRepository(new FileRepository(new FsStore(dir)));
  await repo.createProject({ title: "Edit", code: "ED" });
  await repo.createMilestone({ title: "One", project: "ED" });
  await repo.createMilestone({ title: "Two", project: "ED" });
  await repo.createTasks([{ title: "Write it", milestone: "ED-M1", estimate: 2 }]);
});
afterAll(async () => {
  setRepository(undefined);
  await rm(dir, { recursive: true, force: true });
});

async function opened(ref: string) {
  const [task, ws] = await Promise.all([repo.getTask(ref), repo.loadWorkspace()]);
  return { task, text: toEditable("task", task, ws) };
}

describe("saveEditedRecord", () => {
  it("saves nothing when the text is unchanged (CRLF from the browser included)", async () => {
    const { task, text } = await opened("ED-M1-T1");
    const crlf = text.replace(/\n/g, "\r\n");
    expect(await saveEditedRecord("task", task.id, crlf, crlf)).toEqual({ ok: true, code: "ED-M1-T1", changed: false });
    expect(await repo.getTask(task.id)).toEqual(task);
  });

  it("refuses an edit whose base is stale, without writing", async () => {
    const { task, text } = await opened("ED-M1-T1");
    const agent = await repo.updateTask(task.id, { append_note: "Changed by an agent." });
    const result = await saveEditedRecord("task", task.id, text, text.replace("title: Write it", "title: Mine"));
    expect(result).toMatchObject({ ok: false, stale: true });
    expect(await repo.getTask(task.id)).toEqual(agent);
  });

  it("returns the problems in invalid markdown, without writing", async () => {
    const { task, text } = await opened("ED-M1-T1");
    const result = await saveEditedRecord("task", task.id, text, text.replace(/^status: .*$/m, "status: someday"));
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('"status" must be one of')] });
    expect(result).not.toHaveProperty("stale");
    expect(await repo.getTask(task.id)).toEqual(task);
  });

  it("applies a change and returns the code after it (a move renumbers the task)", async () => {
    const { task, text } = await opened("ED-M1-T1");
    const edited = text.replace("milestone: ED-M1", "milestone: ED-M2").replace("estimate: 2", "estimate: 3");
    expect(await saveEditedRecord("task", task.id, text, edited)).toEqual({ ok: true, code: "ED-M2-T1", changed: true });
    expect(await repo.getTask(task.id)).toMatchObject({ code: "ED-M2-T1", estimate: 3 });
  });

  it("reports a record that no longer exists", async () => {
    expect(await saveEditedRecord("milestone", "ED-M9", "", "")).toEqual({ ok: false, errors: ["This milestone no longer exists."] });
  });
});
