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
import { addComment, deleteComment, getUser, listUserApiKeys, logTime, updateTask } from "@/lib/repo";
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

/** Adds a comment as "you". Fields: id (task code or id), body. */
export async function addCommentAction(formData: FormData) {
  await requireAuth();
  await addComment(String(formData.get("id")), String(formData.get("body") ?? ""), "you");
  revalidatePath("/", "layout");
}

export async function deleteCommentAction(taskId: string, commentId: string) {
  await requireAuth();
  await deleteComment(taskId, commentId);
  revalidatePath("/", "layout");
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
