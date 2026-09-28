import { z } from "zod";
import type { Db, Row, Statement } from "../db";
import {
  ApiKeyMeta,
  MilestoneMeta,
  ProjectMeta,
  TaskMeta,
  UserMeta,
  type ApiKey,
  type Milestone,
  type Project,
  type Task,
  type User,
} from "../types";
import { COUNTER, type Changes, type Key, type Records, type Repository } from "./types";

type Table = "tasks" | "milestones" | "projects";
type Entity = Task | Milestone | Project;

const META = { tasks: TaskMeta, milestones: MilestoneMeta, projects: ProjectMeta };
/** Column names are the zod schema keys (types.ts is the single source) plus the markdown body. */
const COLUMNS = {
  tasks: [...Object.keys(TaskMeta.shape), "body"],
  milestones: [...Object.keys(MilestoneMeta.shape), "body"],
  projects: [...Object.keys(ProjectMeta.shape), "body"],
};
const DATE_COLUMNS = new Set(["deadline", "not_before", "created", "completed"]);
/** Written by inserts and allocateNumbers only, so a save from a stale read can't wind a counter back. */
const COUNTERS = new Set<string>(Object.values(COUNTER));
const PARENT = { milestones: "projects", tasks: "milestones" } as const;

const col = (name: string) => `"${name}"`;
// Dates come back as YYYY-MM-DD text rather than driver-parsed Date objects; uuid[] as a plain text[].
const selectColumn = (c: string) =>
  DATE_COLUMNS.has(c) ? `${col(c)}::text as ${col(c)}` : c === "depends_on" ? `${col(c)}::text[] as ${col(c)}` : col(c);
const selectList = (table: Table) => COLUMNS[table].map(selectColumn).join(", ");
/** `U-n` / `K-n` ids, by number. */
const ORDER_BY_ID = "split_part(id, '-', 2)::int";

/** `users` (migrations/002_users.sql): no body column, and not part of loadAll / import. */
const USER_SELECT = Object.keys(UserMeta.shape)
  .map((c) => (DATE_COLUMNS.has(c) ? `${col(c)}::text as ${col(c)}` : col(c)))
  .join(", ");
const userFromRow = (row: Row): User => UserMeta.parse(row);

/** `api_keys` (migrations/003_api_keys.sql): frontmatter-like columns only, not part of loadAll / import. */
const API_KEY_COLUMNS = Object.keys(ApiKeyMeta.shape);
const TIMESTAMP_COLUMNS = new Set(["last_used_at", "revoked_at"]);
// timestamptz comes back as the same UTC ISO string it was written from (`Date#toISOString()`).
const API_KEY_SELECT = API_KEY_COLUMNS.map((c) =>
  DATE_COLUMNS.has(c)
    ? `${col(c)}::text as ${col(c)}`
    : TIMESTAMP_COLUMNS.has(c)
      ? `to_char(${col(c)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${col(c)}`
      : col(c),
).join(", ");
const apiKeyFromRow = (row: Row): ApiKey =>
  // NULL columns are absent optional fields, as for the workspace tables.
  ApiKeyMeta.parse(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)));
const apiKeyParams = (key: Omit<ApiKey, "id">) => [
  key.label,
  key.hash,
  key.created,
  key.last_used_at ?? null,
  key.revoked_at ?? null,
  key.user_id ?? null,
];

function fromRow<T extends Entity>(table: Table, row: Row): T {
  const { body, ...meta } = row;
  // NULL columns are absent optional fields, exactly like a missing frontmatter key.
  const data = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== null));
  return { ...META[table].parse(data), body: (body as string | null) ?? "" } as T;
}

