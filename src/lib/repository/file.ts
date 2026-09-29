import YAML from "yaml";
import { z } from "zod";
import { withFailure, type GithubFailure } from "../github/sync";
import { parseMarkdown, toMarkdown } from "../markdown";
import { PlaybookVersion } from "../playbook";
import type { FileStore } from "../store/types";
import {
  ApiKeyMeta,
  GITHUB_SNAPSHOT_KEY,
  GithubSnapshot,
  MilestoneMeta,
  PLAYBOOK_REF,
  ProjectMeta,
  TaskComment,
  TaskMeta,
  UserMeta,
  type ApiKey,
  type Milestone,
  type Project,
  type Task,
  type User,
} from "../types";
import { COUNTER, idNumber, type Changes, type Key, type Records, type Repository, type SnapshotsAndComments } from "./types";

const SETTINGS_FILE = "settings.yaml";
/** Playbook versions: `playbooks/<name>@<version>.yaml`, written once and never changed. */
const PLAYBOOKS_DIR = "playbooks";
const playbookPath = (ref: string) => `${PLAYBOOKS_DIR}/${ref}.yaml`;
/** GitHub snapshots: `github_snapshots/<key>.yaml`, the key URI-encoded (it holds `:`, `/` and `#`). */
const SNAPSHOTS_DIR = "github_snapshots";
const snapshotPath = (key: string) => `${SNAPSHOTS_DIR}/${encodeURIComponent(key)}.yaml`;
/**
 * Task comments: `comments/<task id>/<id>.yaml`, so a task's comments are one directory. Comments whose task file is
 * gone are ignored, like the rows Postgres cascades away with their task.
 */
const COMMENTS_DIR = "comments";
const commentPath = (taskId: string, id: string) => `${COMMENTS_DIR}/${taskId}/${id}.yaml`;
const isUuid = (value: string) => z.uuid().safeParse(value).success;
const basename = (p: string, ext: string) => p.split("/").pop()!.slice(0, -ext.length);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Postgres order: by task, then oldest first, then id. */
const compareComments = (a: TaskComment, b: TaskComment) =>
  compareText(a.task_id, b.task_id) || Date.parse(a.created_at) - Date.parse(b.created_at) || compareText(a.id, b.id);
/** YAML in the zod schema's key order; absent optional fields are left out. */
const toYaml = (shape: object, value: object) => {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(shape).filter((k) => record[k] !== undefined);
  return YAML.stringify(Object.fromEntries(keys.map((k) => [k, record[k]])), { lineWidth: 0 });
};

const problem = (where: string, err: unknown) =>
  `${where}: ${err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message}`;

/**
 * Workspace records live in `projects/`, `milestones/` and `tasks/` as `<uuid>.md` (names never change, even when a
 * code does). `users/` holds accounts and `api_keys/` agent keys (`U-n.md`, `K-n.md`); they're never part of
 * loadAll (and so never exported).
 */
type Dir = "tasks" | "milestones" | "projects" | "users" | "api_keys";
type WorkspaceDir = "tasks" | "milestones" | "projects";
type Entity = Task | Milestone | Project | User | ApiKey;

const META = { tasks: TaskMeta, milestones: MilestoneMeta, projects: ProjectMeta, users: UserMeta, api_keys: ApiKeyMeta };
const PREFIX = { users: "U", api_keys: "K" };
const PARENT = { milestones: "projects", tasks: "milestones" } as const;
/** Records with no markdown body. */
const FRONTMATTER_ONLY = new Set<Dir>(["users", "api_keys"]);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/** Frontmatter in the zod schema's key order, then the body. */
function serialize(dir: Dir, entity: Entity) {
  const { body, ...meta } = entity as Entity & Record<string, unknown>;
  const keys = Object.keys(META[dir].shape).filter((k) => k in meta);
  return toMarkdown(Object.fromEntries(keys.map((k) => [k, meta[k]])), (body as string | undefined) ?? "");
}

function parse<T extends Entity>(dir: Dir, text: string): T {
  const { data, body } = parseMarkdown(text);
  const meta = META[dir].parse(data);
  return (FRONTMATTER_ONLY.has(dir) ? meta : { ...meta, body }) as T;
}

