import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repo from "../repo";
import { setRepository } from "../repository";
import { FileRepository } from "../repository/file";
import { FsStore } from "../store/fs";
import { loadPrView, retrySync } from "./view";

const TOKEN = "ghp_faketoken_view_test";
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "my-pm-view-"));
  setRepository(new FileRepository(new FsStore(dir)));
  await repo.createProject({ title: "Mine", code: "ME", repos: ["github.com/me/app"] });
  await repo.createProject({ title: "Corp", code: "CO", context: "company", repos: ["github.com/corp/app"] });
});
afterAll(async () => {
  setRepository(undefined);
  await rm(dir, { recursive: true, force: true });
});

const down = () => {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ message: "Service Unavailable" }), { status: 503 });
  }) as typeof fetch;
  return { calls, options: { client: { fetch: f, token: TOKEN, baseUrl: "http://gh.test" } } };
};

describe("loadPrView", () => {
  it("does not throw when GitHub is down: never synced with the reason", async () => {
    const gh = down();
    const v = await loadPrView("me/app#1", gh.options);
    expect(v).toMatchObject({ key: "pr:me/app#1", data: null, sync: { sync: "never", reason: "github_down" } });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });

  it("maps a refusal to a never-synced status with the refusal", async () => {
    const gh = down();
    expect((await loadPrView("corp/app#1", gh.options)).sync).toMatchObject({ sync: "never", refusal: "company" });
    expect((await loadPrView("nobody/x#1", gh.options)).sync).toMatchObject({ refusal: "not_linked" });
    expect(gh.calls).toHaveLength(0);
  });
});

describe("retrySync", () => {
  it("rejects a bad key without calling GitHub", async () => {
    const gh = down();
    for (const key of ["me/app#1", "pr:me/app", 7, null, { toString: () => "repo:me/app" }])
      expect(await retrySync(key, gh.options)).toMatchObject({ ok: false });
    expect(gh.calls).toHaveLength(0);
  });

  it("forces a pull for a valid key", async () => {
    const gh = down();
    const r = await retrySync("repo:me/app", gh.options);
    expect(r).toMatchObject({ ok: true, sync: { sync: "never", reason: "github_down" } });
    expect(gh.calls.length).toBeGreaterThan(0);
  });
});
