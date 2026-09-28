import { getDb } from "../db";
import { getStore } from "../store";
import { FileRepository } from "./file";
import { PgRepository } from "./postgres";
import type { Repository } from "./types";

export type { Repository };

let current: Repository | undefined;

/**
 * Postgres when `PM_STORAGE=postgres`, or when `DATABASE_URL` is set and `PM_STORAGE` isn't `fs`.
 * Otherwise markdown files on the store picked by `getStore()`.
 */
export function getRepository(): Repository {
  if (current) return current;
  const storage = process.env.PM_STORAGE;
  const usePostgres = storage === "postgres" || (storage !== "fs" && Boolean(process.env.DATABASE_URL));
  current = usePostgres ? new PgRepository(getDb()) : new FileRepository(getStore());
  return current;
}

/** Swap the backend; for tests and the import/export scripts. */
export function setRepository(repository: Repository | undefined) {
  current = repository;
}
