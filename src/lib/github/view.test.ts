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

  it("PO-2.2 serves a PR view for a project that was company", async () => {
    const f = (async (input: string | URL | Request) => {
      if (String(input).includes("/reviews")) return new Response("[]");
      return new Response(
        JSON.stringify({
          number: 1,
          title: "First",
          body: "body",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          milestone: null,
          user: { login: "alice" },
          assignees: [],
          requested_reviewers: [],
          created_at: "2026-09-29T09:00:00Z",
          updated_at: "2026-09-29T09:00:00Z",
        })
      );
    }) as typeof fetch;
    const opts = { client: { fetch: f, token: TOKEN, baseUrl: "http://gh.test" } };
    const v = await loadPrView("corp/app#1", opts);
    expect(v.sync).toMatchObject({ sync: "synced" });
    expect(v.data?.title).toBe("First");
  });

  it("PO-2.3 maps a refusal to a never-synced status with the refusal", async () => {
    const gh = down();
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

  it("makes 0 fetch calls while the stored retry_after is in the future, and returns that status", async () => {
    const gh = down();
    const now = new Date("2026-09-29T12:00:00.000Z");
    for (const key of ["pr:me/app#7", "repo:me/app"]) {
      await repo.upsertGithubSnapshot({
        key,
        last_attempt_at: "2026-09-29T11:59:00.000Z",
        last_error: { reason: "rate_limited", status: 429, message: "slow down", request_id: null },
        retry_after: "2026-09-29T12:30:00.000Z",
      });
      const r = await retrySync(key, { ...gh.options, now: () => now });
      expect(r).toMatchObject({ ok: true, sync: { sync: "never", reason: "rate_limited", retry_after: "2026-09-29T12:30:00.000Z" } });
    }
    expect(gh.calls).toHaveLength(0);
  });

  it("forces a pull for a valid key", async () => {
    const gh = down();
    const r = await retrySync("repo:me/app", gh.options);
    expect(r).toMatchObject({ ok: true, sync: { sync: "never", reason: "github_down" } });
    expect(gh.calls.length).toBeGreaterThan(0);
  });
});
