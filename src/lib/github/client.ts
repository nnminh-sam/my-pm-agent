/**
 * GitHub REST client. Server-only by convention: it reads GITHUB_TOKEN, so import it only from route handlers,
 * server components and repo code, never from a "use client" module. (The repo has no `server-only` package.)
 * It touches no storage; snapshot reads/writes belong to the pull logic.
 */
import {
  classifyFailure,
  mapPr,
  mapRepoPrItem,
  redact,
  type GithubError,
  type GithubResult,
  type PrOverview,
  type RepoPrItem,
} from "./overview";

export const GITHUB_TIMEOUT_MS = 5000;

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

async function call(r: Resolved, path: string): Promise<Call> {
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
    const name = (e as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const networkMessage = e instanceof Error ? e.message : String(e);
    return { ok: false, error: classifyFailure({ status: null, timedOut, networkMessage, now: r.now(), secrets: r.secrets }) };
  }
  try {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: classifyFailure({ status: res.status, headers: res.headers, body, now: r.now(), secrets: r.secrets }) };
    }
    return { ok: true, json: await res.json(), headers: res.headers };
  } catch (e) {
    // A body that stalls past the timeout aborts here; anything else is an unusable response.
    const name = (e as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const networkMessage = e instanceof Error ? e.message : "Invalid response";
    return { ok: false, error: classifyFailure({ status: null, timedOut, networkMessage, now: r.now(), secrets: r.secrets }) };
  }
}

function noToken(r: Resolved): GithubError {
  return { reason: "bad_token", status: null, message: redact("GITHUB_TOKEN is not set", r.secrets), request_id: null, retry_after: null };
}

/** `owner/repo` -> URL path segment; the caller passes a normalized repo. */
const repoPath = (repo: string) => `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

/** Fetch a PR and its reviews in parallel (5s each). All-or-nothing: either call failing is an error. */
export async function fetchPr(repo: string, number: number, options: GithubClientOptions = {}): Promise<GithubResult<PrOverview>> {
  const r = resolve(options);
  if (!r.token) return { ok: false, error: noToken(r) };
  const base = `${repoPath(repo)}/pulls/${number}`;
  const [pr, reviews] = await Promise.all([call(r, base), call(r, `${base}/reviews?per_page=100`)]);
  if (!pr.ok) return { ok: false, error: pr.error };
  if (!reviews.ok) return { ok: false, error: reviews.error };
  return { ok: true, data: mapPr(repo, pr.json, reviews.json) };
}

/** One call: the repo's open PRs (reviewers are the requested ones only). */
export async function fetchOpenPrs(repo: string, options: GithubClientOptions = {}): Promise<GithubResult<RepoPrItem[]>> {
  const r = resolve(options);
  if (!r.token) return { ok: false, error: noToken(r) };
  const res = await call(r, `${repoPath(repo)}/pulls?state=open&per_page=100`);
  if (!res.ok) return { ok: false, error: res.error };
  const list = Array.isArray(res.json) ? res.json : [];
  return { ok: true, data: list.map((p) => mapRepoPrItem(repo, p)) };
}
