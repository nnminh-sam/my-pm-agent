import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repo from "../repo";
import { setRepository } from "../repository";
import { FileRepository } from "../repository/file";
import { FsStore } from "../store/fs";
import { githubReposOf, loadProjectPrs } from "./project-prs";

const TOKEN = "ghp_faketoken_project_prs";
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "my-pm-project-prs-"));
  setRepository(new FileRepository(new FsStore(dir)));
  await repo.createProject({ title: "Two", code: "TW", repos: ["https://www.github.com/Me/One.git", "git@github.com:me/two", "gitlab.com/x/y"] });
  await repo.createProject({ title: "One", code: "ON", repos: ["github.com/me/solo"] });
  await repo.createProject({ title: "Corp", code: "CO", context: "company", repos: ["github.com/corp/app"] });
  await repo.createProject({ title: "Fail", code: "FA", repos: ["github.com/me/fail"] });
  await repo.createProject({ title: "Bare", code: "BA" });
  await repo.createProject({ title: "Elsewhere", code: "EL", repos: ["gitlab.com/x/z"] });
});
afterAll(async () => {
  setRepository(undefined);
  await rm(dir, { recursive: true, force: true });
});

const gh = () => {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const name = /repos\/([^/]+\/[^/]+)\/pulls/.exec(url)![1];
    return new Response(
      JSON.stringify([{ number: 4, title: `PR in ${name}`, user: { login: "alice" }, requested_reviewers: [{ login: "bob" }], assignees: [], updated_at: "2026-09-29T09:00:00Z", html_url: "https://evil.example/4" }]),
      { status: 200 },
    );
  }) as typeof fetch;
  return { calls, options: { client: { fetch: f, token: TOKEN, baseUrl: "http://gh.test" } } };
};

const project = async (code: string) => repo.getProject(code);

describe("githubReposOf", () => {
  it("keeps distinct github.com repos as owner/repo and skips other hosts", async () => {
    expect(githubReposOf(await project("TW"))).toEqual(["me/one", "me/two"]);
    expect(githubReposOf({ repos: ["github.com/a/b", "github.com/a/b"] })).toEqual(["a/b"]);
  });
});

describe("loadProjectPrs", () => {
  it("labels several repos and pulls each once", async () => {
    const g = gh();
    const prs = await loadProjectPrs(await project("TW"), g.options);
    expect(prs?.labeled).toBe(true);
    expect(prs?.sections.map((s) => s.repo)).toEqual(["me/one", "me/two"]);
    expect(prs?.sections[0].view.data?.[0]).toMatchObject({ number: 4, title: "PR in me/one", author: "alice", reviewers: ["bob"] });
    expect(prs?.sections.every((s) => s.view.sync.sync === "synced")).toBe(true);
    expect(g.calls.sort()).toEqual(["http://gh.test/repos/me/one/pulls?state=open&per_page=100", "http://gh.test/repos/me/two/pulls?state=open&per_page=100"].sort());
    expect(JSON.stringify(prs)).not.toContain(TOKEN);
  });

  it("runs the pulls in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = (async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await repo.updateProject("TW", { repos: ["github.com/me/three", "github.com/me/four"] });
    await loadProjectPrs(await project("TW"), { client: { fetch: f, token: TOKEN, baseUrl: "http://gh.test" } });
    expect(peak).toBe(2);
  });

  it("a single repo is unlabeled", async () => {
    const prs = await loadProjectPrs(await project("ON"), gh().options);
    expect(prs?.labeled).toBe(false);
    expect(prs?.sections).toHaveLength(1);
  });

  it("PO-2.2 a project that was company shows PRs", async () => {
    const g = gh();
    const prs = await loadProjectPrs(await project("CO"), g.options);
    expect(prs?.sections).toHaveLength(1);
    expect(prs?.sections[0].view.sync.sync).toBe("synced");
    expect(g.calls).toHaveLength(1);
  });

  it("no repos, or no github.com repo, means no section and no calls", async () => {
    const g = gh();
    expect(await loadProjectPrs(await project("BA"), g.options)).toBeNull();
    expect(await loadProjectPrs(await project("EL"), g.options)).toBeNull();
    expect(g.calls).toHaveLength(0);
  });

  it("keeps a failing repo as never synced with its reason, without throwing", async () => {
    const f = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const prs = await loadProjectPrs(await project("FA"), { client: { fetch: f, token: TOKEN, baseUrl: "http://gh.test" }, now: () => new Date("2030-01-01T00:00:00Z") });
    expect(prs?.sections[0].view).toMatchObject({ data: null, sync: { sync: "never", reason: "github_down" } });
  });
});
