/**
 * GitHub REST client. Server-only by convention: it reads GITHUB_TOKEN, so import it only from route handlers,
 * server components and repo code, never from a "use client" module. (The repo has no `server-only` package.)
 * It touches no storage; snapshot reads/writes belong to the pull logic.
 */
import {
  classifyFailure,
  GITHUB_TIMEOUT_MS,
  mapPr,
  mapRepoPrItem,
  redact,
  type GithubError,
  type GithubResult,
  type PrOverview,
  type RepoPrItem,
} from "./overview";

export { GITHUB_TIMEOUT_MS };

export interface GithubClientOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  baseUrl?: string;
  token?: string;
  webhookSecret?: string;
  timeoutMs?: number;
}

interface Resolved {
  fetch: typeof fetch;
  now: () => Date;
  baseUrl: string;
  token: string | undefined;
  secrets: Array<string | undefined>;
  timeoutMs: number;
}

function resolve(o: GithubClientOptions): Resolved {
  const token = o.token ?? process.env.GITHUB_TOKEN;
  return {
    fetch: o.fetch ?? fetch,
    now: o.now ?? (() => new Date()),
    baseUrl: (o.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    token: token || undefined,
    secrets: [token, o.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET],
    timeoutMs: o.timeoutMs ?? GITHUB_TIMEOUT_MS,
  };
}

type Call = { ok: true; json: unknown; headers: Headers } | { ok: false; error: GithubError };

const aborted = (e: unknown) => {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

async function call(r: Resolved, path: string): Promise<Call> {
  const failed = (f: Partial<Parameters<typeof classifyFailure>[0]>): Call => ({
    ok: false,
    error: classifyFailure({ status: null, ...f, timeoutMs: r.timeoutMs, now: r.now(), secrets: r.secrets }),
  });
  let res: Response;
  try {
    res = await r.fetch(`${r.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${r.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(r.timeoutMs),
    });
  } catch (e) {
    return failed({ timedOut: aborted(e), networkMessage: e instanceof Error ? e.message : String(e) });
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    // A body that stalls past the timeout aborts here; anything else is an unusable response.
    if (res.ok) return failed({ timedOut: aborted(e), networkMessage: e instanceof Error ? e.message : "Invalid response" });
    text = "";
  }
  if (!res.ok) return failed({ status: res.status, headers: res.headers, body: text });
  try {
    return { ok: true, json: JSON.parse(text), headers: res.headers };
  } catch {
    // The parser's own text can quote the body; a fixed message can't leak anything.
    return failed({ networkMessage: "Invalid JSON from GitHub" });
  }
}

function noToken(r: Resolved): GithubError {
  return { reason: "bad_token", status: null, message: redact("GITHUB_TOKEN is not set", r.secrets), request_id: null, retry_after: null };
}

/** `owner/repo` as GitHub allows it; checked before any URL is built. */
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/repo` -> URL path, or null for anything else (other shapes, `.` / `..` segments). */
function repoPath(repo: string): string | null {
  if (!REPO.test(repo)) return null;
  const [owner, name] = repo.split("/");
  if (name === "." || name === "..") return null;
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function invalid(r: Resolved, what: string): GithubError {
  return { reason: "no_access", status: null, message: redact(`Not a GitHub ${what}`, r.secrets), request_id: null, retry_after: null };
}

/** Fetch a PR and its reviews in parallel (5s each). All-or-nothing: either call failing is an error. */
export async function fetchPr(repo: string, number: number, options: GithubClientOptions = {}): Promise<GithubResult<PrOverview>> {
  const r = resolve(options);
  const path = repoPath(repo);
  if (!path) return { ok: false, error: invalid(r, `repo like owner/repo: "${repo}"`) };
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, error: invalid(r, `PR number: ${number}`) };
  if (!r.token) return { ok: false, error: noToken(r) };
  const base = `${path}/pulls/${number}`;
  const [pr, reviews] = await Promise.all([call(r, base), call(r, `${base}/reviews?per_page=100`)]);
  if (!pr.ok) return { ok: false, error: pr.error };
  if (!reviews.ok) return { ok: false, error: reviews.error };
  return { ok: true, data: mapPr(repo, pr.json, reviews.json) };
}

/** One call: the repo's open PRs (reviewers are the requested ones only). */
export async function fetchOpenPrs(repo: string, options: GithubClientOptions = {}): Promise<GithubResult<RepoPrItem[]>> {
  const r = resolve(options);
  const path = repoPath(repo);
  if (!path) return { ok: false, error: invalid(r, `repo like owner/repo: "${repo}"`) };
  if (!r.token) return { ok: false, error: noToken(r) };
  const res = await call(r, `${path}/pulls?state=open&per_page=100`);
  if (!res.ok) return { ok: false, error: res.error };
  const list = Array.isArray(res.json) ? res.json : [];
  return { ok: true, data: list.map((p) => mapRepoPrItem(repo, p)) };
}
