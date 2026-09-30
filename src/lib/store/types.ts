/** Minimal file store: paths are relative, e.g. `tasks/T-1.md`. */
export interface FileStore {
  readonly kind: "fs";
  /** Relative paths of all files under a directory prefix (e.g. `tasks/`). */
  list(prefix: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Write only if the path doesn't exist yet. Returns false on conflict. */
  create(path: string, content: string): Promise<boolean>;
  /** Delete a file. Returns false when there was none. */
  remove(path: string): Promise<boolean>;
}
