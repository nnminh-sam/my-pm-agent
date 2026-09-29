import { describe, expect, it } from "vitest";
import type { GithubSnapshot } from "../types";
import type { GithubError, PrOverview } from "./overview";
import {
  applyFetchResult,
  decidePull,
  FRESH_MS,
  githubRemote,
  parsePrRef,
  prOverviewOf,
  repoPrsOf,
  snapshotError,
  syncStatus,
  toGithubRepo,
} from "./sync";

const NOW = new Date("2026-09-29T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const KEY = "pr:o/r#7";

const overview: PrOverview = {
  repo: "o/r",
  number: 7,
  title: "Add thing",
  body: "",
  state: "open",
  merged_at: null,
  milestone: null,
  reviewers: [{ login: "carol", state: "approved" }],
  assignees: [],
  author: "alice",
  base: "main",
  head: "feat",
  updated_at: "2026-09-29T09:00:00Z",
  url: "https://github.com/o/r/pull/7",
};
const good: GithubSnapshot = { key: KEY, data: overview, fetched_at: ago(5 * 60_000), last_attempt_at: ago(5 * 60_000) };
const err = (e: Partial<GithubError> = {}): GithubError => ({
  reason: "github_down",
  status: 503,
  message: "Service Unavailable",
  request_id: "R1",
  retry_after: null,
  ...e,
});

describe("decidePull", () => {
  it("no snapshot: fetch", () => {
    expect(decidePull(null, NOW)).toEqual({ action: "fetch", reason: "never_fetched" });
    expect(decidePull(null, NOW, { force: true })).toEqual({ action: "fetch", reason: "never_fetched" });
  });
  it("only failed attempts (no fetched_at): fetch", () => {
    expect(decidePull({ key: KEY, last_attempt_at: ago(1000), last_error: { reason: "github_down" } }, NOW)).toEqual({
      action: "fetch",
      reason: "never_fetched",
    });
  });
  it("fresh: serve", () => {
    expect(decidePull({ ...good, fetched_at: ago(0) }, NOW)).toEqual({ action: "serve", reason: "fresh" });
    expect(decidePull({ ...good, fetched_at: ago(FRESH_MS - 1) }, NOW)).toEqual({ action: "serve", reason: "fresh" });
  });
  it("stale: fetch", () => {
    expect(decidePull({ ...good, fetched_at: ago(FRESH_MS) }, NOW)).toEqual({ action: "fetch", reason: "stale" });
    expect(decidePull(good, NOW)).toEqual({ action: "fetch", reason: "stale" });
  });
  it("fresh with force (Retry now): fetch", () => {
    expect(decidePull({ ...good, fetched_at: ago(1000) }, NOW, { force: true })).toEqual({ action: "fetch", reason: "forced" });
    expect(decidePull(good, NOW, { force: true })).toEqual({ action: "fetch", reason: "stale" });
  });
  it("retry_after in the future: serve, even forced, with or without data", () => {
    const limited = { ...good, last_error: { reason: "rate_limited" }, retry_after: later(1) };
    expect(decidePull(limited, NOW)).toEqual({ action: "serve", reason: "retry_after" });
    expect(decidePull(limited, NOW, { force: true })).toEqual({ action: "serve", reason: "retry_after" });
    const neverLimited = { key: KEY, last_error: { reason: "rate_limited" }, retry_after: later(60_000) };
    expect(decidePull(neverLimited, NOW, { force: true })).toEqual({ action: "serve", reason: "retry_after" });
  });
  it("retry_after in the past (or now): back to the usual rules", () => {
    const passed = { ...good, last_error: { reason: "rate_limited" }, retry_after: ago(1) };
    expect(decidePull(passed, NOW)).toEqual({ action: "fetch", reason: "stale" });
    expect(decidePull({ ...passed, retry_after: NOW.toISOString() }, NOW)).toEqual({ action: "fetch", reason: "stale" });
    expect(decidePull({ ...passed, fetched_at: ago(1000) }, NOW)).toEqual({ action: "serve", reason: "fresh" });
    expect(decidePull({ ...passed, fetched_at: ago(1000) }, NOW, { force: true })).toEqual({ action: "fetch", reason: "forced" });
  });
});

describe("applyFetchResult", () => {
  it("success sets data and fetched_at, and clears last_error and retry_after", () => {
    const failed = { ...good, last_error: { reason: "rate_limited" }, retry_after: ago(1) };
    const next = applyFetchResult(KEY, failed, { ok: true, data: { ...overview, title: "New" } }, NOW);
    expect(next).toEqual({ key: KEY, data: { ...overview, title: "New" }, fetched_at: NOW.toISOString(), last_attempt_at: NOW.toISOString() });
    expect(applyFetchResult("repo:o/r", null, { ok: true, data: [] }, NOW)).toEqual({
      key: "repo:o/r",
      data: [],
      fetched_at: NOW.toISOString(),
      last_attempt_at: NOW.toISOString(),
    });
  });
  it("failure keeps the good data and fetched_at (a failed fetch never overwrites a good snapshot)", () => {
    const next = applyFetchResult(KEY, good, { ok: false, error: err() }, NOW);
    expect(next).toEqual({
      key: KEY,
      data: overview,
      fetched_at: good.fetched_at,
      last_attempt_at: NOW.toISOString(),
      last_error: { reason: "github_down", status: 503, message: "Service Unavailable", request_id: "R1" },
    });
    expect(next.data).toBe(good.data);
  });
  it("a first failure stores no data", () => {
    expect(applyFetchResult(KEY, null, { ok: false, error: err({ reason: "timeout", status: null }) }, NOW)).toEqual({
      key: KEY,
      last_attempt_at: NOW.toISOString(),
      last_error: { reason: "timeout", status: null, message: "Service Unavailable", request_id: "R1" },
    });
  });
  it("a rate limit sets retry_after; a later failure without one clears it", () => {
    const limited = applyFetchResult(KEY, good, { ok: false, error: err({ reason: "rate_limited", status: 429, retry_after: later(3600_000) }) }, NOW);
    expect(limited).toMatchObject({ data: overview, retry_after: later(3600_000), last_error: { reason: "rate_limited", status: 429 } });
    expect(limited.last_error).not.toHaveProperty("retry_after");
    expect(applyFetchResult(KEY, limited, { ok: false, error: err() }, NOW)).not.toHaveProperty("retry_after");
  });
});

describe("syncStatus", () => {
  it("no snapshot: never, nothing else", () => {
    expect(syncStatus(null)).toEqual({ sync: "never", fetched_at: null, last_attempt_at: null, reason: null, error: null, retry_after: null });
  });
  it("a row without data (the first fetch failed): never, with the reason", () => {
    const s = applyFetchResult(KEY, null, { ok: false, error: err({ reason: "rate_limited", status: 429, retry_after: later(60_000) }) }, NOW);
    expect(syncStatus(s)).toEqual({
      sync: "never",
      fetched_at: null,
      last_attempt_at: NOW.toISOString(),
      reason: "rate_limited",
      error: { reason: "rate_limited", status: 429, message: "Service Unavailable", request_id: "R1" },
      retry_after: later(60_000),
    });
  });
  it("data and a successful last attempt: synced", () => {
    expect(syncStatus(good)).toEqual({
      sync: "synced",
      fetched_at: good.fetched_at,
      last_attempt_at: good.last_attempt_at,
      reason: null,
      error: null,
      retry_after: null,
    });
  });
  it("data and a failed last attempt: out_of_sync, with the last sync time and the reason", () => {
    const s = applyFetchResult(KEY, good, { ok: false, error: err() }, NOW);
    expect(syncStatus(s)).toMatchObject({
      sync: "out_of_sync",
      fetched_at: good.fetched_at,
      last_attempt_at: NOW.toISOString(),
      reason: "github_down",
      error: { status: 503, message: "Service Unavailable", request_id: "R1" },
    });
  });
  it("reads an odd stored error leniently", () => {
    expect(snapshotError({ key: KEY, last_error: { reason: "nope", status: "x" } })).toEqual({
      reason: "github_down",
      status: null,
      message: "",
      request_id: null,
    });
    expect(snapshotError(good)).toBeNull();
  });
});

describe("typed data", () => {
  it("parses a PR overview or a repo list, else null", () => {
    expect(prOverviewOf(good)).toEqual(overview);
    expect(prOverviewOf({ key: KEY, data: { title: "partial" } })).toBeNull();
    expect(prOverviewOf(null)).toBeNull();
    expect(repoPrsOf({ key: "repo:o/r", data: [] })).toEqual([]);
    expect(repoPrsOf(good)).toBeNull();
  });
});

describe("repos and refs", () => {
  it("converts project remotes and owner/repo in one place", () => {
    expect(toGithubRepo("github.com/o/r")).toBe("o/r");
    expect(toGithubRepo("O/Web.Site")).toBe("o/web.site");
    expect(githubRemote("o/r")).toBe("github.com/o/r");
    for (const bad of ["gitlab.com/o/r", "github.com/o", "o/..", "o/.", "../r", "o/r/x", "", "o/r#1"]) expect(toGithubRepo(bad)).toBeNull();
  });
  it("parses PR refs", () => {
    expect(parsePrRef("o/web.site#12")).toEqual({ repo: "o/web.site", number: 12 });
    for (const bad of ["o/r", "o/r#0", "o/..#1", "https://github.com/o/r/pull/1", "O/R#1"]) expect(parsePrRef(bad)).toBeNull();
  });
});
