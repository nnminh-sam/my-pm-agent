import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { proxy } from "@/proxy";
import type { Db, Row } from "../db";
import { migrate } from "../migrate";
import * as repo from "../repo";
import { setRepository, type Repository } from "../repository";
import { FileRepository } from "../repository/file";
import { PgRepository } from "../repository/postgres";
import { FsStore } from "../store/fs";
import { generateApiKey, hashApiKey } from "./api-keys";
import { SESSION_COOKIE, authenticateRequest, isAuthorized, lockedMessage } from "./index";
import { SESSION_TTL_SECONDS, signJwt } from "./jwt";

/**
 * Agent API keys as request credentials (T-36/T-38): `authenticateRequest`/`isAuthorized` against a real
 * repository, then src/proxy.ts and the /api/mcp handler driven with NextRequests. Assertions use hashes
 * and behaviour only, never a raw key read back from storage.
 */

const BASE = "http://localhost:3000";
const JWT_SECRET = "api-key-test-jwt-secret-".padEnd(48, "0");
const PM_SECRET = "api-key-test-agent-secret-0123456789";
const env = { JWT_SECRET, PM_SECRET };
const NOW = 1_790_000_000; // seconds
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const tempDirs: string[] = [];
afterAll(async () => {
  setRepository(undefined);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fileRepository(): Promise<Repository> {
  const dir = await mkdtemp(path.join(tmpdir(), "my-pm-key-auth-"));
  tempDirs.push(dir);
  return new FileRepository(new FsStore(dir));
}

// Mirrors the PGlite helper in repo.test.ts.
async function pgliteRepository(): Promise<Repository> {
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
  return new PgRepository(db);
}

async function issueKey(label = "agent") {
  const raw = generateApiKey();
  const key = await repo.createApiKey({ label, hash: hashApiKey(raw) });
  return { raw, key };
}

const sessionToken = () => signJwt({ sub: "U-1", email: "me@example.com" }, JWT_SECRET, { ttlSeconds: SESSION_TTL_SECONDS, now: NOW });

describe.each([
  { name: "fs", setup: fileRepository },
  { name: "postgres (pglite)", setup: pgliteRepository },
])("API keys as credentials ($name backend)", ({ setup }) => {
  let backend: Repository;
  beforeAll(async () => {
    backend = await setup();
    setRepository(backend);
  });

  // -------------------------------------------------------------------------
  // auth/index.ts
  // -------------------------------------------------------------------------

  describe("authenticateRequest / isAuthorized", () => {
    const opts = { env, now: NOW };
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    it("authenticates a valid, active key as the agent and records its use", async () => {
      const { raw, key } = await issueKey("valid");
      expect(key.last_used_at).toBeUndefined();

      expect(await authenticateRequest(bearer(raw), opts)).toBe("agent");
      const used = await repo.findApiKeyByHash(hashApiKey(raw));
      expect(used).toMatchObject({ id: key.id, last_used_at: iso(NOW) });
      expect(used?.revoked_at).toBeUndefined();

      expect(await isAuthorized(bearer(raw), { env, now: NOW + 120 })).toBe(true);
      expect((await repo.getApiKey(key.id))?.last_used_at).toBe(iso(NOW + 120));
      // Case-insensitive scheme, extra spaces, like JWT bearers.
      expect(await authenticateRequest({ authorization: `bearer   ${raw}` }, opts)).toBe("agent");
    });

    it("refuses a request with no credentials", async () => {
      expect(await authenticateRequest({}, opts)).toBeNull();
      expect(await authenticateRequest({ authorization: null, sessionCookie: null }, opts)).toBeNull();
      expect(await isAuthorized({}, opts)).toBe(false);
    });

    it("refuses malformed Authorization headers without a lookup", async () => {
      const { raw } = await issueKey("malformed");
      const find = vi.spyOn(backend, "findApiKeyByHash");
      for (const authorization of [
        "Basic x",
        `Basic ${raw}`,
        raw, // no scheme
        "Bearer",
        "Bearer ",
        "Bearer a b",
        `Bearer ${raw} extra`,
        `Bearer ${raw.slice(0, -1)}`, // too short for a key
        `Bearer ${raw}A`, // too long
        `Bearer PM_${raw.slice(3)}`,
      ]) {
        expect(await authenticateRequest({ authorization }, opts), authorization.replace(raw, "<key>")).toBeNull();
        expect(await isAuthorized({ authorization }, opts)).toBe(false);
      }
      expect(find).not.toHaveBeenCalled();
    });

    it("refuses a well-formed but unknown key, without falling back to the cookie", async () => {
      await issueKey("known");
      const unknown = generateApiKey();
      const find = vi.spyOn(backend, "findApiKeyByHash");
      expect(await authenticateRequest(bearer(unknown), opts)).toBeNull();
      expect(find).toHaveBeenCalledWith(hashApiKey(unknown));
      expect(await isAuthorized(bearer(unknown), opts)).toBe(false);
      // The Bearer header decides on its own: a valid session cookie doesn't rescue a bad key.
      expect(await authenticateRequest({ ...bearer(unknown), sessionCookie: sessionToken() }, opts)).toBeNull();
      expect(await authenticateRequest({ sessionCookie: sessionToken() }, opts)).toMatchObject({ sub: "U-1" });
    });

    it("refuses a revoked key, and revoking a key that just worked blocks it immediately", async () => {
      const { raw: revokedRaw, key: revokedKey } = await issueKey("revoked");
      await repo.revokeApiKey(revokedKey.id, new Date(NOW * 1000));
      expect(await authenticateRequest(bearer(revokedRaw), opts)).toBeNull();
      expect(await isAuthorized(bearer(revokedRaw), opts)).toBe(false);

      const { raw, key } = await issueKey("revoked-live");
      expect(await authenticateRequest(bearer(raw), opts)).toBe("agent");
      await repo.revokeApiKey(key.id, new Date((NOW + 1) * 1000));
      expect(await authenticateRequest(bearer(raw), { env, now: NOW + 2 })).toBeNull();
      expect(await isAuthorized(bearer(raw), { env, now: NOW + 2 })).toBe(false);
      expect(await authenticateRequest({ ...bearer(raw), sessionCookie: sessionToken() }, opts)).toBeNull();
      // The revoke survived the earlier touch.
      expect(await repo.getApiKey(key.id)).toMatchObject({ revoked_at: iso(NOW + 1), last_used_at: iso(NOW) });
    });

    it("keeps JWTs and PM_SECRET synchronous: no key lookup for them", async () => {
      const find = vi.spyOn(backend, "findApiKeyByHash");
      expect(await authenticateRequest(bearer(sessionToken()), opts)).toMatchObject({ sub: "U-1" });
      expect(await authenticateRequest(bearer(PM_SECRET), opts)).toBe("agent");
      expect(await authenticateRequest(bearer(`${PM_SECRET}x`), opts)).toBeNull();
      expect(await authenticateRequest({ sessionCookie: sessionToken() }, opts)).toMatchObject({ sub: "U-1" });
      expect(find).not.toHaveBeenCalled();
      // A PM_SECRET that happens to be pm_-shaped still works, and is matched before any lookup.
      const keyShapedSecret = generateApiKey();
      expect(await authenticateRequest(bearer(keyShapedSecret), { env: { JWT_SECRET, PM_SECRET: keyShapedSecret }, now: NOW })).toBe("agent");
      expect(find).not.toHaveBeenCalled();
    });

    it("keeps open mode open and locked mode locked; keys never unlock the app", async () => {
      const { raw } = await issueKey("modes");
      const find = vi.spyOn(backend, "findApiKeyByHash");
      expect(await isAuthorized({}, { env: {} })).toBe(true);
      expect(await isAuthorized(bearer(generateApiKey()), { env: {} })).toBe(true);
      for (const locked of [{ VERCEL: "1", PM_SECRET }, { JWT_SECRET: "too-short", PM_SECRET }]) {
        expect(await isAuthorized(bearer(raw), { env: locked, now: NOW })).toBe(false);
        expect(await authenticateRequest(bearer(raw), { env: locked, now: NOW })).toBeNull();
      }
      expect(find).not.toHaveBeenCalled();
    });

    it("fails closed on a repository error, logging neither the key nor its hash", async () => {
      const { raw } = await issueKey("broken-db");
      vi.spyOn(backend, "findApiKeyByHash").mockRejectedValue(new Error(`connection lost while querying ${hashApiKey(raw)}`));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await authenticateRequest(bearer(raw), opts)).toBeNull();
      expect(await isAuthorized(bearer(raw), opts)).toBe(false);
      expect(error).toHaveBeenCalled();
      const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
      expect(logged).not.toContain(raw.slice(3));
      expect(logged).not.toContain(hashApiKey(raw));
    });

    it("still authenticates when only the last-use write fails", async () => {
      const { raw, key } = await issueKey("flaky-touch");
      vi.spyOn(backend, "touchApiKey").mockRejectedValue(new Error("disk full"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await authenticateRequest(bearer(raw), opts)).toBe("agent");
      expect((await repo.getApiKey(key.id))?.last_used_at).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // src/proxy.ts and the /api/mcp handler
  // -------------------------------------------------------------------------

  describe("proxy and /api/mcp", () => {
    beforeEach(() => {
      vi.stubEnv("JWT_SECRET", JWT_SECRET);
      vi.stubEnv("PM_SECRET", PM_SECRET);
      vi.stubEnv("VERCEL", undefined);
    });

    function request(pathname: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
      return new NextRequest(BASE + pathname, { method, headers, body });
    }

    /** A JSON-RPC tools/list call; the stateless MCP handler answers it without an initialize handshake. */
    function mcpRequest(authorization?: string, cookie?: string) {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (authorization !== undefined) headers.authorization = authorization;
      if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
      return request("/api/mcp", headers, "POST", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    }

    const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

    async function expectUnauthorized(res: Response) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="pm"');
      const body = (await res.json()) as { error: string; message?: string };
      expect(body.error).toBe("unauthorized");
      return body;
    }

    it("lets a valid key through the proxy and the MCP handler, with no session cookie", async () => {
      const { raw, key } = await issueKey("mcp");
      const res = await proxy(mcpRequest(`Bearer ${raw}`));
      expect(passes(res)).toBe(true);
      expect(res.headers.getSetCookie()).toEqual([]);
      const mcp = await mcpRoute(mcpRequest(`Bearer ${raw}`));
      expect(mcp.status).toBe(200);
      expect(await mcp.text()).toContain("get_overview");
      expect((await repo.getApiKey(key.id))?.last_used_at).toEqual(expect.any(String));
      // Pages too, as with PM_SECRET.
      expect(passes(await proxy(request("/backlog", { authorization: `Bearer ${raw}` })))).toBe(true);
    });

    it("answers missing, malformed, unknown and revoked keys with the same 401", async () => {
      const { raw, key } = await issueKey("mcp-denied");
      const unknown = generateApiKey();
      const revoked = await issueKey("mcp-revoked");
      await repo.revokeApiKey(revoked.key.id);

      const cases: [label: string, authorization: string | undefined][] = [
        ["missing", undefined],
        ["Basic", "Basic x"],
        ["Bearer without a token", "Bearer"],
        ["Bearer with two tokens", "Bearer a b"],
        ["unknown key", `Bearer ${unknown}`],
        ["revoked key", `Bearer ${revoked.raw}`],
      ];
      for (const [label, authorization] of cases) {
        const body = await expectUnauthorized(await proxy(mcpRequest(authorization)));
        expect({ label, message: body.message }).toEqual({ label, message: expect.stringContaining("an API key (npm run auth:create-key)") });
        expect(Object.keys(body).sort()).toEqual(["error", "message"]);
        expect(await expectUnauthorized(await mcpRoute(mcpRequest(authorization)))).toEqual({ error: "unauthorized" });
      }

      // A key that just worked is refused as soon as it's revoked, even with a valid cookie alongside.
      expect(passes(await proxy(mcpRequest(`Bearer ${raw}`)))).toBe(true);
      expect((await mcpRoute(mcpRequest(`Bearer ${raw}`))).status).toBe(200);
      await repo.revokeApiKey(key.id);
      const denied = await proxy(mcpRequest(`Bearer ${raw}`, sessionToken()));
      await expectUnauthorized(denied);
      expect(denied.headers.getSetCookie()).toEqual([]); // a bad Bearer doesn't touch the cookie
      await expectUnauthorized(await mcpRoute(mcpRequest(`Bearer ${raw}`)));
      const page = await proxy(request("/backlog", { authorization: `Bearer ${raw}` }));
      expect(page.status).toBe(307);
      expect(page.headers.get("location")).toBe(`${BASE}/login?next=%2Fbacklog`);
    });

    it("doesn't treat a key as a session on /login, and costs no lookup there", async () => {
      const { raw } = await issueKey("login-page");
      const find = vi.spyOn(backend, "findApiKeyByHash");
      expect(passes(await proxy(request("/login?next=%2Fbacklog", { authorization: `Bearer ${raw}` })))).toBe(true);
      expect(find).not.toHaveBeenCalled();
    });

    it("refuses keys in locked mode with the lock message", async () => {
      const { raw } = await issueKey("locked");
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("JWT_SECRET", undefined);
      expect((await expectUnauthorized(await proxy(mcpRequest(`Bearer ${raw}`)))).message).toBe(lockedMessage());
      await expectUnauthorized(await mcpRoute(mcpRequest(`Bearer ${raw}`)));
    });

    it("fails closed (401) when the key lookup errors", async () => {
      const { raw } = await issueKey("proxy-broken-db");
      vi.spyOn(backend, "findApiKeyByHash").mockRejectedValue(new Error("db down"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expectUnauthorized(await proxy(mcpRequest(`Bearer ${raw}`)));
      await expectUnauthorized(await mcpRoute(mcpRequest(`Bearer ${raw}`)));
    });
  });
});