/** The files of a set of changes, parents first. */
function files(changes: Changes): [WorkspaceDir, Task | Milestone | Project][] {
  return [
    ...(changes.projects ?? []).map((p): [WorkspaceDir, Project] => ["projects", p]),
    ...(changes.milestones ?? []).map((m): [WorkspaceDir, Milestone] => ["milestones", m]),
    ...(changes.tasks ?? []).map((t): [WorkspaceDir, Task] => ["tasks", t]),
  ];
}

/** Markdown files with YAML frontmatter on a FileStore. */
export class FileRepository implements Repository {
  readonly kind: "fs";

  constructor(private readonly store: FileStore) {
    this.kind = store.kind;
  }

  async readSettings() {
    const raw = await this.store.read(SETTINGS_FILE);
    return raw ? ((YAML.parse(raw) as Record<string, unknown> | null) ?? {}) : null;
  }

  async writeSettings(data: Record<string, unknown>) {
    await this.store.write(SETTINGS_FILE, YAML.stringify(data, { lineWidth: 0 }));
  }

  private async loadDir<T extends Entity>(dir: Dir, problems: string[]) {
    const paths = (await this.store.list(dir)).filter((p) => p.endsWith(".md"));
    const items = await mapLimit(paths, 16, async (p) => {
      const text = await this.store.read(p);
      if (text === null) return undefined;
      try {
        return parse<T>(dir, text);
      } catch (err) {
        problems.push(problem(p, err));
        return undefined;
      }
    });
    return items.filter((x): x is T => x !== undefined);
  }

  private async loadPlaybooks(problems: string[]) {
    const paths = (await this.store.list(PLAYBOOKS_DIR)).filter((p) => p.endsWith(".yaml"));
    const items = await mapLimit(paths, 16, async (p) => {
      const text = await this.store.read(p);
      if (text === null) return undefined;
      try {
        return PlaybookVersion.parse(YAML.parse(text));
      } catch (err) {
        problems.push(problem(p, err));
        return undefined;
      }
    });
    return items.filter((x): x is PlaybookVersion => x !== undefined);
  }

  async loadAll(): Promise<Records> {
    const problems: string[] = [];
    const [tasks, milestones, projects, playbooks] = await Promise.all([
      this.loadDir<Task>("tasks", problems),
      this.loadDir<Milestone>("milestones", problems),
      this.loadDir<Project>("projects", problems),
      this.loadPlaybooks(problems),
    ]);
    return { tasks, milestones, projects, playbooks, problems };
  }

  private async get<T extends Entity>(dir: Dir, id: string) {
    const text = await this.store.read(`${dir}/${id}.md`);
    return text === null ? null : parse<T>(dir, text);
  }

  /** By id: one file. By code: a scan of the directory (a single person's workspace is small). */
  private async find<T extends Task | Milestone | Project>(dir: WorkspaceDir, key: Key) {
    if ("id" in key) return this.get<T>(dir, key.id);
    return (await this.loadDir<T>(dir, [])).find((x) => x.code === key.code) ?? null;
  }

  getTask(key: Key) {
    return this.find<Task>("tasks", key);
  }

  getMilestone(key: Key) {
    return this.find<Milestone>("milestones", key);
  }

  getProject(key: Key) {
    return this.find<Project>("projects", key);
  }

  /** A scan of the directory, like a lookup by code. */
  async findProjectsByRepo(remote: string) {
    const projects = await this.loadDir<Project>("projects", []);
    return projects.filter((p) => p.repos.includes(remote)).sort((a, b) => compareText(a.code, b.code));
  }

  /** Read, bump, write: not atomic, which is fine for a single user (Postgres does it in one statement). */
  async allocateNumbers(kind: "milestones" | "tasks", parentId: string, count: number) {
    const dir = PARENT[kind];
    const parent = await this.get<Project | Milestone>(dir, parentId);
    if (!parent) throw new Error(`No ${dir.slice(0, -1)} with id ${parentId}`);
    const counter = COUNTER[kind];
    const last = (parent as unknown as Record<string, number>)[counter];
    await this.store.write(`${dir}/${parentId}.md`, serialize(dir, { ...parent, [counter]: last + count }));
    return last + 1;
  }

