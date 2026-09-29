"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  SESSION_COOKIE,
  authMode,
  authenticate,
  clearedSessionCookieOptions,
  isAuthorized,
  isSecureRequest,
  issueSession,
  safeNext,
  sessionCookieOptions,
} from "@/lib/auth";
import { issueApiKey, revokeOwnApiKey } from "@/lib/auth/api-keys";
import { logIn, signUp as signUpUser, type AuthOutcome } from "@/lib/auth/users";
import { RECORD_KINDS, saveEditedRecord, type SaveRecordResult } from "@/lib/record-edit";
import type { RecordKind } from "@/lib/record-markdown";
import { parseAddComment, parseDeleteComment, type CommentResult } from "@/lib/comment-input";
import { parseRepoLink, parseRepoLinkArgs, withDefaultHost, type RepoLinkResult } from "@/lib/repo-link-input";
import {
  NotFoundError,
  addComment,
  deleteComment,
  getProject,
  getUser,
  listUserApiKeys,
  logTime,
  normalizeRepo,
  updateProject,
  updateTask,
} from "@/lib/repo";
import { retrySync, type RetryResult } from "@/lib/github/view";
import { TaskStatus } from "@/lib/types";

// Server functions are reachable by POST from any page, so each mutation re-checks auth (not only proxy.ts).
async function requireAuth() {
  const [store, h] = await Promise.all([cookies(), headers()]);
  const credentials = { authorization: h.get("authorization"), sessionCookie: store.get(SESSION_COOKIE)?.value };
  if (!(await isAuthorized(credentials))) throw new Error("Unauthorized");
}

/**
 * The signed-in account (session cookie, or a session JWT as Bearer). Agents (API keys, PM_SECRET) are
 * refused, so an agent credential can never mint or revoke keys. Throws unless accounts are on ("jwt").
 */
async function requireUser() {
  const [store, h] = await Promise.all([cookies(), headers()]);
  const auth =
    authMode() === "jwt"
      ? authenticate({ authorization: h.get("authorization"), sessionCookie: store.get(SESSION_COOKIE)?.value })
      : null;
  if (!auth || auth === "agent") throw new Error("Unauthorized");
  // A token outlives an account's deletion; keys must belong to an existing user.
  const user = await getUser(auth.sub);
  if (!user) throw new Error("Unauthorized");
  return user;
}

async function secureCookie() {
  return isSecureRequest((await headers()).get("x-forwarded-proto"));
}

/** Redirects back to the form with `?error=<code>`, or sets the session cookie and continues to `next`. */
async function finishAuth(page: "/login" | "/signup", outcome: AuthOutcome, next: string): Promise<never> {
  if (!outcome.ok) redirect(`${page}?error=${outcome.error}&next=${encodeURIComponent(next)}`);
  const { token } = issueSession(outcome.user);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(await secureCookie()));
  redirect(next);
}

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export async function signUp(formData: FormData) {
  const next = safeNext(formData.get("next"));
  if (authMode() !== "jwt") redirect("/signup");
  const outcome = await signUpUser({
    email: field(formData, "email"),
    password: field(formData, "password"),
    confirm: field(formData, "confirm"),
  });
  await finishAuth("/signup", outcome, next);
}

export async function login(formData: FormData) {
  const next = safeNext(formData.get("next"));
  if (authMode() !== "jwt") redirect("/login");
  await finishAuth("/login", await logIn({ email: field(formData, "email"), password: field(formData, "password") }), next);
}

export async function logout() {
  (await cookies()).set(SESSION_COOKIE, "", clearedSessionCookieOptions(await secureCookie()));
  redirect("/login");
}

export async function setTaskStatus(id: string, status: string) {
  await requireAuth();
  await updateTask(id, { status: TaskStatus.parse(status) });
  revalidatePath("/", "layout");
}

export async function logTimeAction(formData: FormData) {
  await requireAuth();
  const id = String(formData.get("id"));
  const hours = Number(formData.get("hours"));
  if (!(hours > 0)) throw new Error("Hours must be a positive number");
  const note = String(formData.get("note") ?? "").trim() || undefined;
  await logTime(id, hours, note, formData.get("done") === "on");
  revalidatePath("/", "layout");
}

