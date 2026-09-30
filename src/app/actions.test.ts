import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), isAuthorized: async () => true }));
vi.mock("@/lib/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/repo")>()),
  getProject: vi.fn(async () => ({ id: "p1", code: "ME", repos: ["github.com/me/app"] })),
  updateProject: vi.fn(async () => ({})),
  addComment: vi.fn(async () => ({})),
  deleteComment: vi.fn(async () => undefined),
}));

const repo = await import("@/lib/repo");
const { addCommentAction, deleteCommentAction, addProjectRepoAction, removeProjectRepoAction } = await import("./actions");

const form = (fields: Record<string, FormDataEntryValue | null>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null) f.set(k, v);
  return f;
};
beforeEach(() => vi.clearAllMocks());

describe("addCommentAction", () => {
  it("adds a comment as you and trims it", async () => {
    expect(await addCommentAction(null, form({ id: "PMA-M1-T1", body: "  hi\nthere  " }))).toEqual({ ok: true });
    expect(repo.addComment).toHaveBeenCalledWith("PMA-M1-T1", "hi\nthere", "you");
  });

  it("rejects a File, a missing field, a blank or over-long body and a non-FormData without touching the repo", async () => {
    const file = new File(["x"], "x.txt");
    const bad = [
      form({ id: "T", body: file }),
      form({ id: file, body: "hi" }),
      form({ id: "T", body: null }),
      form({ id: null, body: "hi" }),
      form({ id: "T", body: "   " }),
      form({ id: "T", body: "x".repeat(10_001) }),
      null as unknown as FormData,
    ];
    for (const f of bad) expect(await addCommentAction(null, f)).toMatchObject({ ok: false, message: expect.any(String) });
    expect(repo.addComment).not.toHaveBeenCalled();
  });

  it("returns a message instead of throwing when the repo fails", async () => {
    vi.mocked(repo.addComment).mockRejectedValueOnce(new repo.NotFoundError("Task X not found"));
    expect(await addCommentAction(null, form({ id: "X", body: "hi" }))).toEqual({ ok: false, message: "Task X not found" });
    vi.mocked(repo.addComment).mockRejectedValueOnce(new Error("connection string postgres://secret"));
    expect(await addCommentAction(null, form({ id: "X", body: "hi" }))).toEqual({ ok: false, message: "Couldn't save the comment" });
  });
});

describe("deleteCommentAction", () => {
  it("deletes through the task", async () => {
    expect(await deleteCommentAction("PMA-M1-T1", "c1")).toEqual({ ok: true });
    expect(repo.deleteComment).toHaveBeenCalledWith("PMA-M1-T1", "c1");
  });

  it("rejects non-string and empty arguments", async () => {
    const file = new File(["x"], "x.txt");
    for (const [a, b] of [[file, "c"], ["t", file], [null, "c"], ["t", undefined], ["", "c"], ["t", { toString: () => "c" }]])
      expect(await deleteCommentAction(a as string, b as string)).toMatchObject({ ok: false });
    expect(repo.deleteComment).not.toHaveBeenCalled();
  });

  it("returns a message when the comment is gone", async () => {
    vi.mocked(repo.deleteComment).mockRejectedValueOnce(new repo.NotFoundError("Comment c9 not found on task T"));
    expect(await deleteCommentAction("T", "c9")).toEqual({ ok: false, message: "Comment c9 not found on task T" });
  });
});

describe("addProjectRepoAction", () => {
  it("normalizes any remote form (owner/repo means github.com) and appends it", async () => {
    expect(await addProjectRepoAction(null, form({ project: "ME", remote: " owner/Other " }))).toEqual({ ok: true });
    expect(repo.updateProject).toHaveBeenLastCalledWith("p1", { repos: ["github.com/me/app", "github.com/owner/other"] });
    await addProjectRepoAction(null, form({ project: "ME", remote: "https://www.github.com/me/app.git" }));
    expect(repo.updateProject).toHaveBeenLastCalledWith("p1", { repos: ["github.com/me/app"] });
  });

  it("rejects a File, a missing or blank field and a non-FormData without touching the repo", async () => {
    const file = new File(["x"], "x.txt");
    const bad = [form({ project: "ME", remote: file }), form({ project: file, remote: "a/b" }), form({ project: "ME" }), form({ remote: "a/b" }), form({ project: "ME", remote: "  " }), null as unknown as FormData];
    for (const f of bad) expect(await addProjectRepoAction(null, f)).toMatchObject({ ok: false, message: expect.any(String) });
    expect(repo.getProject).not.toHaveBeenCalled();
    expect(repo.updateProject).not.toHaveBeenCalled();
  });

  it("returns a message for an invalid remote", async () => {
    expect(await addProjectRepoAction(null, form({ project: "ME", remote: "not a remote" }))).toMatchObject({ ok: false, message: expect.stringContaining("isn't a git remote") });
    expect(repo.updateProject).not.toHaveBeenCalled();
  });

  it("surfaces a repo already linked to another project, and redacts other failures", async () => {
    vi.mocked(repo.updateProject).mockRejectedValueOnce(new Error("github.com/o/r already belongs to project OT"));
    expect(await addProjectRepoAction(null, form({ project: "ME", remote: "o/r" }))).toEqual({ ok: false, message: "github.com/o/r already belongs to project OT" });
    vi.mocked(repo.updateProject).mockRejectedValueOnce(new Error("connection string postgres://secret"));
    expect(await addProjectRepoAction(null, form({ project: "ME", remote: "o/r" }))).toEqual({ ok: false, message: "Couldn't update the repositories" });
    vi.mocked(repo.getProject).mockRejectedValueOnce(new repo.NotFoundError("Project X not found"));
    expect(await addProjectRepoAction(null, form({ project: "X", remote: "o/r" }))).toEqual({ ok: false, message: "Project X not found" });
  });
});

describe("removeProjectRepoAction", () => {
  it("removes the normalized repo", async () => {
    expect(await removeProjectRepoAction("ME", "github.com/me/app")).toEqual({ ok: true });
    expect(repo.updateProject).toHaveBeenLastCalledWith("p1", { repos: [] });
  });

  it("rejects non-string arguments and invalid remotes", async () => {
    const file = new File(["x"], "x.txt");
    for (const [a, b] of [[file, "a/b"], ["ME", file], [null, "a/b"], ["ME", undefined], ["", "a/b"], ["ME", ""]])
      expect(await removeProjectRepoAction(a as string, b as string)).toMatchObject({ ok: false });
    expect(await removeProjectRepoAction("ME", "junk")).toMatchObject({ ok: false });
    expect(repo.updateProject).not.toHaveBeenCalled();
  });
});
