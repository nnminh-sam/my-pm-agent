import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { POST as playbooksRoute } from "@/app/api/playbooks/route";
import * as repo from "./repo";
import { setRepository } from "./repository";
import { FileRepository } from "./repository/file";
import { FsStore } from "./store/fs";

/**
 * The lifecycle through its entry points: POST /api/playbooks (what pm-flow calls) and the MCP tools, driven
 * through the real route handlers against a temp-dir file backend. Repository behaviour on both backends is
 * covered by repo.test.ts; this is about the HTTP and MCP layer.
 */

const BASE = "http://localhost:3000";
const PM_SECRET = "lifecycle-test-agent-secret-0123456789";
let dir: string;
let pma: Record<string, unknown>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "my-pm-lifecycle-"));
  setRepository(new FileRepository(new FsStore(dir)));
  const sdlc = YAML.parse(await readFile(new URL("./playbooks/sdlc.yaml", import.meta.url), "utf8"));
  pma = {
    ...sdlc,
    name: "PMA",
    version: "1.0.0",
    software: "my_pm",
    layers: [{ name: "sdlc", version: "1.0.0" }],
    environments: [{ name: "dev", app: "localhost:3000" }, { name: "prod" }],
    rules: { project: 2, layers: 9 },
  };
  await repo.createProject({ title: "My PM Agent", code: "PMA", repos: ["git@github.com:nnminh-sam/my-pm-agent.git"] });
  await repo.createMilestone({ title: "Migration to Neon", project: "PMA" });
  await repo.createTasks([{ title: "Import", milestone: "PMA-M1", estimate: 2 }]);
  await repo.logTime("PMA-M1-T1", 1, "done", true);
  await repo.createMilestone({ title: "Later", project: "PMA" });
});
// Open mode (no JWT_SECRET, not on Vercel) unless a test turns auth on.
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  setRepository(undefined);
  await rm(dir, { recursive: true, force: true });
});

function openMode() {
  vi.stubEnv("JWT_SECRET", undefined);
  vi.stubEnv("PM_SECRET", undefined);
  vi.stubEnv("VERCEL", undefined);
}

function postPlaybook(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return playbooksRoute(
    new NextRequest(`${BASE}/api/playbooks`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }),
  );
}

/** A tool's JSON result, or `{ error }` with the message when the tool refused. */
type ToolResult = Record<string, unknown> & { error?: string };

