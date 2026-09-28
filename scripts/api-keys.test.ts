import { describe, expect, it } from "vitest";
import type { ApiKey } from "../src/lib/types";
import { formatCreated, formatKeyTable, formatTimestamp, keyStatus, parseArgs } from "./api-keys";

const HASH = "a".repeat(64);
const key = (over: Partial<ApiKey> = {}): ApiKey => ({ id: "K-1", label: "laptop", hash: HASH, created: "2026-09-01", ...over });

describe("parseArgs", () => {
  it("parses create with and without a label", () => {
    expect(parseArgs(["create"])).toEqual({ cmd: "create" });
    expect(parseArgs(["create", "--label", "claude code"])).toEqual({ cmd: "create", label: "claude code" });
    expect(parseArgs(["create", "--label=ci"])).toEqual({ cmd: "create", label: "ci" });
  });

  it("rejects bad create args", () => {
    expect(parseArgs(["create", "--label"]).cmd).toBe("error");
    expect(parseArgs(["create", "laptop"]).cmd).toBe("error");
    expect(parseArgs(["create", "--label", "a", "--label", "b"]).cmd).toBe("error");
  });

  it("parses list and revoke", () => {
    expect(parseArgs(["list"])).toEqual({ cmd: "list" });
    expect(parseArgs(["list", "x"]).cmd).toBe("error");
    expect(parseArgs(["revoke", "K-2"])).toEqual({ cmd: "revoke", id: "K-2" });
    expect(parseArgs(["revoke"]).cmd).toBe("error");
    expect(parseArgs(["revoke", "1", "2"]).cmd).toBe("error");
    expect(parseArgs(["revoke", "--all"]).cmd).toBe("error");
  });

  it("handles help, missing and unknown commands", () => {
    expect(parseArgs(["--help"])).toEqual({ cmd: "help" });
    expect(parseArgs(["create", "-h"])).toEqual({ cmd: "help" });
    expect(parseArgs([])).toEqual({ cmd: "error", message: "Missing command" });
    expect(parseArgs(["delete"])).toEqual({ cmd: "error", message: "Unknown command: delete" });
  });
});

describe("formatting", () => {
  it("formats timestamps and status", () => {
    expect(formatTimestamp("2026-09-27T08:05:59.123Z")).toBe("2026-09-27 08:05 UTC");
    expect(keyStatus(key())).toBe("active");
    expect(keyStatus(key({ revoked_at: "2026-09-20T10:00:00.000Z" }))).toBe("revoked 2026-09-20");
  });

  it("prints a friendly line when there are no keys", () => {
    expect(formatKeyTable([])).toMatch(/No API keys yet/);
  });

  it("tabulates keys without their hashes", () => {
    const table = formatKeyTable([
      key(),
      key({ id: "K-2", label: "", user_id: "U-1", last_used_at: "2026-09-21T09:30:00.000Z", revoked_at: "2026-09-22T00:00:00.000Z" }),
    ]);
    expect(table).not.toContain(HASH);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^ID\s+LABEL\s+OWNER\s+CREATED\s+LAST USED\s+STATUS$/);
    expect(lines[1]).toMatch(/^K-1\s+laptop\s+cli\s+2026-09-01\s+never\s+active$/);
    expect(lines[2]).toMatch(/^K-2\s+-\s+U-1\s+2026-09-01\s+2026-09-21 09:30 UTC\s+revoked 2026-09-22$/);
  });

  it("shows the raw key once with a warning, never the hash", () => {
    const out = formatCreated(key(), "pm_secret");
    expect(out.split("pm_secret")).toHaveLength(2);
    expect(out).toContain("K-1");
    expect(out).toContain("laptop");
    expect(out).toMatch(/only time/);
    expect(out).not.toContain(HASH);
  });
});
