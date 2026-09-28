import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  authMode,
  clearedSessionCookieOptions,
  isSecureRequest,
  issueSession,
  lockedMessage,
  sessionCookieOptions,
} from "./index";
import { AUTH_ERROR_STATUS, type AuthOutcome } from "./users";

/** Helpers for the JSON routes under /api/auth. Responses carry tokens, so they're never cached. */

const NO_STORE = { "Cache-Control": "no-store" };

function secure(request: NextRequest) {
  return isSecureRequest(request.headers.get("x-forwarded-proto"));
}

export function jsonError(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status, headers: NO_STORE });
}

/** 503 unless JWT_SECRET is configured (and long enough); null when auth routes can proceed. */
export function requireJwtMode(): NextResponse | null {
  const mode = authMode();
  if (mode === "jwt") return null;
  const message = mode === "locked" ? lockedMessage() : "JWT_SECRET is not configured, so accounts are disabled.";
  return jsonError(503, "not_configured", message);
}

/**
 * Reads `{ email, password, confirm? }` from a JSON body. Requiring application/json also means a
 * cross-site form can't post here without a CORS preflight.
 */
export async function readCredentials(request: NextRequest): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function invalidBody() {
  return jsonError(400, "invalid_input", "Send a JSON body: { \"email\": \"…\", \"password\": \"…\" }.");
}

/** Maps a sign-up/login outcome to a response; on success issues a session and sets the cookie too. */
export function sessionResponse(request: NextRequest, outcome: AuthOutcome, successStatus: number) {
  if (!outcome.ok) return jsonError(AUTH_ERROR_STATUS[outcome.error], outcome.error, outcome.message);
  const session = issueSession(outcome.user);
  const response = NextResponse.json({ ...session, user: outcome.user }, { status: successStatus, headers: NO_STORE });
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(secure(request)));
  return response;
}

export function logoutResponse(request: NextRequest) {
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions(secure(request)));
  return response;
}
