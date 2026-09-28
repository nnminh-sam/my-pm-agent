import { countUsers, createUser, findUserByEmail, isValidEmail, normalizeEmail } from "../repo";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  getDummyHash,
  hashPassword,
  validatePassword,
  verifyPassword,
  type ScryptParams,
} from "./password";

/**
 * Sign-up and login, shared by the server actions and the JSON routes. Results are typed instead of
 * thrown so callers can map them to redirects or status codes. Never log passwords, hashes or tokens.
 */

export type AuthError =
  | "invalid_input" // missing or non-string fields
  | "invalid_email"
  | "invalid_password" // fails the password policy
  | "password_mismatch" // sign-up confirmation differs
  | "signup_closed"
  | "email_taken"
  | "invalid_credentials"; // login: unknown email or wrong password, deliberately indistinguishable

export const AUTH_ERROR_STATUS: Record<AuthError, number> = {
  invalid_input: 400,
  invalid_email: 400,
  invalid_password: 400,
  password_mismatch: 400,
  signup_closed: 403,
  email_taken: 409,
  invalid_credentials: 401,
};

export const AUTH_ERROR_MESSAGES: Record<AuthError, string> = {
  invalid_input: "Enter an email and a password.",
  invalid_email: "Enter a valid email address.",
  invalid_password: `Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters and not the same as your email.`,
  password_mismatch: "The passwords don't match.",
  signup_closed: "Sign-up is closed.",
  email_taken: "An account with this email already exists.",
  invalid_credentials: "Invalid email or password.",
};

export type AuthUser = { id: string; email: string };
export type AuthOutcome = { ok: true; user: AuthUser } | { ok: false; error: AuthError; message: string };

type Env = Record<string, string | undefined>;

function fail(error: AuthError, message = AUTH_ERROR_MESSAGES[error]): AuthOutcome {
  return { ok: false, error, message };
}

/** Normalized emails allowed to sign up once the first account exists (`PM_SIGNUP_EMAILS`, comma-separated). */
export function signupAllowlist(env: Env = process.env): Set<string> {
  return new Set((env.PM_SIGNUP_EMAILS ?? "").split(",").map(normalizeEmail).filter(Boolean));
}

/** "open" while there are no users, "invite" when PM_SIGNUP_EMAILS lists emails, else "closed". */
export async function signupStatus(env: Env = process.env): Promise<"open" | "invite" | "closed"> {
  if ((await countUsers()) === 0) return "open";
  return signupAllowlist(env).size > 0 ? "invite" : "closed";
}

export async function signUp(
  input: { email: unknown; password: unknown; confirm?: unknown },
  { env = process.env, hashParams }: { env?: Env; hashParams?: Partial<ScryptParams> } = {},
): Promise<AuthOutcome> {
  const { password, confirm } = input;
  if (typeof input.email !== "string" || typeof password !== "string") return fail("invalid_input");
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return fail("invalid_email");
  const policy = validatePassword(password, email);
  if (policy) return fail("invalid_password", policy);
  if (confirm !== undefined && confirm !== password) return fail("password_mismatch");

  // Checked before the duplicate test so a closed sign-up doesn't reveal which emails exist.
  if ((await countUsers()) > 0 && !signupAllowlist(env).has(email)) return fail("signup_closed");
  // Pre-check so a duplicate doesn't pay for a hash; createUser still enforces uniqueness.
  if (await findUserByEmail(email)) return fail("email_taken");
  const user = await createUser({ email, password_hash: await hashPassword(password, hashParams) });
  if (!user) return fail("email_taken");
  return { ok: true, user: { id: user.id, email: user.email } };
}

export async function logIn(input: { email: unknown; password: unknown }): Promise<AuthOutcome> {
  const { password } = input;
  if (typeof input.email !== "string" || typeof password !== "string" || !input.email.trim() || !password) {
    return fail("invalid_input");
  }
  const email = normalizeEmail(input.email);
  const user = isValidEmail(email) ? await findUserByEmail(email) : null;
  // Unknown email: verify against a dummy hash anyway so timing doesn't reveal whether the account exists.
  const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !ok) return fail("invalid_credentials");
  return { ok: true, user: { id: user.id, email: user.email } };
}
