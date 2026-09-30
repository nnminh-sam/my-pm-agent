import { isDeepStrictEqual } from "node:util";
import { scheduleFor } from "./planning";
import { loadWorkspace } from "./repo";
import type { Repository } from "./repository";
import type { FileRepository } from "./repository/file";
import type { PgRepository } from "./repository/postgres";

/**
 * Workspace data, GitHub snapshots and task comments. Users (accounts, password hashes) and API keys are
 * intentionally never imported, exported or compared.
 */
export async function readAll(source: Repository) {
  const [settings, records, { snapshots, comments, problems }] = await Promise.all([
    source.readSettings(),
    source.loadAll(),
    source.loadSnapshotsAndComments(),
  ]);
  return { settings, ...records, snapshots, comments, problems: [...records.problems, ...problems] };
}

/** Copies everything from `source` into Postgres in one transaction. */
export async function importInto(target: PgRepository, source: Repository, { replace = false } = {}) {
  const data = await readAll(source);
  if (data.problems.length) {
    throw new Error(`Source has records that don't parse; fix them first:\n${data.problems.join("\n")}`);
  }
  if (!replace && !(await target.isEmpty())) throw new Error("Target database is not empty; use --replace to overwrite it");
  await target.importAll(data, { replace });
  return data;
}

/** Writes everything from `source` as markdown files (the `data/` layout), numbering counters included. */
export async function exportTo(target: FileRepository, source: Repository) {
  const data = await readAll(source);
  if (data.settings) await target.writeSettings(data.settings);
  for (const version of data.playbooks) await target.insertPlaybookVersion(version);
  await target.insert(data);
  for (const comment of data.comments) await target.insertComment(comment);
  for (const snapshot of data.snapshots) await target.upsertGithubSnapshot(snapshot);
  return data;
}

function diffRecords(kind: string, a: { id: string }[], b: { id: string }[]) {
  const diffs: string[] = [];
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  if (!isDeepStrictEqual(ids(a), ids(b))) diffs.push(`${kind}: ids or order differ`);
  const other = new Map(b.map((x) => [x.id, x as Record<string, unknown>]));
  for (const record of a as Record<string, unknown>[]) {
    const match = other.get(record.id as string);
    if (!match) continue;
    const keys = new Set([...Object.keys(record), ...Object.keys(match)]);
    const fields = [...keys].filter((k) => !isDeepStrictEqual(record[k], match[k]));
    if (fields.length) diffs.push(`${kind} ${record.code ?? record.id}: ${fields.join(", ")} differ`);
  }
  return diffs;
}

/**
 * Loads the workspace and schedule, snapshots and comments through both backends and lists every difference
 * (empty = identical).
 */
export async function compareBackends(a: Repository, b: Repository, at = new Date()): Promise<string[]> {
  const [wa, wb, ga, gb] = await Promise.all([
    loadWorkspace(a),
    loadWorkspace(b),
    a.loadSnapshotsAndComments(),
    b.loadSnapshotsAndComments(),
  ]);
  const diffs = [
    ...(isDeepStrictEqual(wa.settings, wb.settings) ? [] : ["settings differ"]),
    ...diffRecords("project", wa.projects, wb.projects),
    ...diffRecords("milestone", wa.milestones, wb.milestones),
    ...diffRecords("task", wa.tasks, wb.tasks),
    ...diffRecords(
      "playbook",
      wa.playbooks.map((v) => ({ id: v.ref, ...v })),
      wb.playbooks.map((v) => ({ id: v.ref, ...v })),
    ),
    ...diffRecords(
      "snapshot",
      ga.snapshots.map((s) => ({ id: s.key, ...s })),
      gb.snapshots.map((s) => ({ id: s.key, ...s })),
    ),
    ...diffRecords("comment", ga.comments, gb.comments),
    ...(isDeepStrictEqual(wa.problems, wb.problems) && isDeepStrictEqual(ga.problems, gb.problems) ? [] : ["problems differ"]),
  ];
  if (!isDeepStrictEqual(scheduleFor(wa, at), scheduleFor(wb, at))) diffs.push("schedule differs");
  return diffs;
}
