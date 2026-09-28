/**
 * Ids and codes. Every project, milestone and task has an opaque uuid `id` (the primary key, never changes) and a
 * human `code`: projects `PMA` (chosen), milestones `PMA-M1` (numbered within their project), tasks `PMA-M1-T1`
 * (numbered within their milestone). Codes change when a project's code changes or an item moves, so references
 * (parents, depends_on) always hold ids. Pure: no I/O, safe to import from client components.
 */

export const PROJECT_CODE = /^[A-Z][A-Z0-9]{1,5}$/;
export const MILESTONE_CODE = /^[A-Z][A-Z0-9]{1,5}-M[1-9]\d*$/;
export const TASK_CODE = /^[A-Z][A-Z0-9]{1,5}-M[1-9]\d*-T[1-9]\d*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids from before milestones (T-12, F-3, PRJ-1); only recognised to explain that they're gone. */
const LEGACY_ID = /^(T|F|PRJ)-\d+$/i;

export type CodeKind = "project" | "milestone" | "task";

export const milestoneCode = (projectCode: string, number: number) => `${projectCode}-M${number}`;
export const taskCode = (milestoneCode: string, number: number) => `${milestoneCode}-T${number}`;

/** Codes are stored uppercase and matched case-insensitively. */
export const normalizeCode = (ref: string) => ref.trim().toUpperCase();

/** What a (normalized) code refers to, if it is one. */
export function codeKind(code: string): CodeKind | undefined {
  if (TASK_CODE.test(code)) return "task";
  if (MILESTONE_CODE.test(code)) return "milestone";
  if (PROJECT_CODE.test(code)) return "project";
  return undefined;
}

export const isId = (ref: string) => UUID.test(ref.trim());
export const isLegacyId = (ref: string) => LEGACY_ID.test(ref.trim());

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Updates mentions of renamed milestone and task codes in markdown ("after PMA-M1-T3"). A code matches only as a
 * whole word, so PMA-M1 never matches inside PMA-M10 or PMA-M1-T3, and all renames apply in one pass, so they can't
 * chain. Bare project codes are left alone: a code like P1 reads the same as a priority.
 */
export function renameMentions(text: string, renames: ReadonlyMap<string, string>): string {
  const codes = [...renames.keys()].filter((code) => codeKind(code) === "milestone" || codeKind(code) === "task");
  if (!codes.length) return text;
  codes.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9-])(?:${codes.map(escapeRegExp).join("|")})(?![A-Za-z0-9]|-[A-Za-z0-9])`, "g");
  return text.replace(pattern, (code) => renames.get(code) ?? code);
}

const chunks = (s: string) => s.match(/\d+|\D+/g) ?? [];
const isDigits = (s: string) => s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;

/** Natural order, so PMA-M2 comes before PMA-M10 and T9 before T10. Locale-independent. */
export function compareCodes(a: string, b: string): number {
  const x = chunks(a);
  const y = chunks(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (isDigits(x[i]) && isDigits(y[i]) && Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

/** A UUID v7 (RFC 9562): a 48-bit Unix-millisecond timestamp, then random bits, so ids sort by creation time. */
export function newId(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
