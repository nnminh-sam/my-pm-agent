import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** One database session: `exec` runs multi-statement SQL, so BEGIN/COMMIT span a whole migration file. */
export interface MigrationSession {
  exec(sql: string): Promise<void>;
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

// Arbitrary constant; serializes concurrent runners.
const LOCK_ID = 7_142_023;

/** Applies `migrations/*.sql` in name order, each in its own transaction. Returns the versions it applied. */
export async function migrate(session: MigrationSession, dir = path.resolve("migrations")): Promise<string[]> {
  await session.exec(
    "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    await session.exec("begin");
    try {
      await session.query("select pg_advisory_xact_lock($1)", [LOCK_ID]);
      const done = await session.query("select 1 from schema_migrations where version = $1", [version]);
      if (!done.length) {
        await session.exec(await readFile(path.join(dir, file), "utf8"));
        await session.query("insert into schema_migrations (version) values ($1)", [version]);
        applied.push(version);
      }
      await session.exec("commit");
    } catch (err) {
      await session.exec("rollback");
      throw err;
    }
  }
  return applied;
}
