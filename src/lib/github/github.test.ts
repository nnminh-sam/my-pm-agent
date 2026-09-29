import { describe, expect, it } from "vitest";
import { fetchOpenPrs, fetchPr } from "./client";
import { classifyFailure, mapPr, mapRepoPrItem, redact, reduceReviews } from "./overview";

const TOKEN = "ghp_faketoken1234567890";
const SECRET = "whsec_fakesecret";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const h = (o: Record<string, string>) => new Headers(o);

const pull = {
  number: 7,
  title: "Add\u0000 thing",
  body: "body",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  milestone: { title: "v1" },
  user: { login: "alice" },
  assignees: [{ login: "bob" }],
  requested_reviewers: [{ login: "carol" }, { login: "dave" }],
  base: { ref: "main" },
  head: { ref: "feat" },
  updated_at: "2026-01-01T00:00:00Z",
  html_url: "https://github.com/O/R/pull/7",
  diff_url: "x",
  additions: 5,
};
const review = (login: string, state: string, at: string) => ({ user: { login }, state, submitted_at: at, body: "secret review text" });

describe("mapPr", () => {
  it("maps the overview and drops everything else", () => {
    const o = mapPr("O/R", pull, [review("dave", "APPROVED", "2026-01-01T00:00:00Z")]);
    expect(o).toEqual({
      repo: "o/r",
      number: 7,
      title: "Add thing",
      body: "body",
      state: "open",
      merged_at: null,
      milestone: "v1",
      reviewers: [{ login: "dave", state: "approved" }, { login: "carol", state: "pending" }],
      assignees: ["bob"],
      author: "alice",
      base: "main",
      head: "feat",
      updated_at: "2026-01-01T00:00:00Z",
      url: "https://github.com/O/R/pull/7",
    });
    expect(JSON.stringify(o)).not.toContain("review text");
    expect(JSON.stringify(o)).not.toContain("\u0000");
  });
  it("maps draft, merged, closed", () => {
    expect(mapPr("o/r", { ...pull, draft: true }, []).state).toBe("draft");
    const m = mapPr("o/r", { ...pull, state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z" }, []);
    expect(m.state).toBe("merged");
    expect(m.merged_at).toBe("2026-01-02T00:00:00Z");
    expect(mapPr("o/r", { ...pull, state: "closed" }, []).state).toBe("closed");
    expect(mapPr("o/r", { ...pull, milestone: null }, []).milestone).toBeNull();
  });
});

describe("reduceReviews", () => {
  it("keeps the latest state per reviewer; comments don't override; dismissed clears", () => {
    const r = reduceReviews([
      review("a", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
      review("a", "APPROVED", "2026-01-02T00:00:00Z"),
      review("a", "COMMENTED", "2026-01-03T00:00:00Z"),
      review("b", "COMMENTED", "2026-01-01T00:00:00Z"),
      review("c", "APPROVED", "2026-01-01T00:00:00Z"),
      review("c", "DISMISSED", "2026-01-02T00:00:00Z"),
      review("d", "PENDING", "2026-01-02T00:00:00Z"),
    ]);
    expect([...r.values()]).toEqual([
      { login: "a", state: "approved" },
      { login: "b", state: "commented" },
    ]);
  });
  it("sorts by submission time, not array order", () => {
    const r = reduceReviews([review("a", "APPROVED", "2026-01-02T00:00:00Z"), review("a", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z")]);
    expect(r.get("a")?.state).toBe("approved");
  });
  it("a dismissed reviewer still requested is pending", () => {
    const o = mapPr("o/r", pull, [review("carol", "APPROVED", "2026-01-01T00:00:00Z"), review("carol", "DISMISSED", "2026-01-02T00:00:00Z")]);
    expect(o.reviewers).toContainEqual({ login: "carol", state: "pending" });
  });
});

describe("mapRepoPrItem", () => {
  it("maps list fields with requested reviewers only", () => {
    expect(mapRepoPrItem("o/r", { ...pull, draft: true })).toEqual({
      repo: "o/r", number: 7, title: "Add thing", state: "draft", author: "alice",
      reviewers: ["carol", "dave"], assignees: ["bob"], updated_at: "2026-01-01T00:00:00Z", url: "https://github.com/O/R/pull/7",
    });
  });
});

describe("classifyFailure", () => {
  const c = (status: number | null, headers: Record<string, string> = {}, extra: object = {}) =>
    classifyFailure({ status, headers: h(headers), now: NOW, secrets: [TOKEN], ...extra });
  it("5xx and network errors are github_down", () => {
    expect(c(503).reason).toBe("github_down");
    expect(c(500).reason).toBe("github_down");
    expect(c(null, {}, { networkMessage: "ECONNREFUSED" })).toMatchObject({ reason: "github_down", status: null, message: "ECONNREFUSED" });
  });
  it("aborts are timeout", () => {
    expect(c(null, {}, { timedOut: true }).reason).toBe("timeout");
  });
  it("401 is bad_token", () => expect(c(401).reason).toBe("bad_token"));
  it("403/404 without rate-limit headers are no_access", () => {
    expect(c(403, { "x-ratelimit-remaining": "42" }).reason).toBe("no_access");
    expect(c(404).reason).toBe("no_access");
    expect(c(422).reason).toBe("no_access");
  });
  it("unexpected non-error statuses are github_down", () => expect(c(302).reason).toBe("github_down"));
  it("rate limit: reset header (epoch seconds)", () => {
    const e = c(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767225600" });
    expect(e).toMatchObject({ reason: "rate_limited", retry_after: "2026-01-01T00:00:00.000Z" });
    expect(c(429, { "x-ratelimit-reset": "1767229200" }).retry_after).toBe("2026-01-01T01:00:00.000Z");
  });
  it("rate limit: retry-after seconds", () => {
    expect(c(403, { "retry-after": "60" })).toMatchObject({ reason: "rate_limited", retry_after: "2026-01-01T00:01:00.000Z" });
    expect(c(429, { "retry-after": "30", "x-ratelimit-reset": "1767229200" }).retry_after).toBe("2026-01-01T00:00:30.000Z");
  });
  it("429 with no headers is rate_limited with no retry_after", () => {
    expect(c(429)).toMatchObject({ reason: "rate_limited", retry_after: null });
  });
  it("captures GitHub's message and request id", () => {
    expect(c(404, { "x-github-request-id": "ABCD:1" }, { body: JSON.stringify({ message: "Not Found" }) })).toMatchObject({
      message: "Not Found", request_id: "ABCD:1", status: 404,
    });
  });
});

describe("redact", () => {
  it("replaces secrets and clips", () => {
    expect(redact(`x ${TOKEN} y ${SECRET} ${TOKEN}`, [TOKEN, SECRET, undefined])).toBe("x [redacted] y [redacted] [redacted]");
    expect(redact("a".repeat(1000), []).length).toBeLessThan(400);
  });
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fakeFetch = (handler: Handler) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { f, calls };
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const opts = (f: typeof fetch) => ({ fetch: f, token: TOKEN, webhookSecret: SECRET, baseUrl: "http://gh.test/", now: () => NOW });

describe("fetchPr", () => {
  it("makes both calls with the right headers and maps the result", async () => {
    const { f, calls } = fakeFetch((url) => (url.includes("/reviews") ? json([review("carol", "APPROVED", "2026-01-01T00:00:00Z")]) : json(pull)));
    const r = await fetchPr("o/r", 7, opts(f));
    expect(r.ok && r.data.reviewers.find((x) => x.login === "carol")?.state).toBe("approved");
    expect(calls.map((c) => c.url).sort()).toEqual([
      "http://gh.test/repos/o/r/pulls/7",
      "http://gh.test/repos/o/r/pulls/7/reviews?per_page=100",
    ]);
    const hd = calls[0].init.headers as Record<string, string>;
    expect(hd.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(hd.Accept).toBe("application/vnd.github+json");
    expect(hd["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
  it("is all-or-nothing", async () => {
    for (const failing of ["reviews", "pull"]) {
      const { f } = fakeFetch((url) => {
        const isReviews = url.includes("/reviews");
        if (isReviews === (failing === "reviews")) return json({ message: "boom" }, 503, { "x-github-request-id": "R1" });
        return isReviews ? json([]) : json(pull);
      });
      const r = await fetchPr("o/r", 7, opts(f));
      expect(r).toMatchObject({ ok: false, error: { reason: "github_down", status: 503, message: "boom", request_id: "R1" } });
    }
  });
  it("times out a slow call", async () => {
    const { f } = fakeFetch(
      (url, init) =>
        new Promise<Response>((resolve, reject) => {
          if (url.includes("/reviews")) return resolve(json([]));
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const r = await fetchPr("o/r", 7, { ...opts(f), timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: { reason: "timeout", status: null } });
  });
  it("a network error is github_down", async () => {
    const { f } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchPr("o/r", 7, opts(f))).toMatchObject({ ok: false, error: { reason: "github_down" } });
  });
  it("redacts the token and webhook secret from errors", async () => {
    const { f } = fakeFetch(() => json({ message: `Bad credentials for ${TOKEN} and ${SECRET}` }, 401));
    const r = await fetchPr("o/r", 7, opts(f));
    expect(r).toMatchObject({ ok: false, error: { reason: "bad_token" } });
    const s = JSON.stringify(r);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain(SECRET);
    expect(s).toContain("[redacted]");
  });
  it("redacts a token in a network error", async () => {
    const { f } = fakeFetch(() => {
      throw new Error(`connect failed with ${TOKEN}`);
    });
    expect(JSON.stringify(await fetchPr("o/r", 7, opts(f)))).not.toContain(TOKEN);
  });
  it("a missing token is bad_token and makes no call", async () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const { f, calls } = fakeFetch(() => json(pull));
      const r = await fetchPr("o/r", 7, { fetch: f, baseUrl: "http://gh.test", now: () => NOW });
      expect(r).toMatchObject({ ok: false, error: { reason: "bad_token", status: null } });
      expect(calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    }
  });
  it("a rate limit carries retry_after", async () => {
    const { f } = fakeFetch(() => json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767225600" }));
    expect(await fetchPr("o/r", 7, opts(f))).toMatchObject({ ok: false, error: { reason: "rate_limited", retry_after: "2026-01-01T00:00:00.000Z" } });
  });
});

describe("fetchOpenPrs", () => {
  it("makes one call and maps items", async () => {
    const { f, calls } = fakeFetch(() => json([pull]));
    const r = await fetchOpenPrs("o/r", opts(f));
    expect(calls.map((c) => c.url)).toEqual(["http://gh.test/repos/o/r/pulls?state=open&per_page=100"]);
    expect(r.ok && r.data[0]).toMatchObject({ number: 7, reviewers: ["carol", "dave"] });
  });
  it("returns classified errors", async () => {
    const { f } = fakeFetch(() => json({ message: "Not Found" }, 404));
    expect(await fetchOpenPrs("o/r", opts(f))).toMatchObject({ ok: false, error: { reason: "no_access" } });
  });
});
