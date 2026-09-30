// Postgres → markdown files in the data/ layout, for backups and rollback.
// npm run db:export -- --to <dir>
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getUnpooledDb } from "../src/lib/db";
import { FileRepository } from "../src/lib/repository/file";
import { PgRepository } from "../src/lib/repository/postgres";
import { FsStore } from "../src/lib/store/fs";
import { compareBackends, exportTo } from "../src/lib/transfer";

async function main() {
  const args = process.argv.slice(2);
  const to = args.includes("--to") ? args[args.indexOf("--to") + 1] : undefined;
  if (!to) throw new Error("Usage: npm run db:export -- --to <dir>");
  const dir = path.resolve(to);
  const existing = await readdir(dir).catch(() => []);
  if (existing.length) throw new Error(`${dir} is not empty; export into a new directory`);

  const source = new PgRepository(getUnpooledDb());
  const target = new FileRepository(new FsStore(dir));
  const data = await exportTo(target, source);
  console.log(
    `Exported ${process.env.NEON_BRANCH ?? "database"} to ${dir}: ${data.projects.length} projects, ${data.milestones.length} milestones, ${data.tasks.length} tasks, ${data.playbooks.length} playbook versions, ${data.snapshots.length} GitHub snapshots, ${data.comments.length} comments`,
  );
  const diffs = await compareBackends(source, target);
  if (diffs.length) {
    console.error(`Verification found ${diffs.length} difference(s):\n${diffs.join("\n")}`);
    process.exit(1);
  }
  console.log("Verified: the export loads identically to the database.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
