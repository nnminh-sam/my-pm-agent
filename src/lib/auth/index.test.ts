import { describe, expect, it } from "vitest";
import {
  authMode,
  authenticate,
  bearerToken,
  isAuthorized,
  issueSession,
  lockedMessage,
  renewSession,
  safeNext,
} from "./index";
import { RENEW_BELOW_SECONDS, SESSION_MAX_AGE_SECONDS, SESSION_TTL_SECONDS, signJwt, verifyJwt } from "./jwt";

const JWT_SECRET = "j".repeat(32);
const PM_SECRET = "agent-secret-0123456789";
const NOW = 1_790_000_000;
const env = { JWT_SECRET, PM_SECRET };
const USER = { id: "U-1", email: "me@example.com" };

const token = (over: { now?: number; secret?: string; auth_time?: number } = {}) =>
  signJwt({ sub: USER.id, email: USER.email, auth_time: over.auth_time }, over.secret ?? JWT_SECRET, {
    ttlSeconds: SESSION_TTL_SECONDS,
    now: over.now ?? NOW,
  });

describe("authMode", () => {
  it("is jwt with JWT_SECRET, else open locally and locked on Vercel", () => {
    expect(authMode({ JWT_SECRET })).toBe("jwt");
    expect(authMode({ JWT_SECRET, VERCEL: "1" })).toBe("jwt");
    expect(authMode({})).toBe("open");
    expect(authMode({ PM_SECRET })).toBe("open");
    expect(authMode({ VERCEL: "1", PM_SECRET })).toBe("locked");
  });

  it("is locked, with its own message, when JWT_SECRET is shorter than 32 characters", async () => {
    expect(authMode({ JWT_SECRET: "x".repeat(31) })).toBe("locked");
    expect(authMode({ JWT_SECRET: "x".repeat(31), VERCEL: "1" })).toBe("locked");
    expect(authMode({ JWT_SECRET: "x".repeat(32) })).toBe("jwt");
    expect(lockedMessage({ JWT_SECRET: "short" })).toMatch(/^JWT_SECRET must be at least 32 characters/);
    expect(lockedMessage({ VERCEL: "1" })).toMatch(/^JWT_SECRET isn't configured/);
    // Tokens are simply not accepted (no throw from the short secret).
    expect(await isAuthorized({ sessionCookie: token() }, { env: { JWT_SECRET: "short", PM_SECRET }, now: NOW })).toBe(false);
    expect(authenticate({ authorization: `Bearer ${token()}` }, { env: { JWT_SECRET: "short" }, now: NOW })).toBeNull();
  });
});

describe("authenticate", () => {
  const opts = { env, now: NOW };

  it("accepts a session JWT as Bearer or cookie", () => {
    expect(authenticate({ authorization: `Bearer ${token()}` }, opts)).toMatchObject({ sub: "U-1", email: USER.email });
    expect(authenticate({ sessionCookie: token() }, opts)).toMatchObject({ sub: "U-1" });
    expect(authenticate({ authorization: `bearer  ${token()}` }, opts)).toMatchObject({ sub: "U-1" });
  });

  it("accepts Bearer PM_SECRET as the agent, only when PM_SECRET is set", () => {
    expect(authenticate({ authorization: `Bearer ${PM_SECRET}` }, opts)).toBe("agent");
    expect(authenticate({ authorization: `Bearer ${PM_SECRET}` }, { env: { JWT_SECRET }, now: NOW })).toBeNull();
    expect(authenticate({ authorization: `Bearer ${PM_SECRET}x` }, opts)).toBeNull();
    expect(authenticate({ authorization: `Bearer ${PM_SECRET.slice(1)}` }, opts)).toBeNull();
    expect(authenticate({ authorization: "Bearer " }, { env: { JWT_SECRET, PM_SECRET: "" }, now: NOW })).toBeNull();
  });

  it("rejects missing, expired, tampered and foreign tokens", () => {
    expect(authenticate({}, opts)).toBeNull();
    expect(authenticate({ sessionCookie: "" }, opts)).toBeNull();
    expect(authenticate({ sessionCookie: token({ now: NOW - SESSION_TTL_SECONDS }) }, opts)).toBeNull();
    expect(authenticate({ sessionCookie: token({ secret: "x".repeat(32) }) }, opts)).toBeNull();
    const [h, p, s] = token().split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "U-2" }));
    expect(authenticate({ sessionCookie: `${h}.${forged.toString("base64url")}.${s}` }, opts)).toBeNull();
    expect(authenticate({ authorization: `Bearer ${h}.${p}.${s.slice(0, -2)}AA` }, opts)).toBeNull();
    expect(authenticate({ authorization: `Basic ${Buffer.from("a:b").toString("base64")}` }, opts)).toBeNull();
  });

  it("lets a present Bearer header decide, without falling back to the cookie", () => {
    expect(authenticate({ authorization: "Bearer wrong", sessionCookie: token() }, opts)).toBeNull();
    expect(authenticate({ authorization: "Basic abc", sessionCookie: token() }, opts)).toMatchObject({ sub: "U-1" });
  });

  it("ignores JWTs when JWT_SECRET is unset", () => {
    expect(authenticate({ sessionCookie: token() }, { env: {}, now: NOW })).toBeNull();
    expect(authenticate({ authorization: `Bearer ${token()}` }, { env: {}, now: NOW })).toBeNull();
  });
});

describe("isAuthorized", () => {
  it("allows everything when open, nothing when locked, valid credentials in jwt mode", async () => {
    expect(await isAuthorized({}, { env: {} })).toBe(true);
    expect(await isAuthorized({ authorization: `Bearer ${PM_SECRET}` }, { env: { VERCEL: "1", PM_SECRET } })).toBe(false);
    expect(await isAuthorized({}, { env, now: NOW })).toBe(false);
    expect(await isAuthorized({ sessionCookie: token() }, { env, now: NOW })).toBe(true);
    expect(await isAuthorized({ authorization: `Bearer ${PM_SECRET}` }, { env, now: NOW })).toBe(true);
  });
});

describe("sessions", () => {
  it("issues a verifiable 2 h token", () => {
    const session = issueSession(USER, { env, now: NOW });
    expect(session.expires_at).toBe(new Date((NOW + SESSION_TTL_SECONDS) * 1000).toISOString());
    expect(verifyJwt(session.token, JWT_SECRET, { now: NOW })).toMatchObject({ sub: "U-1", email: USER.email, auth_time: NOW });
  });

  it("renews near expiry with the same auth_time, and never past the absolute cap", () => {
    const claims = verifyJwt(token(), JWT_SECRET, { now: NOW })!;
    expect(renewSession(claims, { env, now: NOW + 60 })).toBeNull();
    const later = NOW + SESSION_TTL_SECONDS - RENEW_BELOW_SECONDS + 1;
    const renewed = renewSession(claims, { env, now: later })!;
    expect(verifyJwt(renewed.token, JWT_SECRET, { now: later })).toMatchObject({ auth_time: NOW, exp: later + SESSION_TTL_SECONDS });

    const old = NOW - SESSION_MAX_AGE_SECONDS;
    const stale = verifyJwt(token({ auth_time: old }), JWT_SECRET, { now: NOW })!;
    expect(renewSession(stale, { env, now: later })).toBeNull();
  });
});

describe("helpers", () => {
  it("parses Bearer tokens", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it("only returns same-origin paths from safeNext", () => {
    expect(safeNext("/tasks/T-1?x=1")).toBe("/tasks/T-1?x=1");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});
