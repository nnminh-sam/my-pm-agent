/**
 * Validation for the repo-link server actions. Server actions are reachable by POST with arbitrary values (a File where
 * a string is expected), so each value is checked at runtime. Failures are values: production redacts thrown errors.
 */

export type RepoLinkResult = { ok: true } | { ok: false; message: string };

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export type ParsedRepoLink = { ok: true; project: string; remote: string } | { ok: false; message: string };

/** `project` (code or id) and `remote` (any git remote form, or owner/repo) from a form. */
export function parseRepoLink(formData: unknown): ParsedRepoLink {
  if (!(formData instanceof FormData)) return { ok: false, message: "Invalid request" };
  return parseRepoLinkArgs(formData.get("project"), formData.get("remote"));
}

export function parseRepoLinkArgs(project: unknown, remote: unknown): ParsedRepoLink {
  if (!nonEmptyString(project)) return { ok: false, message: "Missing project" };
  if (!nonEmptyString(remote)) return { ok: false, message: "Enter a repository, like owner/repo" };
  return { ok: true, project, remote: remote.trim() };
}

/** `owner/repo` (no host, no scheme, exactly two segments) means github.com. Anything else is taken as a remote. */
export function withDefaultHost(remote: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(remote) && !remote.includes(":") ? `github.com/${remote}` : remote;
}