/** Adds a comment as "you". Fields: id (task code or id), body. Failures come back as `{ ok: false, message }`. */
export async function addCommentAction(_prev: CommentResult | null, formData: FormData): Promise<CommentResult> {
  await requireAuth();
  const input = parseAddComment(formData);
  if (!input.ok) return input;
  try {
    await addComment(input.id, input.body, "you");
  } catch (err) {
    return { ok: false, message: err instanceof NotFoundError ? err.message : "Couldn't save the comment" };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteCommentAction(taskId: string, commentId: string): Promise<CommentResult> {
  await requireAuth();
  const input = parseDeleteComment(taskId, commentId);
  if (!input.ok) return input;
  try {
    await deleteComment(input.taskId, input.commentId);
  } catch (err) {
    return { ok: false, message: err instanceof NotFoundError ? err.message : "Couldn't delete the comment" };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Changes a project's linked repos. `change` gets the stored list and the normalized remote. Failures come back as
 * `{ ok: false, message }`: an invalid remote, or a repo already linked to another project (updateProject enforces it).
 */
async function changeRepos(
  projectRef: string,
  remote: string,
  change: (repos: string[], normalized: string) => string[],
  { defaultHost }: { defaultHost: boolean },
): Promise<RepoLinkResult> {
  let normalized: string;
  try {
    normalized = normalizeRepo(defaultHost ? withDefaultHost(remote) : remote);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Not a git remote" };
  }
  try {
    const project = await getProject(projectRef);
    await updateProject(project.id, { repos: change(project.repos, normalized) });
  } catch (err) {
    if (err instanceof NotFoundError) return { ok: false, message: err.message };
    if (err instanceof Error && / already belongs to project /.test(err.message)) return { ok: false, message: err.message };
    return { ok: false, message: "Couldn't update the repositories" };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Links a repo to a project. Fields: project (code or id), remote (`owner/repo` or any git remote form). */
export async function addProjectRepoAction(_prev: RepoLinkResult | null, formData: FormData): Promise<RepoLinkResult> {
  await requireAuth();
  const input = parseRepoLink(formData);
  if (!input.ok) return input;
  return changeRepos(input.project, input.remote, (repos, n) => (repos.includes(n) ? repos : [...repos, n]), { defaultHost: true });
}

/** Unlinks a repo (as stored, or in any remote form). */
export async function removeProjectRepoAction(project: string, remote: string): Promise<RepoLinkResult> {
  await requireAuth();
  const input = parseRepoLinkArgs(project, remote);
  if (!input.ok) return input;
  return changeRepos(input.project, input.remote, (repos, n) => repos.filter((r) => r !== n), { defaultHost: false });
}

/** Retry now on a sync badge. `key` is `pr:owner/repo#123` or `repo:owner/repo`; anything else is refused. */
export async function retryGithubSync(key: string): Promise<RetryResult> {
  await requireAuth();
  const result = await retrySync(key);
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

export type SaveRecordState = SaveRecordResult | null;

/**
 * Saves a project, milestone or task edited as markdown (fields: kind, id, base = the text the editor opened with,
 * text). Doesn't redirect: the client navigates to the returned code, which a rename or move changes.
 */
export async function saveRecordAction(_prev: SaveRecordState, formData: FormData): Promise<SaveRecordState> {
  await requireAuth();
  const kind = field(formData, "kind") as RecordKind;
  if (!RECORD_KINDS.includes(kind)) return { ok: false, errors: [`Unknown record kind "${kind}"`] };
  const result = await saveEditedRecord(kind, field(formData, "id"), field(formData, "base"), field(formData, "text"));
  if (result.ok && result.changed) revalidatePath("/", "layout");
  return result;
}

/** At most this many active keys per account (revoke one to make room). */
const MAX_ACTIVE_API_KEYS = 20;

export type CreateApiKeyState = { ok: true; id: string; label: string; key: string } | { ok: false; error: string } | null;

/** Issues a key for the signed-in account. The raw key is returned this once and never stored or logged. */
export async function createApiKeyAction(_prev: CreateApiKeyState, formData: FormData): Promise<CreateApiKeyState> {
  const user = await requireUser();
  const active = (await listUserApiKeys(user.id)).filter((k) => !k.revoked_at);
  if (active.length >= MAX_ACTIVE_API_KEYS) {
    return { ok: false, error: `You already have ${MAX_ACTIVE_API_KEYS} active keys. Revoke one first.` };
  }
  const { key, raw } = await issueApiKey({ label: field(formData, "label"), userId: user.id });
  revalidatePath("/connect");
  return { ok: true, id: key.id, label: key.label, key: raw };
}

/** Revokes one of the signed-in account's keys; takes effect on the key's next request. */
export async function revokeApiKeyAction(id: string) {
  const user = await requireUser();
  if (!(await revokeOwnApiKey(user.id, id))) throw new Error("No such API key");
  revalidatePath("/connect");
}
