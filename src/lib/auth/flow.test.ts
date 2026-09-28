import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { ModeNotice } from "@/components/auth-form";
import { proxy } from "@/proxy";
import type { Db, Row } from "../db";
import { migrate } from "../migrate";
import * as repo from "../repo";
import { setRepository } from "../repository";
import { FileRepository } from "../repository/file";
import { PgRepository } from "../repository/postgres";
import { FsStore } from "../store/fs";
import { SESSION_COOKIE, authMode, lockedMessage } from "./index";
import { SESSION_MAX_AGE_SECONDS, SESSION_TTL_SECONDS, signJwt, verifyJwt } from "./jwt";
import { getDummyHash } from "./password";

/**
 * End-to-end auth: the real /api/auth route handlers, src/proxy.ts and the /api/mcp handler, driven with
 * NextRequests against a temp-dir FileRepository and PGlite. Passwords use the production scrypt cost
 * (the routes don't take hash params), so the suite hashes as little as it can.
 */

const BASE = "http://localhost:3000";
const JWT_SECRET = "flow-test-jwt-secret-".padEnd(48, "0");
const PM_SECRET = "flow-test-agent-secret-0123456789";
const T0 = Date.UTC(2026, 8, 27, 2, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const OWNER = { email: "me@example.com", password: "correct horse battery" };
const INVITED = { email: "friend@example.com", password: "another long password" };

// Everything that must never reach the console: passwords, hashes, tokens.
const secrets = new Set<string>([OWNER.password, INVITED.password, PM_SECRET, JWT_SECRET]);

// ---------------------------------------------------------------------------
// Environment, clock, console
// ---------------------------------------------------------------------------

type Env = { JWT_SECRET?: string; PM_SECRET?: string; PM_SIGNUP_EMAILS?: string; VERCEL?: string };
function useEnv(env: Env) {
  for (const key of ["JWT_SECRET", "PM_SECRET", "PM_SIGNUP_EMAILS", "VERCEL"] as const) vi.stubEnv(key, env[key]);
}

// Recorded in our own buffer, not via spy.mock.calls: vitest clears mock calls before every test (clearMocks).
const consoleOutput: string[] = [];
beforeAll(() => {
  // Only Date is faked: scrypt, PGlite and streams keep real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(format(...args));
      original(...args);
    });
  }
});
beforeEach(() => {
  vi.setSystemTime(T0);
  useEnv({ JWT_SECRET, PM_SECRET });
});
afterEach(() => vi.unstubAllEnvs());

const tempDirs: string[] = [];
afterAll(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setRepository(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fileRepository() {
  const dir = await mkdtemp(path.join(tmpdir(), "my-pm-auth-"));
  tempDirs.push(dir);
  return { repository: new FileRepository(new FsStore(dir)), dir };
}

// Mirrors the PGlite helper in repo.test.ts.
async function pgliteRepository() {
  const pg = new PGlite();
  const query = async (text: string, params?: unknown[]) => (await pg.query<Row>(text, params)).rows;
  await migrate({ exec: async (sql) => void (await pg.exec(sql)), query });
  const db: Db = {
    query,
    transaction: (statements) =>
      pg.transaction(async (tx) => {
        const results: Row[][] = [];
        for (const s of statements) results.push((await tx.query<Row>(s.text, s.params)).rows);
        return results;
      }),
  };
  return { repository: new PgRepository(db), dir: undefined };
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

type Credentials = { bearer?: string; cookie?: string };

function request(pathname: string, { bearer, cookie }: Credentials = {}, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers = new Headers(init.headers);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
  return new NextRequest(BASE + pathname, { method: init.method ?? "GET", headers, body: init.body });
}

function jsonPost(pathname: string, body: unknown, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return request(pathname, {}, { method: "POST", headers: { "content-type": contentType }, body: text });
}

/** A JSON-RPC tools/list call; the stateless MCP handler answers it without an initialize handshake. */
function mcpRequest(credentials: Credentials) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  return request("/api/mcp", credentials, { method: "POST", headers, body });
}

const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

/** The session cookie a response sets (value "" when it clears it), or null. Records tokens as secrets. */
function sessionCookie(res: Response): { value: string; header: string } | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!header) return null;
  const value = header.slice(SESSION_COOKIE.length + 1).split(";")[0];
  if (value) secrets.add(value);
  return { value, header };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.token === "string") secrets.add(body.token);
  return body;
}

