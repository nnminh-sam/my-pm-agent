import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), isAuthorized: async () => true }));
vi.mock("@/lib/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/repo")>()),
  addComment: vi.fn(async () => ({})),
  deleteComment: vi.fn(async () => undefined),
}));

const repo = await import("@/lib/repo");
const { addCommentAction, deleteCommentAction } = await import("./actions");

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
