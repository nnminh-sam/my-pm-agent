import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HS256 compact JWTs for web sessions and API bearer tokens (node:crypto only).
 * `verifyJwt` never throws on untrusted input — any defect yields null. A short secret is
 * misconfiguration, so sign/verify throw on it.
 */

export const JWT_ISSUER = "my_pm";
export const JWT_MIN_SECRET_LENGTH = 32;

// Session policy: 2 h tokens, re-signed when < 1 h is left, never past 30 days since login.
export const SESSION_TTL_SECONDS = 2 * 60 * 60;
export const RENEW_BELOW_SECONDS = 60 * 60;
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type SessionClaims = {
  sub: string;
  email: string;
  iat: number;
  exp: number;
  iss: typeof JWT_ISSUER;
  auth_time: number;
};

export type JwtPayload = { sub: string; email: string; auth_time?: number };

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export function assertJwtSecret(secret: string | undefined): asserts secret is string {
  if (typeof secret !== "string" || secret.length < JWT_MIN_SECRET_LENGTH) {
    throw new Error(`JWT secret must be at least ${JWT_MIN_SECRET_LENGTH} characters`);
  }
}

/** Unix time in whole seconds. */
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function signJwt(
  payload: JwtPayload,
  secret: string,
  { ttlSeconds, now = nowSeconds() }: { ttlSeconds: number; now?: number },
): string {
  assertJwtSecret(secret);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("ttlSeconds must be a positive integer");
  if (!Number.isSafeInteger(now)) throw new Error("now must be an integer (seconds)");
  const claims: SessionClaims = {
    sub: payload.sub,
    email: payload.email,
    iat: now,
    exp: now + ttlSeconds,
    iss: JWT_ISSUER,
    auth_time: payload.auth_time ?? now,
  };
  const signingInput = `${HEADER}.${base64url(JSON.stringify(claims))}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function verifyJwt(token: string, secret: string, { now = nowSeconds() }: { now?: number } = {}): SessionClaims | null {
  assertJwtSecret(secret);
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  if (!header || header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")) return null;

  // Compare base64url strings (not decoded bytes) so non-canonical encodings of the signature fail too.
  const expected = Buffer.from(sign(`${headerPart}.${payloadPart}`, secret));
  const actual = Buffer.from(signaturePart);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const p = decodeJson(payloadPart);
  if (!p) return null;
  if (!nonEmptyString(p.sub) || !nonEmptyString(p.email) || p.iss !== JWT_ISSUER) return null;
  if (!isSeconds(p.iat) || !isSeconds(p.exp) || !isSeconds(p.auth_time)) return null;
  if (p.exp <= now) return null;
  return { sub: p.sub, email: p.email, iat: p.iat, exp: p.exp, iss: JWT_ISSUER, auth_time: p.auth_time };
}

/** A valid session should be re-signed (same auth_time) when it is close to expiry but within the absolute cap. */
export function shouldRenew(claims: Pick<SessionClaims, "exp" | "auth_time">, now: number): boolean {
  return claims.exp - now < RENEW_BELOW_SECONDS && now - claims.auth_time < SESSION_MAX_AGE_SECONDS;
}

function base64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64url");
}

function sign(input: string, secret: string) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
