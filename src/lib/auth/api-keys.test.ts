import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as repo from "../repo";
import { setRepository } from "../repository";
import { FileRepository } from "../repository/file";
import { FsStore } from "../store/fs";
import {
  API_KEY_LABEL_MAX,
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  issueApiKey,
  looksLikeApiKey,
  revokeOwnApiKey,
  toPublicApiKey,
  verifyApiKey,
} from "./api-keys";

const KEY_SHAPE = /^pm_[A-Za-z0-9_-]{43}$/;

describe("generateApiKey", () => {
  it("returns pm_ + 43 base64url chars, fresh every time", () => {
    const keys = Array.from({ length: 50 }, generateApiKey);
    expect(API_KEY_PREFIX).toBe("pm_");
    for (const key of keys) {
      expect(key).toMatch(KEY_SHAPE);
      expect(looksLikeApiKey(key)).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("hashApiKey", () => {
  it("is plain hex SHA-256, independent of JWT_SECRET", () => {
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const key = generateApiKey();
    const before = hashApiKey(key);
    vi.stubEnv("JWT_SECRET", "rotated-".padEnd(48, "x"));
    expect(hashApiKey(key)).toBe(before);
    vi.unstubAllEnvs();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(generateApiKey())).not.toBe(before);
  });
});

describe("looksLikeApiKey", () => {
  it("accepts only the pm_ key shape", () => {
    const body = "A".repeat(43);
    expect(looksLikeApiKey(`pm_${body}`)).toBe(true);
    expect(looksLikeApiKey(`pm_${"-_aZ09".repeat(7)}x`)).toBe(true);
    for (const token of [
      "",
      "pm_",
      `pm_${body.slice(1)}`, // too short
      `pm_${body}A`, // too long
      `PM_${body}`,
      `pk_${body}`,
      ` pm_${body}`,
      `pm_${body} `,
      `pm_${body.slice(1)}=`, // padding
      `pm_${body.slice(1)}+`,
      `pm_${body.slice(1)}/`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVLTEifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl", // a JWT
      "flow-test-agent-secret-0123456789", // a PM_SECRET
    ]) {
      expect(looksLikeApiKey(token), token).toBe(false);
    }
  });
});

describe("verifyApiKey", () => {
  const T0 = new Date("2026-09-27T02:00:00.000Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);
  let dir: string;
  let backend: FileRepository;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "my-pm-keys-"));
    backend = new FileRepository(new FsStore(dir));
    setRepository(backend);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    setRepository(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function issue(label = "agent") {
    const raw = generateApiKey();
    const key = await repo.createApiKey({ label, hash: hashApiKey(raw) });
    return { raw, key };
  }

  it("never looks up malformed tokens", async () => {
    const find = vi.spyOn(backend, "findApiKeyByHash");
    for (const token of ["", "not-a-key", "eyJhbGciOiJIUzI1NiJ9.e30.sig", `pm_${"A".repeat(42)}`]) {
      expect(await verifyApiKey(token, { now: T0 })).toBeNull();
    }
    expect(find).not.toHaveBeenCalled();
  });

  it("rejects an unknown key", async () => {
    await issue();
    expect(await verifyApiKey(generateApiKey(), { now: T0 })).toBeNull();
  });

  it("rejects a revoked key without touching it", async () => {
    const { raw, key } = await issue("revoked");
    await repo.revokeApiKey(key.id, T0);
    const touch = vi.spyOn(backend, "touchApiKey");
    const save = vi.spyOn(backend, "saveApiKey");
    expect(await verifyApiKey(raw, { now: at(5 * 60_000) })).toBeNull();
    expect(touch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect((await repo.getApiKey(key.id))?.last_used_at).toBeUndefined();
  });

  it("accepts a valid key and throttles last_used_at to once a minute", async () => {
    const { raw, key } = await issue("valid");
    expect(key.last_used_at).toBeUndefined();
    const save = vi.spyOn(backend, "touchApiKey");

    const first = await verifyApiKey(raw, { now: T0 });
    expect(first).toMatchObject({ id: key.id, hash: key.hash, last_used_at: T0.toISOString() });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await repo.getApiKey(key.id)).toEqual(first);

    const soon = await verifyApiKey(raw, { now: at(59_999) });
    expect(soon).toEqual(first);
    expect(save).toHaveBeenCalledTimes(1);

    const later = await verifyApiKey(raw, { now: at(60_000) });
    expect(later?.last_used_at).toBe(at(60_000).toISOString());
    expect(save).toHaveBeenCalledTimes(2);
    expect((await repo.getApiKey(key.id))?.last_used_at).toBe(at(60_000).toISOString());

    // Revoking takes effect on the next call.
    await repo.revokeApiKey(key.id, at(61_000));
    expect(await verifyApiKey(raw, { now: at(62_000) })).toBeNull();
  });

  it("refuses a key revoked between the lookup and the touch, and the touch keeps revoked_at", async () => {
    const { raw, key } = await issue("race");
    // The lookup sees the key still active; the revoke lands before last_used_at is written.
    const find = vi.spyOn(backend, "findApiKeyByHash").mockImplementationOnce(async (hash) => {
      const found = await backend.getApiKey(key.id);
      await repo.revokeApiKey(key.id, T0);
      return found?.hash === hash ? found : null;
    });
    expect(await verifyApiKey(raw, { now: at(1000) })).toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
    const stored = await repo.getApiKey(key.id);
    expect(stored).toMatchObject({ revoked_at: T0.toISOString(), last_used_at: at(1000).toISOString() });
    expect(await verifyApiKey(raw, { now: at(120_000) })).toBeNull();
  });

  it("still authenticates when recording the use fails, and logs neither key nor hash", async () => {
    const { raw, key } = await issue("flaky");
    vi.spyOn(backend, "touchApiKey").mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verifyApiKey(raw, { now: T0 })).toEqual(key);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(raw);
    expect(logged).not.toContain(key.hash);
  });

  it("never persists a raw key", async () => {
    const { raw } = await issue("stored");
    await verifyApiKey(raw, { now: T0 });
    const files = await readdir(path.join(dir, "api_keys"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await readFile(path.join(dir, "api_keys", file), "utf8")).not.toContain(raw.slice(3));
  });
});

describe("web UI keys (issueApiKey, revokeOwnApiKey)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "my-pm-keys-ui-"));
    setRepository(new FileRepository(new FsStore(dir)));
  });
  afterAll(async () => {
    setRepository(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("issues an owned key that authenticates and stores only its hash", async () => {
    const { key, raw } = await issueApiKey({ label: "  web ", userId: "U-1" });
    expect(raw).toMatch(KEY_SHAPE);
    expect(key).toMatchObject({ label: "web", user_id: "U-1", hash: hashApiKey(raw) });
    expect(await readFile(path.join(dir, "api_keys", `${key.id}.md`), "utf8")).not.toContain(raw.slice(3));
    expect((await verifyApiKey(raw))?.id).toBe(key.id);
  });

  it("cuts long labels", async () => {
    const { key } = await issueApiKey({ label: "x".repeat(200), userId: "U-1" });
    expect(key.label).toHaveLength(API_KEY_LABEL_MAX);
  });

  it("revokes only the owner's keys", async () => {
    const { key, raw } = await issueApiKey({ userId: "U-1" });
    const cli = await issueApiKey();
    expect(await revokeOwnApiKey("U-2", key.id)).toBeNull();
    expect(await revokeOwnApiKey("U-1", cli.key.id)).toBeNull();
    expect(await revokeOwnApiKey("U-1", "K-999")).toBeNull();
    expect(await verifyApiKey(raw)).not.toBeNull();

    const revoked = await revokeOwnApiKey("U-1", key.id);
    expect(revoked?.revoked_at).toBeDefined();
    expect(await verifyApiKey(raw)).toBeNull();
    expect(await revokeOwnApiKey("U-1", key.id)).toEqual(revoked);
    expect(await verifyApiKey(cli.raw)).not.toBeNull();
  });

  it("never exposes the hash to the browser", async () => {
    const { key } = await issueApiKey({ userId: "U-1" });
    const shown = toPublicApiKey(key);
    expect(shown).not.toHaveProperty("hash");
    expect(JSON.stringify(shown)).not.toContain(key.hash);
  });
});
