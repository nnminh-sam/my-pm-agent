import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RENEW_BELOW_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_TTL_SECONDS,
  assertJwtSecret,
  shouldRenew,
  signJwt,
  verifyJwt,
} from "./jwt";

const SECRET = "s".repeat(32);
const OTHER = "o".repeat(32);
const NOW = 1_790_000_000;
const USER = { sub: "U-1", email: "me@example.com" };

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** Builds a correctly signed token from arbitrary header/payload, to test claim and header checks. */
function forge(header: unknown, payload: unknown, secret = SECRET) {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

const HS256 = { alg: "HS256", typ: "JWT" };
const claims = (over: Record<string, unknown> = {}) => ({
  ...USER,
  iat: NOW,
  exp: NOW + 60,
  iss: "my_pm",
  auth_time: NOW,
  ...over,
});

describe("signJwt / verifyJwt", () => {
  it("round-trips the claims, defaulting auth_time to iat", () => {
    const token = signJwt(USER, SECRET, { ttlSeconds: SESSION_TTL_SECONDS, now: NOW });
    expect(token.split(".")).toHaveLength(3);
    expect(verifyJwt(token, SECRET, { now: NOW })).toEqual({
      ...USER,
      iat: NOW,
      exp: NOW + SESSION_TTL_SECONDS,
      iss: "my_pm",
      auth_time: NOW,
    });
  });

  it("keeps an explicit auth_time and emits the fixed HS256 header", () => {
    const token = signJwt({ ...USER, auth_time: NOW - 100 }, SECRET, { ttlSeconds: 60, now: NOW });
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toEqual(HS256);
    expect(verifyJwt(token, SECRET, { now: NOW })?.auth_time).toBe(NOW - 100);
  });

  it("rejects at and after exp", () => {
    const token = signJwt(USER, SECRET, { ttlSeconds: 60, now: NOW });
    expect(verifyJwt(token, SECRET, { now: NOW + 59 })).not.toBeNull();
    expect(verifyJwt(token, SECRET, { now: NOW + 60 })).toBeNull();
    expect(verifyJwt(token, SECRET, { now: NOW + 3600 })).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const [h, , s] = signJwt(USER, SECRET, { ttlSeconds: 60, now: NOW }).split(".");
    const token = `${h}.${b64(claims({ sub: "U-2" }))}.${s}`;
    expect(verifyJwt(token, SECRET, { now: NOW })).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signJwt(USER, SECRET, { ttlSeconds: 60, now: NOW });
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(verifyJwt(token.slice(0, -1) + last, SECRET, { now: NOW })).toBeNull();
    expect(verifyJwt(token.slice(0, -2), SECRET, { now: NOW })).toBeNull();
    expect(verifyJwt(token + "A", SECRET, { now: NOW })).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = signJwt(USER, OTHER, { ttlSeconds: 60, now: NOW });
    expect(verifyJwt(token, SECRET, { now: NOW })).toBeNull();
  });

  it("accepts only an HS256 header", () => {
    expect(verifyJwt(forge(HS256, claims()), SECRET, { now: NOW })).not.toBeNull();
    expect(verifyJwt(forge({ alg: "HS256" }, claims()), SECRET, { now: NOW })).not.toBeNull();
    for (const header of [{ alg: "HS512", typ: "JWT" }, { alg: "hs256" }, { typ: "JWT" }, { alg: "HS256", typ: "JWS" }, [], "x"]) {
      expect(verifyJwt(forge(header, claims()), SECRET, { now: NOW })).toBeNull();
    }
    // alg "none" with an empty signature segment
    expect(verifyJwt(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims())}.`, SECRET, { now: NOW })).toBeNull();
    expect(verifyJwt(`${b64({ alg: "none" })}.${b64(claims())}`, SECRET, { now: NOW })).toBeNull();
  });

  it("returns null for malformed tokens without throwing", () => {
    const good = signJwt(USER, SECRET, { ttlSeconds: 60, now: NOW });
    const [h, p, s] = good.split(".");
    for (const token of [
      "",
      ".",
      "..",
      `${h}.${p}`,
      `${good}.${s}`,
      `${h}.${p}.`,
      "a.b.c",
      "***.***.***",
      `${h}.${p}=.${s}`,
      `${h}.${b64("not json")}.${s}`,
      forge(HS256, "not json"),
      forge(HS256, null),
      forge(HS256, [1, 2]),
      forge("{not json", claims()),
    ]) {
      expect(verifyJwt(token, SECRET, { now: NOW })).toBeNull();
    }
    expect(verifyJwt(undefined as unknown as string, SECRET, { now: NOW })).toBeNull();
  });

  it("rejects a wrong issuer and missing or mistyped claims", () => {
    expect(verifyJwt(forge(HS256, claims({ iss: "other" })), SECRET, { now: NOW })).toBeNull();
    expect(verifyJwt(forge(HS256, claims({ iss: undefined })), SECRET, { now: NOW })).toBeNull();
    for (const over of [
      { sub: undefined },
      { sub: "" },
      { sub: 1 },
      { email: undefined },
      { email: ["me@example.com"] },
      { iat: "1790000000" },
      { exp: undefined },
      { exp: NOW + 0.5 },
      { auth_time: undefined },
      { auth_time: null },
    ]) {
      expect(verifyJwt(forge(HS256, claims(over)), SECRET, { now: NOW })).toBeNull();
    }
  });

  it("returns only the known claims", () => {
    const verified = verifyJwt(forge(HS256, claims({ admin: true })), SECRET, { now: NOW });
    expect(verified).toEqual(claims());
  });
});

describe("JWT secret", () => {
  it("refuses a secret shorter than 32 characters", () => {
    const short = "x".repeat(31);
    expect(() => assertJwtSecret(short)).toThrow(/32/);
    expect(() => assertJwtSecret(undefined)).toThrow();
    expect(() => assertJwtSecret(SECRET)).not.toThrow();
    expect(() => signJwt(USER, short, { ttlSeconds: 60, now: NOW })).toThrow();
    const token = signJwt(USER, SECRET, { ttlSeconds: 60, now: NOW });
    expect(() => verifyJwt(token, short, { now: NOW })).toThrow();
    expect(() => verifyJwt(token, "", { now: NOW })).toThrow();
  });

  it("refuses a non-positive ttl", () => {
    expect(() => signJwt(USER, SECRET, { ttlSeconds: 0, now: NOW })).toThrow();
  });
});

describe("shouldRenew", () => {
  const session = (expIn: number, loggedInAgo: number) => ({ exp: NOW + expIn, auth_time: NOW - loggedInAgo });

  it("exports the session policy", () => {
    expect(SESSION_TTL_SECONDS).toBe(7200);
    expect(RENEW_BELOW_SECONDS).toBe(3600);
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 86400);
  });

  it("renews only when less than an hour is left", () => {
    expect(shouldRenew(session(SESSION_TTL_SECONDS, 0), NOW)).toBe(false);
    expect(shouldRenew(session(RENEW_BELOW_SECONDS, 0), NOW)).toBe(false);
    expect(shouldRenew(session(RENEW_BELOW_SECONDS - 1, 0), NOW)).toBe(true);
    expect(shouldRenew(session(1, 0), NOW)).toBe(true);
  });

  it("stops renewing 30 days after login", () => {
    expect(shouldRenew(session(60, SESSION_MAX_AGE_SECONDS - 1), NOW)).toBe(true);
    expect(shouldRenew(session(60, SESSION_MAX_AGE_SECONDS), NOW)).toBe(false);
    expect(shouldRenew(session(60, SESSION_MAX_AGE_SECONDS + 86400), NOW)).toBe(false);
  });

  it("works on verified claims: a renewed token keeps auth_time", () => {
    const first = verifyJwt(signJwt(USER, SECRET, { ttlSeconds: SESSION_TTL_SECONDS, now: NOW }), SECRET, { now: NOW })!;
    const later = NOW + SESSION_TTL_SECONDS - 60;
    expect(shouldRenew(first, later)).toBe(true);
    const renewed = verifyJwt(
      signJwt({ sub: first.sub, email: first.email, auth_time: first.auth_time }, SECRET, { ttlSeconds: SESSION_TTL_SECONDS, now: later }),
      SECRET,
      { now: later },
    )!;
    expect(renewed.auth_time).toBe(NOW);
    expect(renewed.exp).toBe(later + SESSION_TTL_SECONDS);
  });
});