async function signUp(body: unknown, contentType?: string) {
  const res = await signupRoute(jsonPost("/api/auth/signup", body, contentType));
  return { res, body: await readJson(res) };
}

async function logIn(body: unknown, contentType?: string) {
  const res = await loginRoute(jsonPost("/api/auth/login", body, contentType));
  return { res, body: await readJson(res) };
}

function claimsOf(token: string, now = Date.now()) {
  return verifyJwt(token, JWT_SECRET, { now: Math.floor(now / 1000) });
}

function expectLoginRedirect(res: Response, next: string) {
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(`${BASE}/login?next=${encodeURIComponent(next)}`);
}

async function expectUnauthorizedJson(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe('Bearer realm="pm"');
  return (await res.json()) as { error: string; message?: string };
}

function expectCleared(res: Response) {
  const cookie = sessionCookie(res);
  expect(cookie?.value).toBe("");
  expect(cookie?.header).toMatch(/Max-Age=0/i);
}

// ---------------------------------------------------------------------------
// Accounts, on both backends
// ---------------------------------------------------------------------------

describe.each([
  { name: "fs", setup: fileRepository },
  { name: "postgres (pglite)", setup: pgliteRepository },
])("accounts ($name backend)", ({ setup }) => {
  let dir: string | undefined;
  beforeAll(async () => {
    const backend = await setup();
    dir = backend.dir;
    setRepository(backend.repository);
  });
  afterAll(async () => {
    // The stored hashes must not leak either.
    for (const email of [OWNER.email, INVITED.email]) {
      const hash = (await repo.findUserByEmail(email))?.password_hash;
      if (hash) secrets.add(hash);
    }
  });

  it("signs up the first account (201) and logs in with the same credentials (200)", async () => {
    const signup = await signUp({ email: "  Me@Example.COM ", password: OWNER.password, confirm: OWNER.password });
    expect(signup.res.status).toBe(201);
    expect(signup.res.headers.get("cache-control")).toBe("no-store");
    const expiresAt = new Date(T0 + SESSION_TTL_SECONDS * 1000).toISOString();
    expect(signup.body).toEqual({ token: expect.any(String), expires_at: expiresAt, user: { id: "U-1", email: OWNER.email } });
    expect(claimsOf(signup.body.token as string)).toMatchObject({ sub: "U-1", email: OWNER.email, auth_time: T0 / 1000 });

    // The same token is set as an httpOnly cookie.
    const cookie = sessionCookie(signup.res)!;
    expect(cookie.value).toBe(signup.body.token);
    expect(cookie.header).toMatch(/HttpOnly/i);
    expect(cookie.header).toMatch(/SameSite=lax/i);
    expect(cookie.header).toMatch(/Path=\//);
    expect(cookie.header).toMatch(new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));

    vi.setSystemTime(T0 + MINUTE);
    const login = await logIn({ email: "ME@example.com", password: OWNER.password });
    expect(login.res.status).toBe(200);
    expect(login.body).toMatchObject({ user: { id: "U-1", email: OWNER.email } });
    expect(sessionCookie(login.res)?.value).toBe(login.body.token);
    expect(claimsOf(login.body.token as string)).toMatchObject({ sub: "U-1", auth_time: T0 / 1000 + 60 });

    if (dir) {
      const text = await readFile(path.join(dir, "users/U-1.md"), "utf8");
      expect(text).toMatch(/password_hash: scrypt\$17\$8\$1\$/);
      expect(text).not.toContain(OWNER.password);
    }
  });

  it("answers a wrong password and an unknown email with the same generic 401", async () => {
    const wrong = await logIn({ email: OWNER.email, password: "not the right password" });
    const unknown = await logIn({ email: "nobody@example.com", password: OWNER.password });
    for (const { res } of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(sessionCookie(res)).toBeNull();
    }
    expect(wrong.body).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
    expect(unknown.body).toEqual(wrong.body);
  });

  it("closes sign-up after the first account (403) and lets PM_SIGNUP_EMAILS in; a taken email is 409", async () => {
    const closed = await signUp({ email: INVITED.email, password: INVITED.password });
    expect(closed.res.status).toBe(403);
    expect(closed.body).toMatchObject({ error: "signup_closed" });
    // Closed sign-up doesn't reveal which emails exist.
    expect((await signUp({ email: OWNER.email, password: OWNER.password })).body).toMatchObject({ error: "signup_closed" });

    vi.stubEnv("PM_SIGNUP_EMAILS", ` ${OWNER.email}, Friend@Example.com `);
    const invited = await signUp({ email: INVITED.email, password: INVITED.password });
    expect(invited.res.status).toBe(201);
    expect(invited.body).toMatchObject({ user: { id: "U-2", email: INVITED.email } });

    const taken = await signUp({ email: "FRIEND@example.com", password: INVITED.password });
    expect(taken.res.status).toBe(409);
    expect(taken.body).toEqual({ error: "email_taken", message: "An account with this email already exists." });
    expect(sessionCookie(taken.res)).toBeNull();

    const stranger = await signUp({ email: "stranger@example.com", password: INVITED.password });
    expect(stranger.res.status).toBe(403);
    expect(await repo.countUsers()).toBe(2);
  });

  it("rejects invalid input with 400", async () => {
    const cases: [label: string, send: () => ReturnType<typeof signUp>, error: string][] = [
      ["form-encoded body", () => signUp(`email=a%40b.co&password=${"x".repeat(12)}`, "application/x-www-form-urlencoded"), "invalid_input"],
      ["JSON sent as text/plain", () => signUp({ email: "new@example.com", password: "long enough pw" }, "text/plain"), "invalid_input"],
      ["malformed JSON", () => signUp("{ email: ", "application/json"), "invalid_input"],
      ["a JSON array", () => signUp([OWNER.email, OWNER.password]), "invalid_input"],
      ["missing fields", () => signUp({}), "invalid_input"],
      ["a non-string email", () => signUp({ email: 42, password: "long enough pw" }), "invalid_input"],
      ["an invalid email", () => signUp({ email: "not-an-email", password: "long enough pw" }), "invalid_email"],
      ["a short password", () => signUp({ email: "new@example.com", password: "short" }), "invalid_password"],
      ["an over-long password", () => signUp({ email: "new@example.com", password: "x".repeat(257) }), "invalid_password"],
      ["password = email", () => signUp({ email: "someone@example.com", password: "Someone@Example.com" }), "invalid_password"],
      ["a confirmation mismatch", () => signUp({ email: "new@example.com", password: "long enough pw", confirm: "long enough pW" }), "password_mismatch"],
      ["login: form-encoded body", () => logIn(`email=me&password=pw`, "application/x-www-form-urlencoded"), "invalid_input"],
      ["login: empty fields", () => logIn({ email: " ", password: "" }), "invalid_input"],
      ["login: missing password", () => logIn({ email: OWNER.email }), "invalid_input"],
    ];
    for (const [label, send, error] of cases) {
      const { res, body } = await send();
      expect({ label, status: res.status, error: body.error }).toEqual({ label, status: 400, error });
      expect(typeof body.message).toBe("string");
      expect(sessionCookie(res)).toBeNull();
    }
    expect(await repo.countUsers()).toBe(2);
  });

  it("lets a session JWT through the proxy and the /api/mcp handler, as Bearer or cookie", async () => {
    const { body } = await logIn({ email: OWNER.email, password: OWNER.password });
    const token = body.token as string;
    for (const credentials of [{ bearer: token }, { cookie: token }]) {
      expect(passes(await proxy(mcpRequest(credentials)))).toBe(true);
      const res = await mcpRoute(mcpRequest(credentials));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("get_overview");
    }
    // Pages too, with the cookie.
    expect(passes(await proxy(request("/backlog", { cookie: token })))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sessions: rejection, renewal, logout, the agent bearer
// ---------------------------------------------------------------------------

describe("sessions", () => {
  let token: string; // issued at T0 by the sign-up route
  beforeAll(async () => {
    setRepository((await fileRepository()).repository);
    vi.setSystemTime(T0);
    useEnv({ JWT_SECRET, PM_SECRET });
    const { res, body } = await signUp({ email: OWNER.email, password: OWNER.password });
    expect(res.status).toBe(201);
    token = body.token as string;
    vi.unstubAllEnvs();
  });

  function badTokens(): [label: string, token: string][] {
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const none = b64({ alg: "none", typ: "JWT" });
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    return [
      ["tampered payload", `${header}.${b64({ ...claims, sub: "U-2", email: "friend@example.com" })}.${signature}`],
      ["tampered signature", `${header}.${payload}.${flipped}`],
      ["wrong secret", signJwt({ sub: claims.sub, email: claims.email }, "another-secret-".padEnd(40, "x"), { ttlSeconds: SESSION_TTL_SECONDS, now: T0 / 1000 })],
      ["alg:none, unsigned", `${none}.${payload}.`],
      ["alg:none, original signature", `${none}.${payload}.${signature}`],
      ["garbage", "not-a-jwt"],
    ];
  }

  it("accepts the fresh token (sanity check for the rejections below)", async () => {
    expect(passes(await proxy(mcpRequest({ bearer: token })))).toBe(true);
    expect(passes(await proxy(request("/tasks/T-1", { cookie: token })))).toBe(true);
  });

  it("gives expired, tampered, wrong-secret and alg:none tokens a 401 on /api and a login redirect on pages", async () => {
    vi.setSystemTime(T0 + 30 * MINUTE);
    const expired = ((): string => {
      // Issued 2 h ago: exp == now.
      const [, payload] = token.split(".");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const iat = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS;
      return signJwt({ sub: claims.sub, email: claims.email }, JWT_SECRET, { ttlSeconds: SESSION_TTL_SECONDS, now: iat });
    })();
    for (const [label, bad] of [["expired", expired] as [string, string], ...badTokens()]) {
      const api = await proxy(mcpRequest({ bearer: bad }));
      expect({ label, body: await expectUnauthorizedJson(api) }).toMatchObject({ label, body: { error: "unauthorized" } });
      expect(sessionCookie(api)).toBeNull(); // a bad Bearer doesn't touch the cookie

      const apiCookie = await proxy(mcpRequest({ cookie: bad }));
      await expectUnauthorizedJson(apiCookie);
      expectCleared(apiCookie);

      // The MCP route re-checks on its own.
      await expectUnauthorizedJson(await mcpRoute(mcpRequest({ bearer: bad })));
      await expectUnauthorizedJson(await mcpRoute(mcpRequest({ cookie: bad })));

      const page = await proxy(request("/tasks/T-1?tab=log", { cookie: bad }));
      expectLoginRedirect(page, "/tasks/T-1?tab=log");
      expectCleared(page);
    }
  });

  it("expires the real token after 2 hours", async () => {
    vi.setSystemTime(T0 + 2 * HOUR - 1000);
    expect(passes(await proxy(request("/", { cookie: token })))).toBe(true);
    vi.setSystemTime(T0 + 2 * HOUR);
    expectLoginRedirect(await proxy(request("/", { cookie: token })), "/");
  });

  it("redirects pages and 401s the API without credentials, leaving cookies alone", async () => {
    const page = await proxy(request("/"));
    expectLoginRedirect(page, "/");
    expect(sessionCookie(page)).toBeNull();
    const api = await proxy(mcpRequest({}));
    expect((await expectUnauthorizedJson(api)).message).toContain("Bearer");
  });

  it("lets a Bearer header take precedence over the cookie", async () => {
    const [, bad] = badTokens()[1];
    await expectUnauthorizedJson(await proxy(mcpRequest({ bearer: bad, cookie: token })));
    expect(passes(await proxy(mcpRequest({ bearer: token, cookie: bad })))).toBe(true);
    expect(passes(await proxy(mcpRequest({ bearer: PM_SECRET, cookie: bad })))).toBe(true);
  });

  it("renews the cookie in the session's last hour, keeping auth_time", async () => {
    vi.setSystemTime(T0 + 59 * MINUTE);
    const early = await proxy(request("/", { cookie: token }));
    expect(passes(early)).toBe(true);
    expect(sessionCookie(early)).toBeNull();

    const now = T0 + 61 * MINUTE;
    vi.setSystemTime(now);
    const late = await proxy(request("/", { cookie: token }));
    expect(passes(late)).toBe(true);
    const renewed = sessionCookie(late)!;
    expect(renewed.value).not.toBe(token);
    expect(renewed.header).toMatch(/HttpOnly/i);
    expect(renewed.header).toMatch(new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
    expect(claimsOf(renewed.value)).toMatchObject({ sub: "U-1", auth_time: T0 / 1000, exp: now / 1000 + SESSION_TTL_SECONDS });

    // Not when the token came as a Bearer header (the cookie wasn't used).
    expect(sessionCookie(await proxy(request("/api/mcp", { bearer: token })))).toBeNull();
  });

  it("stops renewing at the 30-day cap, so the session then expires", async () => {
    // A request every 90 minutes: each one lands in the token's last hour and renews it.
    const step = 90 * MINUTE;
    let current = token;
    let renewals = 0;
    let t = T0;
    let denied: Response | null = null;
    for (let i = 0; i < 1000 && !denied; i++) {
      t += step;
      vi.setSystemTime(t);
      const res = await proxy(request("/", { cookie: current }));
      if (!passes(res)) {
        denied = res;
        break;
      }
      const renewed = sessionCookie(res);
      if (renewed) {
        expect(claimsOf(renewed.value)?.auth_time).toBe(T0 / 1000);
        current = renewed.value;
        renewals++;
      }
    }
    const cap = SESSION_MAX_AGE_SECONDS * 1000;
    // Renewed at every step before the cap; the step at exactly 30 days passes without renewal; the next is refused.
    expect(renewals).toBe(cap / step - 1);
    expect(t - T0).toBe(cap + step);
    expectLoginRedirect(denied!, "/");
  });

  it("clears the cookie on logout", async () => {
    const logoutRequest = () => request("/api/auth/logout", { cookie: token }, { method: "POST" });
    expect(passes(await proxy(logoutRequest()))).toBe(true); // /api/auth/* is public
    const res = await logoutRoute(logoutRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectCleared(res);
    expect(sessionCookie(res)?.header).toMatch(/HttpOnly/i);
    // With the cookie gone, pages send the browser back to /login.
    expectLoginRedirect(await proxy(request("/")), "/");
  });

  it("skips /login for a signed-in user, but not for the agent bearer", async () => {
    const res = await proxy(request("/login?next=%2Fbacklog", { cookie: token }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/backlog`);
    expect(passes(await proxy(request("/login?next=//evil.example", {})))).toBe(true);
    expect((await proxy(request("/login?next=//evil.example", { cookie: token }))).headers.get("location")).toBe(`${BASE}/`);
    expect(passes(await proxy(request("/login", { bearer: PM_SECRET })))).toBe(true);
  });

  it("accepts Bearer PM_SECRET on /api (proxy and MCP handler), and nothing else in its place", async () => {
    expect(passes(await proxy(mcpRequest({ bearer: PM_SECRET })))).toBe(true);
    const res = await mcpRoute(mcpRequest({ bearer: PM_SECRET }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("get_overview");
    expect(sessionCookie(await proxy(mcpRequest({ bearer: PM_SECRET })))).toBeNull();

    await expectUnauthorizedJson(await proxy(mcpRequest({ bearer: `${PM_SECRET}x` })));
    await expectUnauthorizedJson(await proxy(mcpRequest({ cookie: PM_SECRET }))); // not as a cookie
    await expectUnauthorizedJson(await mcpRoute(mcpRequest({ bearer: `${PM_SECRET}x` })));

    useEnv({ JWT_SECRET }); // PM_SECRET unset: the old value stops working
    await expectUnauthorizedJson(await proxy(mcpRequest({ bearer: PM_SECRET })));
    await expectUnauthorizedJson(await mcpRoute(mcpRequest({ bearer: PM_SECRET })));
  });

  it("logs everyone out when JWT_SECRET is rotated", async () => {
    useEnv({ JWT_SECRET: "rotated-secret-".padEnd(40, "r"), PM_SECRET });
    expectLoginRedirect(await proxy(request("/", { cookie: token })), "/");
    await expectUnauthorizedJson(await proxy(mcpRequest({ bearer: token })));
  });
});

// ---------------------------------------------------------------------------
// Auth modes
// ---------------------------------------------------------------------------

describe("auth modes", () => {
  beforeAll(async () => setRepository((await fileRepository()).repository));

  const credentials = { email: "new@example.com", password: "long enough pw" };

  it("open (no JWT_SECRET, not on Vercel): no login anywhere, account routes disabled", async () => {
    useEnv({});
    expect(authMode()).toBe("open");
    expect(passes(await proxy(request("/")))).toBe(true);
    expect(passes(await proxy(mcpRequest({})))).toBe(true);
    expect((await mcpRoute(mcpRequest({}))).status).toBe(200);
    for (const send of [signUp, logIn]) {
      const { res, body } = await send(credentials);
      expect(res.status).toBe(503);
      expect(body).toMatchObject({ error: "not_configured" });
    }
    expect(await repo.countUsers()).toBe(0);
  });

  it("locked (on Vercel without JWT_SECRET): everything refused, even PM_SECRET; /login explains", async () => {
    useEnv({ VERCEL: "1", PM_SECRET });
    expect(authMode()).toBe("locked");
    const api = await proxy(mcpRequest({ bearer: PM_SECRET }));
    expect((await expectUnauthorizedJson(api)).message).toBe(lockedMessage());
    expect(lockedMessage()).toContain("isn't configured");
    await expectUnauthorizedJson(await mcpRoute(mcpRequest({ bearer: PM_SECRET })));
    expectLoginRedirect(await proxy(request("/backlog")), "/backlog");
    expect(passes(await proxy(request("/login")))).toBe(true);
    expect(passes(await proxy(request("/signup")))).toBe(true);
    await expectUnauthorizedJson(await proxy(jsonPost("/api/auth/login", credentials)));
    const { res, body } = await logIn(credentials);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ error: "not_configured", message: lockedMessage() });
  });

  it.each([
    { label: "locally", env: { JWT_SECRET: "too-short", PM_SECRET } },
    { label: "on Vercel", env: { JWT_SECRET: "x".repeat(31), PM_SECRET, VERCEL: "1" } },
  ])("locked with a clear message when JWT_SECRET is shorter than 32 characters ($label)", async ({ env }) => {
    useEnv(env);
    expect(authMode()).toBe("locked");
    const message = lockedMessage();
    expect(message).toContain("JWT_SECRET must be at least 32 characters");

    // No 500s: the proxy, the MCP route and the auth routes answer with the message.
    const api = await proxy(mcpRequest({ bearer: PM_SECRET }));
    expect((await expectUnauthorizedJson(api)).message).toBe(message);
    await expectUnauthorizedJson(await mcpRoute(mcpRequest({ bearer: PM_SECRET })));
    expectLoginRedirect(await proxy(request("/")), "/");
    for (const send of [signUp, logIn]) {
      const { res, body } = await send(credentials);
      expect(res.status).toBe(503);
      expect(body).toEqual({ error: "not_configured", message });
    }
    // The login and sign-up pages show it too.
    expect(passes(await proxy(request("/login")))).toBe(true);
    expect(renderToStaticMarkup(createElement(ModeNotice, { mode: "locked" }))).toContain(
      "JWT_SECRET must be at least 32 characters",
    );

    vi.stubEnv("JWT_SECRET", "x".repeat(32));
    expect(authMode()).toBe("jwt");
  });
});

// ---------------------------------------------------------------------------
// Last: nothing above wrote a secret to the console
// ---------------------------------------------------------------------------

describe("console output", () => {
  it("never contains a password, hash or token", async () => {
    secrets.add(await getDummyHash());
    // Sanity: the passwords, both backends' hashes, and issued/renewed tokens were all collected,
    // and console output is being captured.
    expect(secrets.size).toBeGreaterThan(10);
    console.debug("flow.test canary");
    expect(consoleOutput).toContain("flow.test canary");
    for (const secret of secrets) {
      const leaked = consoleOutput.filter((line) => line.includes(secret));
      expect(leaked, `console output contains a secret (${secret.length} chars)`).toEqual([]);
    }
  });
});