  async insert(changes: Changes) {
    for (const [dir, entity] of files(changes)) {
      if (!(await this.store.create(`${dir}/${entity.id}.md`, serialize(dir, entity)))) {
        throw new Error(`${dir}/${entity.id}.md already exists`);
      }
    }
  }

  /** Keeps each file's counter as it is on disk: only allocateNumbers moves counters. */
  async save(changes: Changes) {
    for (const [dir, entity] of files(changes)) {
      let next: Entity = entity;
      if (dir !== "tasks") {
        const counter = COUNTER[dir === "projects" ? "milestones" : "tasks"];
        const current = await this.get<Project | Milestone>(dir, entity.id);
        if (current) next = { ...entity, [counter]: (current as unknown as Record<string, number>)[counter] } as Entity;
      }
      await this.store.write(`${dir}/${entity.id}.md`, serialize(dir, next));
    }
  }

  /** Null for anything that isn't a playbook ref, so a ref can never reach another path. */
  async getPlaybookVersion(ref: string) {
    if (!PLAYBOOK_REF.test(ref)) return null;
    const text = await this.store.read(playbookPath(ref));
    return text === null ? null : PlaybookVersion.parse(YAML.parse(text));
  }

  async insertPlaybookVersion(version: PlaybookVersion) {
    return this.store.create(playbookPath(version.ref), YAML.stringify(version, { lineWidth: 0 }));
  }

  /** Null for anything that isn't a snapshot key. */
  async getGithubSnapshot(key: string) {
    if (!GITHUB_SNAPSHOT_KEY.test(key)) return null;
    const text = await this.store.read(snapshotPath(key));
    return text === null ? null : GithubSnapshot.parse(YAML.parse(text));
  }

  /** Validated first, as Postgres' checks would. */
  async upsertGithubSnapshot(snapshot: GithubSnapshot) {
    const valid = GithubSnapshot.parse(snapshot);
    await this.store.write(snapshotPath(valid.key), toYaml(GithubSnapshot.shape, valid));
  }

  /**
   * Read, merge the failure's columns, write. Not atomic across processes: the file backend is a local,
   * single-user store, where a webhook landing between the read and the write is not a practical concern.
   */
  async recordGithubFailure(key: string, failure: GithubFailure) {
    const next = GithubSnapshot.parse(withFailure(key, await this.getGithubSnapshot(key), failure));
    await this.upsertGithubSnapshot(next);
    return next;
  }

  /** Unparseable files are skipped, as they are in loadAll. */
  private async readComments(taskId: string, problems: string[]) {
    const paths = (await this.store.list(`${COMMENTS_DIR}/${taskId}`)).filter((p) => p.endsWith(".yaml"));
    const items = await mapLimit(paths, 16, async (p) => {
      const text = await this.store.read(p);
      if (text === null) return undefined;
      try {
        const comment = TaskComment.parse(YAML.parse(text));
        if (comment.task_id !== taskId || comment.id !== basename(p, ".yaml")) throw new Error("its ids don't match its path");
        return comment;
      } catch (err) {
        problems.push(problem(p, err));
        return undefined;
      }
    });
    return items.filter((x): x is TaskComment => x !== undefined);
  }

  async listComments(taskId: string) {
    if (!isUuid(taskId)) return [];
    return (await this.readComments(taskId, [])).sort(compareComments);
  }

  /** Validated first, and only on a stored task, as Postgres' checks and foreign key would. */
  async insertComment(comment: TaskComment) {
    const valid = TaskComment.parse(comment);
    if ((await this.store.read(`tasks/${valid.task_id}.md`)) === null) throw new Error(`No task with id ${valid.task_id}`);
    if (!(await this.store.create(commentPath(valid.task_id, valid.id), toYaml(TaskComment.shape, valid)))) {
      throw new Error(`${commentPath(valid.task_id, valid.id)} already exists`);
    }
  }

  async deleteComment(taskId: string, id: string) {
    if (!isUuid(taskId) || !isUuid(id)) return false;
    return this.store.remove(commentPath(taskId, id));
  }

