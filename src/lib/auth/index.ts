import { createHash, timingSafeEqual } from "node:crypto";
import {
  JWT_MIN_SECRET_LENGTH,
  SESSION_TTL_SECONDS,
  nowSeconds,
  shouldRenew,
  signJwt,
  verifyJwt,
  type SessionClaims,
} from "./jwt";
import { looksLikeApiKey, verifyApiKey } from "./api-keys";

/**
 * Auth modes, sessions and request authentication, shared by proxy.ts, the MCP route and server actions.
 * - `JWT_SECRET` set → "jwt": users log in with email + password and get a 2 h HS256 session (cookie or bearer).
 *   Agents send `Authorization: Bearer <key>` with an API key (`pm_…`, see api-keys.ts; issued with
 *   `npm run auth:create-key`), or `Bearer <PM_SECRET>` while PM_SECRET is set (transition period).
 * - otherwise "open" locally (no login) and "locked" on Vercel (everything denied, API keys included); a
 *   JWT_SECRET shorter than 32 characters also locks the app.
 * `authenticate` is synchronous and checks JWTs and PM_SECRET only; `authenticateRequest`/`isAuthorized`
 * add the API-key lookup, which only a `pm_`-shaped Bearer token triggers (so JWTs and PM_SECRET never
 * cost a query) and which fails closed on repository errors.
 * Everything takes `env`/`now` so it can be tested without Next's request context. Never log tokens or keys.
 */

export type { SessionClaims } from "./jwt";

export const SESSION_COOKIE = "pm_session";

export type AuthMode = "jwt" | "open" | "locked";
type Env = Record<string, string | undefined>;
type Opts = { env?: Env; now?: number };

/** A signed-in user's claims, or "agent" for a Bearer API key or PM_SECRET. */
export type AuthResult = SessionClaims | "agent";

/** A JWT_SECRET that is set but shorter than 32 characters is misconfiguration: the app is locked, not open. */
export function authMode(env: Env = process.env): AuthMode {
  if (env.JWT_SECRET) return env.JWT_SECRET.length >= JWT_MIN_SECRET_LENGTH ? "jwt" : "locked";
  return env.VERCEL ? "locked" : "open";
}

/** Why the app is "locked", shown by the proxy's 401, the auth routes' 503 and the login/sign-up pages. */
export function lockedMessage(env: Env = process.env): string {
  return env.JWT_SECRET
    ? `JWT_SECRET must be at least ${JWT_MIN_SECRET_LENGTH} characters, so the app is locked. Set a longer one (openssl rand -hex 32) and restart or redeploy.`
    : `JWT_SECRET isn't configured on this deployment, so the app is locked. Set it (at least ${JWT_MIN_SECRET_LENGTH} characters) and redeploy.`;
}

/** True when agents can use `Authorization: Bearer <PM_SECRET>`. */
export function hasAgentSecret(env: Env = process.env) {
  return Boolean(env.PM_SECRET);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** HTTPS on Vercel (x-forwarded-proto); plain http when running `next start` locally. */
export function isSecureRequest(forwardedProto: string | null | undefined, env: Env = process.env) {
  return forwardedProto ? forwardedProto === "https" : env.NODE_ENV === "production";
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: SESSION_TTL_SECONDS };
}

/** Options that expire the session cookie (same attributes, so the browser replaces it). */
export function clearedSessionCookieOptions(secure: boolean) {
  return { ...sessionCookieOptions(secure), maxAge: 0 };
}

export type Session = { token: string; expires_at: string };

function toSession(token: string, exp: number): Session {
  return { token, expires_at: new Date(exp * 1000).toISOString() };
}

/** Signs a fresh session token for a user who just signed up or logged in. */
export function issueSession(user: { id: string; email: string }, { env = process.env, now = nowSeconds() }: Opts = {}): Session {
  const token = signJwt({ sub: user.id, email: user.email }, env.JWT_SECRET!, { ttlSeconds: SESSION_TTL_SECONDS, now });
  return toSession(token, now + SESSION_TTL_SECONDS);
}

/** Sliding renewal: a re-signed token (same auth_time) when the session is near expiry, else null. */
export function renewSession(claims: SessionClaims, { env = process.env, now = nowSeconds() }: Opts = {}): Session | null {
  if (!shouldRenew(claims, now)) return null;
  const payload = { sub: claims.sub, email: claims.email, auth_time: claims.auth_time };
  const token = signJwt(payload, env.JWT_SECRET!, { ttlSeconds: SESSION_TTL_SECONDS, now });
  return toSession(token, now + SESSION_TTL_SECONDS);
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

export type Credentials = { authorization?: string | null; sessionCookie?: string | null };

/** The token of an `Authorization: Bearer <token>` header, else null. */
export function bearerToken(authorization: string | null | undefined): string | null {
  return authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;
}

// Hash both sides first so the comparison doesn't leak the secret's length.
function safeEqual(a: string, b: string) {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Checks the request's credentials, synchronously and without API keys (see `authenticateRequest`).
 * A Bearer header decides on its own (a JWT, or PM_SECRET → "agent"); otherwise the session cookie is
 * checked. Expired, tampered or unknown tokens yield null. JWTs are only accepted in "jwt" mode; callers
 * handle the "open"/"locked" modes (see `isAuthorized`).
 */
export function authenticate(
  { authorization, sessionCookie }: Credentials,
  { env = process.env, now = nowSeconds() }: Opts = {},
): AuthResult | null {
  const jwtSecret = authMode(env) === "jwt" ? env.JWT_SECRET! : null;
  const bearer = bearerToken(authorization);
  if (bearer) {
    if (jwtSecret) {
      const claims = verifyJwt(bearer, jwtSecret, { now });
      if (claims) return claims;
    }
    return env.PM_SECRET && safeEqual(bearer, env.PM_SECRET) ? "agent" : null;
  }
  if (sessionCookie && jwtSecret) return verifyJwt(sessionCookie, jwtSecret, { now });
  return null;
}

/**
 * `authenticate`, plus agent API keys: in "jwt" mode a `pm_`-shaped Bearer token that isn't a JWT or
 * PM_SECRET is looked up (by hash) and, when active, yields "agent". The Bearer header still decides on
 * its own: a malformed, unknown or revoked key is null, never a fallback to the cookie. A repository
 * error during the lookup also yields null (fail closed), and is logged without the key or its hash.
 */
export async function authenticateRequest(credentials: Credentials, { env = process.env, now }: Opts = {}): Promise<AuthResult | null> {
  const auth = authenticate(credentials, { env, now });
  if (auth || authMode(env) !== "jwt") return auth;
  const bearer = bearerToken(credentials.authorization);
  if (!bearer || !looksLikeApiKey(bearer)) return null;
  try {
    const key = await verifyApiKey(bearer, { now: now === undefined ? new Date() : new Date(now * 1000) });
    return key ? "agent" : null;
  } catch (error) {
    // The error's name only: a driver message could echo query parameters (the key's hash).
    console.error(`API key lookup failed (${error instanceof Error ? error.name : typeof error}); request refused`);
    return null;
  }
}

/** Access decision for a request: always in "open" mode, never in "locked" mode, else valid credentials. */
export async function isAuthorized(credentials: Credentials, opts: Opts = {}): Promise<boolean> {
  const mode = authMode(opts.env ?? process.env);
  if (mode === "open") return true;
  if (mode === "locked") return false;
  return (await authenticateRequest(credentials, opts)) !== null;
}

/** A same-origin path to return to after login (no `//host` or `/\host`), else "/". */
export function safeNext(value: unknown): string {
  const next = typeof value === "string" ? value : "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
