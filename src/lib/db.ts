import { neon } from "@neondatabase/serverless";

export type Row = Record<string, unknown>;
export interface Statement {
  text: string;
  params?: unknown[];
}

/** Minimal SQL executor: Neon's HTTP driver in the app, PGlite in tests. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<Row[]>;
  /** Runs the statements in order as one transaction; returns each statement's rows. */
  transaction(statements: Statement[]): Promise<Row[][]>;
}

export function neonDb(url: string): Db {
  const sql = neon(url);
  return {
    query: (text, params) => sql.query(text, params),
    transaction: (statements) => sql.transaction(statements.map((s) => sql.query(s.text, s.params))),
  };
}

let db: Db | undefined;
let dbUnpooled: Db | undefined;

/** Lazily-created runtime client, over the pooled connection (`DATABASE_URL`). */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = neonDb(url);
  }
  return db;
}

/** Lazily-created client for scripts, over the direct connection (`DATABASE_URL_UNPOOLED`). */
export function getUnpooledDb(): Db {
  if (!dbUnpooled) {
    const url = process.env.DATABASE_URL_UNPOOLED;
    if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set");
    dbUnpooled = neonDb(url);
  }
  return dbUnpooled;
}
