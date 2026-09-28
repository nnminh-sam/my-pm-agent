import path from "node:path";
import { FsStore } from "./fs";
import type { FileStore } from "./types";

export type { FileStore };

let store: FileStore | undefined;

/**
 * Local markdown files (`./data`, or `PM_DATA_DIR`).
 * Vercel's filesystem is read-only, so deployments must use Postgres (`DATABASE_URL`).
 */
export function getStore(): FileStore {
  if (store) return store;
  if (process.env.VERCEL) {
    throw new Error("No writable storage: set DATABASE_URL (Neon) on this deployment, then redeploy.");
  }
  // Local-only store: keep Turbopack from tracing the whole project into the server bundle.
  store = new FsStore(path.resolve(/*turbopackIgnore: true*/ process.env.PM_DATA_DIR || "data"));
  return store;
}
