import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { syncStatus } from "@/lib/github/sync";
import type { BadgeSync } from "@/lib/github/sync-view";

vi.mock("@/app/actions", () => ({ retryGithubSync: vi.fn() }));
const { SyncBadge } = await import("./sync-badge");

const now = "2026-09-29T12:00:00.000Z";
const ago = (min: number) => new Date(Date.parse(now) - min * 60_000).toISOString();
const render = (sync: BadgeSync, key: string | null = "pr:acme/app#1") =>
  renderToStaticMarkup(<SyncBadge sync={sync} syncKey={key} url="https://github.com/acme/app/pull/1" now={now} />);

const out = (message = "Bad Gateway", retry_after: string | null = null): BadgeSync => ({
  sync: "out_of_sync",
  fetched_at: ago(14),
  last_attempt_at: ago(1),
  reason: retry_after ? "rate_limited" : "github_down",
  error: { reason: retry_after ? "rate_limited" : "github_down", status: 502, message, request_id: "REQ-1" },
  retry_after,
});

describe("SyncBadge", () => {
  it("synced: quiet text, no details", () => {
    const html = render({ ...syncStatus(null), sync: "synced", fetched_at: ago(2) });
    expect(html).toContain("synced 2m ago");
    expect(html).not.toContain("<details");
  });

  it("out of sync: amber, details, Retry now, githubstatus link", () => {
    const html = render(out());
    expect(html).toContain("Out of sync · last synced 14m ago");
    expect(html).toContain("bg-warn-soft");
    expect(html).toContain("GitHub is unavailable");
    expect(html).toContain("REQ-1");
    expect(html).toContain("Retry now");
    expect(html).toContain("https://www.githubstatus.com");
  });

  it("rate limited: Retry now disabled with the reset time", () => {
    const html = render(out("rate limit", new Date(Date.parse(now) + 600_000).toISOString()));
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Rate-limited until 2026-09-29 12:10 UTC");
  });

  it("never synced: red, Open in GitHub", () => {
    const html = render({ ...out(), sync: "never", fetched_at: null });
    expect(html).toContain("Never synced");
    expect(html).toContain("bg-danger-soft");
    expect(html).toContain("Open in GitHub");
  });

  it("a refusal has no Retry now", () => {
    const html = render({ ...syncStatus(null), refusal: "company" });
    expect(html).toContain("Company projects don&#x27;t read GitHub");
    expect(html).not.toContain("Retry now");
  });

  it("escapes markup in GitHub's message", () => {
    const html = render(out("<script>alert(1)</script>"));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
