// Agent API keys for /api/mcp: issue, list and revoke.
//   npm run auth:create-key -- [--label <name>]
//   npm run auth:list-keys
//   npm run auth:revoke-key -- <id>
// The raw key is printed once by create-key and never stored, logged or written anywhere else.
import { pathToFileURL } from "node:url";
import { generateApiKey, hashApiKey } from "../src/lib/auth/api-keys";
import { createApiKey, getApiKey, listApiKeys, revokeApiKey } from "../src/lib/repo";
import { getRepository } from "../src/lib/repository";
import type { ApiKey } from "../src/lib/types";

export const USAGE = `Usage:
  npm run auth:create-key -- [--label <name>]   issue a key (shown once)
  npm run auth:list-keys                        list keys
  npm run auth:revoke-key -- <id>               revoke a key (e.g. K-2 or 2)`;

export type Command =
  | { cmd: "create"; label?: string }
  | { cmd: "list" }
  | { cmd: "revoke"; id: string }
  | { cmd: "help" }
  | { cmd: "error"; message: string };

/** argv after the script path: `<create|list|revoke> [args]`. */
export function parseArgs(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help" || cmd === "help" || rest.includes("-h") || rest.includes("--help")) {
    return { cmd: "help" };
  }
  switch (cmd) {
    case "create": {
      let label: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (label !== undefined && (arg === "--label" || arg.startsWith("--label="))) {
          return { cmd: "error", message: "--label given more than once" };
        }
        if (arg.startsWith("--label=")) label = arg.slice("--label=".length);
        else if (arg === "--label") {
          if (i + 1 >= rest.length) return { cmd: "error", message: "--label needs a value" };
          label = rest[++i];
        } else return { cmd: "error", message: `Unexpected argument: ${arg}` };
      }
      return label === undefined ? { cmd: "create" } : { cmd: "create", label };
    }
    case "list":
      return rest.length ? { cmd: "error", message: `Unexpected argument: ${rest[0]}` } : { cmd: "list" };
    case "revoke":
      if (rest.length !== 1 || rest[0].startsWith("-") || !rest[0].trim()) {
        return { cmd: "error", message: "revoke takes exactly one key id" };
      }
      return { cmd: "revoke", id: rest[0] };
    case undefined:
      return { cmd: "error", message: "Missing command" };
    default:
      return { cmd: "error", message: `Unknown command: ${cmd}` };
  }
}

/** ISO datetime → `YYYY-MM-DD HH:MM UTC`. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function keyStatus(key: ApiKey): string {
  return key.revoked_at ? `revoked ${formatTimestamp(key.revoked_at).slice(0, 10)}` : "active";
}

/** Id, label, owner (a user id, or "cli" for keys issued here), created, last used and status; never the hash. */
export function formatKeyTable(keys: ApiKey[]): string {
  if (!keys.length) return "No API keys yet. Create one with: npm run auth:create-key -- --label <name>";
  const rows = [
    ["ID", "LABEL", "OWNER", "CREATED", "LAST USED", "STATUS"],
    ...keys.map((k) => [
      k.id,
      k.label || "-",
      k.user_id ?? "cli",
      k.created,
      k.last_used_at ? formatTimestamp(k.last_used_at) : "never",
      keyStatus(k),
    ]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd()).join("\n");
}

/** The only place a raw key is ever shown. */
export function formatCreated(key: ApiKey, raw: string): string {
  return [
    `Created API key ${key.id}${key.label ? ` (label: ${key.label})` : ""}.`,
    "",
    `  ${raw}`,
    "",
    "Copy it now: this is the only time it will be shown. Only its hash is stored, so it can't be",
    `recovered; if you lose it, revoke ${key.id} and create a new key.`,
    "Agents send it as: Authorization: Bearer <key>",
  ].join("\n");
}

async function run(command: Command): Promise<number> {
  switch (command.cmd) {
    case "help":
      console.log(USAGE);
      return 0;
    case "error":
      console.error(`${command.message}\n\n${USAGE}`);
      return 1;
  }

  const repository = getRepository();
  const where = repository.kind === "postgres" ? `postgres (${process.env.NEON_BRANCH ?? "DATABASE_URL"})` : `fs (${process.env.PM_DATA_DIR || "data"})`;
  console.error(`Backend: ${where}`);

  switch (command.cmd) {
    case "create": {
      const raw = generateApiKey();
      const key = await createApiKey({ label: command.label, hash: hashApiKey(raw) });
      console.log(formatCreated(key, raw));
      return 0;
    }
    case "list":
      console.log(formatKeyTable(await listApiKeys()));
      return 0;
    case "revoke": {
      const before = await getApiKey(command.id);
      if (!before) {
        console.error(`No API key ${command.id}. See: npm run auth:list-keys`);
        return 1;
      }
      if (before.revoked_at) {
        console.log(`${before.id} was already revoked on ${formatTimestamp(before.revoked_at)}; nothing to do.`);
        return 0;
      }
      const key = await revokeApiKey(before.id);
      console.log(`Revoked ${before.id}${before.label ? ` (${before.label})` : ""} at ${formatTimestamp(key!.revoked_at!)}.`);
      return 0;
    }
  }
}

// Only when run as a script, so tests can import the pure helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