/** One tools/call through the MCP route; the stateless handler needs no initialize handshake. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const res = await mcpRoute(new NextRequest(`${BASE}/api/mcp`, { method: "POST", headers, body }));
  const text = await res.text();
  const line = text.trim().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  const { result } = JSON.parse(line) as { result: { content: { text: string }[]; isError?: boolean } };
  const out = result.content[0].text;
  if (result.isError) return { error: out };
  return JSON.parse(out) as ToolResult;
}

describe("POST /api/playbooks", () => {
  it("stores a new version (201), then treats the same content as already stored (200)", async () => {
    openMode();
    const first = await postPlaybook(pma);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ ref: "PMA@1.0.0", created: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const again = await postPlaybook(pma);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ref: "PMA@1.0.0", created: false });
  });

  it("refuses changed content under a stored version (409) and bad input (400)", async () => {
    openMode();
    const changed = await postPlaybook({ ...pma, software: "other" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "version_changed" });
    const invalid = await postPlaybook({ ...pma, version: "1.0" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_input", message: expect.stringContaining("expected a version like 1.2.0") });
    expect((await postPlaybook("{not json")).status).toBe(400);
    expect((await postPlaybook(pma, { "content-type": "text/plain" })).status).toBe(400);
  });

  it("needs credentials once auth is on", async () => {
    vi.stubEnv("JWT_SECRET", "lifecycle-test-jwt-secret-".padEnd(48, "0"));
    vi.stubEnv("PM_SECRET", PM_SECRET);
    vi.stubEnv("VERCEL", undefined);
    const anonymous = await postPlaybook(pma);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="pm"');
    const agent = await postPlaybook(pma, { "content-type": "application/json", authorization: `Bearer ${PM_SECRET}` });
    expect(agent.status).toBe(200);
  });
});

describe("lifecycle MCP tools", () => {
  it("adopts a playbook, places a milestone and fires a detector", async () => {
    openMode();
    const pinned = await tool("set_playbook_version", { project: "PMA", version: "PMA@1.0.0", stages: { "PMA-M1": "release" } });
    expect(pinned).toMatchObject({ project: "PMA", playbook: "PMA@1.0.0", placed: ["PMA-M1 → release"], warnings: [] });
    expect(await tool("update_project", { id: "PMA", detectors: ["migrations"] })).toMatchObject({
      project: { detectors: ["migrations"], repos: ["github.com/nnminh-sam/my-pm-agent"] },
    });
  });

  it("walks a release through dev and prod, refusing to advance while checks are open", async () => {
    openMode();
    const onDev = await tool("record_deployment", { milestone: "PMA-M1", env: "dev", at: "2026-09-27", ref: "005 applied" });
    expect(onDev).toMatchObject({ stage: "release", environments: [{ name: "dev", reached: { at: "2026-09-27", ref: "005 applied" } }, { name: "prod" }] });

    const next = await tool("get_next");
    expect(next).toMatchObject({ warnings: [], wip: { in_build: [], over: false } });
    // PMA-M2 has no stage yet (created before the pin), so it's an idea and isn't listed.
    expect((next.next as { milestone: string }[]).map((n) => n.milestone)).toEqual(["PMA-M1"]);
    expect((next.next as { action: unknown }[])[0].action).toMatchObject({ kind: "check", check: "release.rollback_plan", env: "prod" });

    const refused = await tool("advance_stage", { milestone: "PMA-M1" });
    expect(refused.error).toMatch(/^PMA-M1 can't leave release yet\. Open: release\.deployed: not on prod yet; release\.rollback_plan \(prod\);/);

    await tool("pass_check", { milestone: "PMA-M1", check: "release.rollback_plan", evidence: "Neon branch development-pre-milestones", by: "claude" });
    const failed = await tool("fail_check", { milestone: "PMA-M1", check: "release.migration_paired", evidence: "prod has no tables" });
    expect(failed.next).toMatchObject({ kind: "check", check: "release.migration_paired", text: expect.stringContaining("failed: prod has no tables") });
    expect(await tool("waive_check", { milestone: "PMA-M1", check: "release.migration_paired", reason: "" })).toMatchObject({
      error: expect.any(String),
    });
    const paired = await tool("pass_check", { milestone: "PMA-M1", check: "release.migration_paired", evidence: "migrate + import + deploy on 09-30" });
    expect(paired.next).toEqual({ kind: "deploy", env: "prod", text: "Deploy to prod and record it" });

    await tool("record_deployment", { milestone: "PMA-M1", env: "prod", url: "https://my-pm.example.app" });
    const learn = await tool("advance_stage", { milestone: "PMA-M1" });
    expect(learn).toMatchObject({ stage: "learn", status: "in_progress", open: ["learn.retro"] });
  });

  it("shows a project's lifecycle and the top of it in the overview", async () => {
    openMode();
    const view = await tool("get_lifecycle", { project: "pma" });
    expect(view).toMatchObject({ code: "PMA", playbook: "PMA@1.0.0", environments: ["dev", "prod"], checks: 14, warnings: [] });
    const [m1, m2] = view.milestones as { code: string; stage: string; checks: { key: string; state: string }[] }[];
    expect(m1).toMatchObject({ code: "PMA-M1", stage: "learn" });
    // The current stage's checks, plus any recorded earlier.
    expect(m1.checks.map((c) => `${c.key}:${c.state}`)).toEqual([
      "release.rollback_plan:passed",
      "learn.retro:open",
      "learn.time_logged:passed",
      "release.migration_paired:passed",
    ]);
    expect(m2).toMatchObject({ code: "PMA-M2", stage: "idea" });

    const overview = await tool("get_overview");
    expect(overview.lifecycle).toMatchObject({ warnings: [], next: [{ milestone: "PMA-M1", stage: "learn" }] });
    expect(await tool("reopen_check", { milestone: "PMA-M1", check: "release.rollback_plan" })).toMatchObject({ code: "PMA-M1" });
  });

  it("stores a playbook through the tool too, and explains unknown checks", async () => {
    openMode();
    expect(await tool("sync_playbook", { playbook: { ...pma, version: "1.1.0" } })).toMatchObject({ ref: "PMA@1.1.0", created: true });
    const next = await tool("get_next", { project: "PMA" });
    expect(next.warnings).toEqual([{ code: "playbook_update", project: "PMA", message: "PMA@1.1.0 is available (pinned PMA@1.0.0)" }]);

    // Upgrade, then roll back: re-pinning is all it takes, and both versions stay stored.
    expect(await tool("set_playbook_version", { project: "PMA", version: "PMA@1.1.0" })).toMatchObject({ playbook: "PMA@1.1.0", warnings: [] });
    expect(await tool("set_playbook_version", { project: "PMA", version: "PMA@1.0.0" })).toMatchObject({
      playbook: "PMA@1.0.0",
      warnings: [{ code: "playbook_update" }],
    });
    expect((await repo.loadWorkspace()).playbooks.map((v) => v.ref)).toEqual(["PMA@1.0.0", "PMA@1.1.0"]);
    expect(await tool("pass_check", { milestone: "PMA-M1", check: "ship.it" })).toMatchObject({
      error: expect.stringContaining("ship.it isn't a check of PMA's playbook PMA@1.0.0"),
    });
  });
});