  async loadSnapshotsAndComments(): Promise<SnapshotsAndComments> {
    const problems: string[] = [];
    const snapshotPaths = (await this.store.list(SNAPSHOTS_DIR)).filter((p) => p.endsWith(".yaml"));
    const snapshots = await mapLimit(snapshotPaths, 16, async (p) => {
      const text = await this.store.read(p);
      if (text === null) return undefined;
      try {
        const snapshot = GithubSnapshot.parse(YAML.parse(text));
        if (snapshotPath(snapshot.key) !== p) throw new Error(`its key ${snapshot.key} doesn't match its file name`);
        return snapshot;
      } catch (err) {
        problems.push(problem(p, err));
        return undefined;
      }
    });

    const tasks = new Set((await this.store.list("tasks")).filter((p) => p.endsWith(".md")).map((p) => basename(p, ".md")));
    const taskDirs = (await this.store.list(COMMENTS_DIR)).map((p) => p.split("/").pop()!).filter((id) => tasks.has(id));
    const comments = (await mapLimit(taskDirs, 4, (taskId) => this.readComments(taskId, problems))).flat();

    return {
      snapshots: snapshots.filter((x): x is GithubSnapshot => x !== undefined).sort((a, b) => compareText(a.key, b.key)),
      comments: comments.sort(compareComments),
      problems,
    };
  }

  private async nextNumber(dir: "users" | "api_keys") {
    const paths = await this.store.list(dir);
    return paths.reduce((max, p) => Math.max(max, idNumber(p.split("/").pop()!.replace(/\.md$/, ""))), 0) + 1;
  }

  /** Create a file with the next free `U-n` / `K-n` id; retries if another request grabbed the same id. */
  private async createWithNextId(dir: "users" | "api_keys", build: (id: string) => User | ApiKey) {
    let n = await this.nextNumber(dir);
    for (let attempt = 0; attempt < 20; attempt++, n++) {
      const entity = build(`${PREFIX[dir]}-${n}`);
      if (await this.store.create(`${dir}/${entity.id}.md`, serialize(dir, entity))) return entity;
    }
    throw new Error(`Could not allocate a new ${PREFIX[dir]} id`);
  }

  getUser(id: string) {
    return this.get<User>("users", id);
  }

  /** Scans `users/`: fine for the handful of accounts a single-user app has. Unparseable files are skipped. */
  async findUserByEmail(email: string) {
    const users = await this.loadDir<User>("users", []);
    return users.find((u) => u.email === email) ?? null;
  }

  async countUsers() {
    return (await this.store.list("users")).filter((p) => p.endsWith(".md")).length;
  }

  /** The email check and the create aren't atomic; acceptable for a single-user app's sign-up. */
  async insertUser(draft: Omit<User, "id">) {
    if (await this.findUserByEmail(draft.email)) return null;
    return (await this.createWithNextId("users", (id) => ({ id, ...draft }))) as User;
  }

  async insertApiKey(draft: Omit<ApiKey, "id">) {
    return (await this.createWithNextId("api_keys", (id) => ({ id, ...draft }))) as ApiKey;
  }

  /** Scans `api_keys/`: a single-user app has a handful of keys. Unparseable files are skipped. */
  async findApiKeyByHash(hash: string) {
    const keys = await this.loadDir<ApiKey>("api_keys", []);
    return keys.find((k) => k.hash === hash) ?? null;
  }

  /** Unparseable files are skipped. */
  async listApiKeys() {
    const keys = await this.loadDir<ApiKey>("api_keys", []);
    return keys.sort((a, b) => idNumber(a.id) - idNumber(b.id));
  }

  getApiKey(id: string) {
    return this.get<ApiKey>("api_keys", id);
  }

  async saveApiKey(key: ApiKey) {
    await this.store.write(`api_keys/${key.id}.md`, serialize("api_keys", key));
  }

  /**
   * Re-reads the file right before writing and changes only `last_used_at`, so a revoke that landed after
   * the caller's lookup is kept (files have no single-field update; the read-write window is just this call).
   */
  async touchApiKey(id: string, at: string) {
    const key = await this.getApiKey(id);
    if (!key) return null;
    const next: ApiKey = { ...key, last_used_at: at };
    await this.saveApiKey(next);
    return next;
  }
}
