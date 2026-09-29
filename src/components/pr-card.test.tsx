import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { overview } from "@/lib/github/pr-view.test";
import { syncStatus } from "@/lib/github/sync";
import type { BadgeSync } from "@/lib/github/sync-view";
import type { PrEntry } from "@/lib/mcp/task-github";

vi.mock("@/app/actions", () => ({ retryGithubSync: vi.fn() }));
const { PrCard } = await import("./pr-card");
const { PrChips } = await import("./pr-chips");

const now = "2026-09-29T12:00:00.000Z";
const synced: BadgeSync = { ...syncStatus(null), sync: "synced", fetched_at: "2026-09-29T11:58:00.000Z" };
const out: BadgeSync = {
  ...syncStatus(null),
  sync: "out_of_sync",
  fetched_at: "2026-09-29T11:46:00.000Z",
  reason: "github_down",
  error: { reason: "github_down", status: 502, message: "Bad Gateway", request_id: "R1" },
};
const card = (data: ReturnType<typeof overview> | null, sync: BadgeSync = synced) =>
  renderToStaticMarkup(<PrCard prRef="me/app#123" data={data} sync={sync} syncKey="pr:me/app#123" now={now} />);

describe("PrCard", () => {
  it("shows the overview and an Open in GitHub link built from the ref", () => {
    const html = card(overview({ reviewers: [{ login: "carol", state: "approved" }] }));
    for (const text of ["Add thing", "open", "v1", "alice", "bob", "main ← feat", "carol", "approved", "synced 2m ago"])
      expect(html).toContain(text);
    expect(html).toContain('href="https://github.com/me/app/pull/123"');
    expect(html).not.toContain("evil.example");
  });

  it("shows a merged PR as merged with its time", () => {
    const html = card(overview({ state: "merged", merged_at: "2026-09-29T10:05:00.000Z" }));
    expect(html).toContain("merged · 2026-09-29 10:05 UTC");
  });

  it("every state renders", () => {
    for (const state of ["open", "draft", "merged", "closed"] as const) expect(card(overview({ state }))).toContain(state);
  });

  it("out of sync still shows the old data with the amber badge", () => {
    const html = card(overview({ title: "Old title" }), out);
    expect(html).toContain("Old title");
    expect(html).toContain("Out of sync · last synced 14m ago");
  });

  it("never synced shows the reason and the Open in GitHub link, no overview", () => {
    const html = card(null, { ...out, sync: "never", fetched_at: null });
    expect(html).toContain("Never synced");
    expect(html).toContain("No overview yet.");
    expect(html).toContain('href="https://github.com/me/app/pull/123"');
    expect(html).toContain("Open in GitHub");
  });

  it("renders <script> and raw HTML in the body as inert text", () => {
    const html = card(overview({ body: "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nhi **there**" }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[^>]*\sonerror\s*=/); // only ever escaped text
    expect(html).toContain("&lt;img")
    expect(html).toContain("<strong>there</strong>");
  });

  it("escapes markup in the title, reviewer and branch names", () => {
    const html = card(overview({ title: "<script>t</script>", head: "<b>x</b>", reviewers: [{ login: "<i>r</i>", state: "pending" }] }));
    expect(html).not.toMatch(/<(script|b|i)>/);
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("PrChips", () => {
  const entry = (state: "synced" | "out_of_sync" | "never", data: ReturnType<typeof overview> | null): PrEntry => ({
    ref: "me/app#123",
    url: "https://evil.example/x",
    overview: data,
    sync: { sync: state, fetched_at: state === "never" ? null : "2026-09-29T11:00:00.000Z", reason: null },
  });
  const chips = (e: PrEntry[]) => renderToStaticMarkup(<PrChips entries={e} now={new Date(now)} />);

  it("renders the state text and links to the ref's PR, never the entry url", () => {
    const html = chips([entry("synced", overview({ reviewers: [{ login: "c", state: "approved" }] }))]);
    expect(html).toContain("PR #123 · approved");
    expect(html).toContain('href="https://github.com/me/app/pull/123"');
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("bg-warn");
  });

  it("shows merged", () => expect(chips([entry("synced", overview({ state: "merged" }))])).toContain("PR #123 · merged"));

  it("marks an out-of-sync chip with an amber dot", () => {
    const html = chips([entry("out_of_sync", overview())]);
    expect(html).toContain("bg-warn");
    expect(html).toContain("out of sync");
  });

  it("a never-synced chip still links", () => {
    const html = chips([entry("never", null)]);
    expect(html).toContain("PR #123 · not synced");
    expect(html).toContain('href="https://github.com/me/app/pull/123"');
  });

  it("renders nothing without PRs", () => expect(chips([])).toBe(""));
});