function insert(table: Table, entity: Entity): Statement {
  const cols = COLUMNS[table];
  const record = entity as Entity & Record<string, unknown>;
  return {
    text: `insert into ${table} (${cols.map(col).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    params: cols.map((c) => record[c] ?? null),
  };
}

function update(table: Table, entity: Entity): Statement {
  const cols = COLUMNS[table].filter((c) => c !== "id" && !COUNTERS.has(c));
  const record = entity as Entity & Record<string, unknown>;
  return {
    text: `update ${table} set ${cols.map((c, i) => `${col(c)} = $${i + 2}`).join(", ")} where id = $1`,
    params: [entity.id, ...cols.map((c) => record[c] ?? null)],
  };
}

/** Statements for a set of changes, parents first (foreign keys). */
function statements(changes: Changes, build: (table: Table, entity: Entity) => Statement): Statement[] {
  return [
    ...(changes.projects ?? []).map((p) => build("projects", p)),
    ...(changes.milestones ?? []).map((m) => build("milestones", m)),
    ...(changes.tasks ?? []).map((t) => build("tasks", t)),
  ];
}

export interface ImportData extends Omit<Records, "problems"> {
  settings: Record<string, unknown> | null;
}

/** Relational rows in Postgres (`migrations/`). */
export class PgRepository implements Repository {
  readonly kind = "postgres";

  constructor(private readonly db: Db) {}

  async readSettings() {
    const rows = await this.db.query("select data from settings where id");
    return rows.length ? (rows[0].data as Record<string, unknown>) : null;
  }

  async writeSettings(data: Record<string, unknown>) {
    await this.db.query(
      "insert into settings (id, data) values (true, $1::json) on conflict (id) do update set data = excluded.data",
      [JSON.stringify(data)],
    );
  }

  private async loadTable<T extends Entity>(table: Table, problems: string[]) {
    const rows = await this.db.query(`select ${selectList(table)} from ${table} order by code`);
    const items: T[] = [];
    for (const row of rows) {
      try {
        items.push(fromRow<T>(table, row));
      } catch (err) {
        problems.push(`${table}/${row.code}: ${err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message}`);
      }
    }
    return items;
  }

  async loadAll(): Promise<Records> {
    const problems: string[] = [];
    const [tasks, milestones, projects] = await Promise.all([
      this.loadTable<Task>("tasks", problems),
      this.loadTable<Milestone>("milestones", problems),
      this.loadTable<Project>("projects", problems),
    ]);
    return { tasks, milestones, projects, problems };
  }

  private async get<T extends Entity>(table: Table, key: Key) {
    const [column, value] = "id" in key ? ["id", key.id] : ["code", key.code];
    const rows = await this.db.query(`select ${selectList(table)} from ${table} where ${column} = $1`, [value]);
    return rows.length ? fromRow<T>(table, rows[0]) : null;
  }

  getTask(key: Key) {
    return this.get<Task>("tasks", key);
  }

  getMilestone(key: Key) {
    return this.get<Milestone>("milestones", key);
  }

  getProject(key: Key) {
    return this.get<Project>("projects", key);
  }

  /** One atomic update of the parent's counter, outside any insert transaction (like nextval). */
  async allocateNumbers(kind: "milestones" | "tasks", parentId: string, count: number) {
    const counter = col(COUNTER[kind]);
    const rows = await this.db.query(
      `update ${PARENT[kind]} set ${counter} = ${counter} + $2::int where id = $1 returning ${counter} - $2::int + 1 as first`,
      [parentId, count],
    );
    if (!rows.length) throw new Error(`No ${PARENT[kind].slice(0, -1)} with id ${parentId}`);
    return Number(rows[0].first);
  }

  async insert(changes: Changes) {
    const list = statements(changes, insert);
    if (list.length) await this.db.transaction(list);
  }

  async save(changes: Changes) {
    const list = statements(changes, update);
    if (list.length) await this.db.transaction(list);
  }

  async getUser(id: string) {
    const rows = await this.db.query(`select ${USER_SELECT} from users where id = $1`, [id]);
    return rows.length ? userFromRow(rows[0]) : null;
  }

  async findUserByEmail(email: string) {
    const rows = await this.db.query(`select ${USER_SELECT} from users where email = $1`, [email]);
    return rows.length ? userFromRow(rows[0]) : null;
  }

  async countUsers() {
    const [row] = await this.db.query("select count(*)::int as n from users");
    return Number(row.n);
  }

  async insertUser(draft: Omit<User, "id">) {
    // The id comes from the column default; a taken email inserts nothing (and returns no row).
    const rows = await this.db.query(
      `insert into users (email, password_hash, created) values ($1, $2, $3) on conflict (email) do nothing returning ${USER_SELECT}`,
      [draft.email, draft.password_hash, draft.created],
    );
    return rows.length ? userFromRow(rows[0]) : null;
  }

  async insertApiKey(draft: Omit<ApiKey, "id">) {
    // The id comes from the column default.
    const [row] = await this.db.query(
      `insert into api_keys (label, hash, created, last_used_at, revoked_at, user_id) values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6) returning ${API_KEY_SELECT}`,
      apiKeyParams(draft),
    );
    return apiKeyFromRow(row);
  }

  async findApiKeyByHash(hash: string) {
    const rows = await this.db.query(`select ${API_KEY_SELECT} from api_keys where hash = $1`, [hash]);
    return rows.length ? apiKeyFromRow(rows[0]) : null;
  }

  async listApiKeys() {
    const rows = await this.db.query(`select ${API_KEY_SELECT} from api_keys order by ${ORDER_BY_ID}`);
    return rows.map(apiKeyFromRow);
  }

  async getApiKey(id: string) {
    const rows = await this.db.query(`select ${API_KEY_SELECT} from api_keys where id = $1`, [id]);
    return rows.length ? apiKeyFromRow(rows[0]) : null;
  }

  async saveApiKey(key: ApiKey) {
    await this.db.query(
      "update api_keys set label = $2, hash = $3, created = $4, last_used_at = $5::timestamptz, revoked_at = $6::timestamptz, user_id = $7 where id = $1",
      [key.id, ...apiKeyParams(key)],
    );
  }

  /** A single-column update: a revoke landing between a request's lookup and this touch is kept. */
  async touchApiKey(id: string, at: string) {
    const rows = await this.db.query(
      `update api_keys set last_used_at = $2::timestamptz where id = $1 returning ${API_KEY_SELECT}`,
      [id, at],
    );
    return rows.length ? apiKeyFromRow(rows[0]) : null;
  }

  /** Whether the workspace is empty; users and API keys don't count (they're never imported or replaced). */
  async isEmpty() {
    const [row] = await this.db.query(
      "select (select count(*) from projects) + (select count(*) from milestones) + (select count(*) from tasks) + (select count(*) from settings) as n",
    );
    return Number(row.n) === 0;
  }

  /** Writes everything, counters included, in one transaction (parents first). */
  async importAll(data: ImportData, { replace = false } = {}) {
    const list: Statement[] = [];
    // Users and API keys are left alone: they aren't part of the transferred data.
    if (replace) for (const table of ["tasks", "milestones", "projects", "settings"]) list.push({ text: `delete from ${table}` });
    list.push(...statements(data, insert));
    if (data.settings) list.push({ text: "insert into settings (id, data) values (true, $1::json)", params: [JSON.stringify(data.settings)] });
    await this.db.transaction(list);
  }
}
