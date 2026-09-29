import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileStore } from "./types";

export class FsStore implements FileStore {
  readonly kind = "fs";

  constructor(private readonly root: string) {}

  private resolve(rel: string) {
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`Invalid path: ${rel}`);
    return full;
  }

  async list(prefix: string) {
    try {
      const entries = await readdir(this.resolve(prefix));
      return entries.filter((name) => !name.startsWith(".")).map((name) => path.posix.join(prefix, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async read(rel: string) {
    try {
      return await readFile(this.resolve(rel), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(rel: string, content: string) {
    const full = this.resolve(rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async create(rel: string, content: string) {
    const full = this.resolve(rel);
    await mkdir(path.dirname(full), { recursive: true });
    try {
      await writeFile(full, content, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async remove(rel: string) {
    try {
      await unlink(this.resolve(rel));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
