// Markdown (./data) → Postgres, then verifies both backends load identically.
// npm run db:import -- [--dry-run] [--replace]
import path from "node:path";
import { getUnpooledDb } from "../src/lib/db";
import { FileRepository } from "../src/lib/repository/file";
import { PgRepository } from "../src/lib/repository/postgres";
import { FsStore } from "../src/lib/store/fs";
import { compareBackends, importInto, readAll } from "../src/lib/transfer";

async function main() {
  const args = process.argv.slice(2);
  const from = process.env.PM_DATA_DIR || "data";
  const source = new FileRepository(new FsStore(path.resolve(from)));
  const branch = process.env.NEON_BRANCH ?? "unknown";

  if (args.includes("--dry-run")) {
    const data = await readAll(source);
    console.log(
      `Would import from ${from} into ${branch}: ${data.projects.length} projects, ${data.milestones.length} milestones, ${data.tasks.length} tasks, ${data.playbooks.length} playbook versions, settings: ${data.settings ? "yes" : "no"}`,
    );
    for (const problem of data.problems) console.log(`problem: ${problem}`);
    return;
  }

  const target = new PgRepository(getUnpooledDb());
  const data = await importInto(target, source, { replace: args.includes("--replace") });
  console.log(
    `Imported from ${from} into ${branch}: ${data.projects.length} projects, ${data.milestones.length} milestones, ${data.tasks.length} tasks, ${data.playbooks.length} playbook versions`,
  );
  const diffs = await compareBackends(source, target);
  if (diffs.length) {
    console.error(`Verification found ${diffs.length} difference(s):\n${diffs.join("\n")}`);
    process.exit(1);
  }
  console.log("Verified: workspace and schedule are identical on both backends.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
