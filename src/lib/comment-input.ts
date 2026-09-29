/**
 * Validation of the comment server actions' input. Server actions are reachable by POST with arbitrary values (a File
 * where a string is expected, missing fields), so every value is checked at runtime, not only by its TypeScript type.
 */

/** Same limit as repo.ts addComment (MAX_COMMENT_LENGTH); kept here so the client-facing message is ours. */
export const COMMENT_LIMIT = 10_000;

/** What the comment actions return to the UI (thrown errors are redacted in production, so failures are values). */
export type CommentResult = { ok: true } | { ok: false; message: string };

export type ParsedAdd = { ok: true; id: string; body: string } | { ok: false; message: string };
export type ParsedDelete = { ok: true; taskId: string; commentId: string } | { ok: false; message: string };

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function parseAddComment(formData: unknown): ParsedAdd {
  if (!(formData instanceof FormData)) return { ok: false, message: "Invalid request" };
  const id = formData.get("id");
  const body = formData.get("body");
  if (!nonEmptyString(id)) return { ok: false, message: "Missing task" };
  if (typeof body !== "string") return { ok: false, message: "Comment must be text" };
  const text = body.trim();
  if (!text) return { ok: false, message: "Write something first" };
  if (text.length > COMMENT_LIMIT) return { ok: false, message: `Comment is too long (${text.length} of ${COMMENT_LIMIT} characters)` };
  return { ok: true, id, body: text };
}

export function parseDeleteComment(taskId: unknown, commentId: unknown): ParsedDelete {
  if (!nonEmptyString(taskId) || !nonEmptyString(commentId)) return { ok: false, message: "Invalid request" };
  return { ok: true, taskId, commentId };
}
