import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repo from "../repo";
import { setRepository } from "../repository";
import { FileRepository } from "../repository/file";
import { FsStore } from "../store/fs";
import { registerPmServer } from "./server";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const tools = new Map<string, { config: { inputSchema: { parse(v: unknown): Record<string, unknown> } }; handler: Handler }>();

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "my-pm-mcp-"));
  setRepository(new FileRepository(new FsStore(dir)));
  registerPmServer({
    registerTool: (name: string, config: never, handler: Handler) => void tools.set(name, { config, handler }),
    registerPrompt: () => undefined,
  } as unknown as McpServer);
  await repo.createProject({ title: "Mcp", code: "MCP" });
  await repo.createMilestone({ title: "M", project: "MCP" });
  await repo.createTasks([{ title: "T", milestone: "MCP-M1" }]);
});
afterAll(async () => {
  setRepository(undefined);
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name)!;
  return tool.handler(tool.config.inputSchema.parse(args));
}

describe("add_comment", () => {
  it("adds an agent comment and returns it; there is no delete tool", async () => {
    const result = await call("add_comment", { id: "mcp-m1-t1", body: "  found it <b>x</b> " });
    expect(result.isError).toBeUndefined();
    const comment = JSON.parse(result.content[0].text);
    expect(comment).toMatchObject({ author: "agent", body: "found it <b>x</b>" });
    expect(await repo.listComments("MCP-M1-T1")).toEqual([comment]);
    expect([...tools.keys()].filter((n) => n.includes("comment"))).toEqual(["add_comment"]);
  });

  it("reports an unknown task and a bad body as tool errors", async () => {
    expect(await call("add_comment", { id: "MCP-M1-T9", body: "x" })).toMatchObject({ isError: true });
    const empty = await call("add_comment", { id: "MCP-M1-T1", body: "   " });
    expect(empty).toMatchObject({ isError: true });
    expect(empty.content[0].text).toContain("empty");
  });
});
