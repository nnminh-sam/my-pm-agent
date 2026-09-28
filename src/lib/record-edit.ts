import { z } from "zod";
import { fromEditable, toEditable, type RecordKind } from "./record-markdown";
import type { Milestone, Project, Task } from "./types";
import {
  getMilestone,
  getProject,
  getTask,
  loadWorkspace,
  NotFoundError,
  updateMilestone,
  updateProject,
  updateTask,
  type MilestonePatch,
  type ProjectPatch,
  type TaskPatch,
} from "./repo";

/**
 * Saving a record edited as markdown (see record-markdown.ts). Free of Next imports: the server action in
 * src/app/actions.ts adds auth and revalidation around it.
 */

export type SaveRecordResult = { ok: true; code: string; changed: boolean } | { ok: false; errors: string[]; stale?: boolean };

export const RECORD_KINDS: readonly RecordKind[] = ["task", "milestone", "project"];

/** Browsers submit form fields with CRLF line breaks, and a pasted text may carry a BOM; neither is an edit. */
const normalize = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

/**
 * Applies `text` to the record `id` if it still serializes to `base`, the text the editor opened with; otherwise
 * someone (usually an agent) changed it meanwhile and the edit is refused rather than silently overwriting theirs.
 * Returns the record's code after the save, which changes when a project is recoded or a task/milestone moves.
 */
export async function saveEditedRecord(kind: RecordKind, id: string, base: string, text: string): Promise<SaveRecordResult> {
  let current: Task | Milestone | Project;
  try {
    current = await load(kind, id);
  } catch (err) {
    if (err instanceof NotFoundError) return { ok: false, errors: [`This ${kind} no longer exists.`] };
    throw err;
  }
  const ws = await loadWorkspace();
  try {
    if (normalize(toEditable(kind, current as never, ws)) !== normalize(base)) {
      return {
        ok: false,
        stale: true,
        errors: [`This ${kind} was changed elsewhere (e.g. by an agent) since you opened the editor. Copy your edits, reload, and apply them again.`],
      };
    }
    const result = fromEditable(kind, text, current as never, ws);
    if (!result.ok) return result;
    if (Object.keys(result.patch).length === 0) return { ok: true, code: current.code, changed: false };
    const saved =
      kind === "task"
        ? await updateTask(current.id, result.patch as TaskPatch)
        : kind === "milestone"
          ? await updateMilestone(current.id, result.patch as MilestonePatch)
          : await updateProject(current.id, result.patch as ProjectPatch);
    return { ok: true, code: saved.code, changed: true };
  } catch (err) {
    return { ok: false, errors: [expectedError(err)] };
  }
}

function load(kind: RecordKind, id: string) {
  return kind === "task" ? getTask(id) : kind === "milestone" ? getMilestone(id) : getProject(id);
}

/**
 * The message for an error the repository throws on a bad edit, i.e. a race fromEditable couldn't catch (a
 * referenced record deleted, a code taken, a cycle formed meanwhile). Anything else is a bug or an outage: rethrown.
 */
function expectedError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof z.ZodError) return z.prettifyError(err);
  if (err instanceof Error && /^(Dependency cycle|Project code .* is already used)/.test(err.message)) return err.message;
  throw err;
}
