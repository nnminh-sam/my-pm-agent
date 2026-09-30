import { describe, expect, it } from "vitest";
import type { PrOverview } from "./overview";
import { prCardView, prChip, prUrl, reviewOutcome } from "./pr-view";

const now = new Date("2026-09-29T12:00:00Z");
export const overview = (over: Partial<PrOverview> = {}): PrOverview => ({
  repo: "me/app",
  number: 123,
  title: "Add thing",
  body: "body",
  state: "open",
  merged_at: null,
  milestone: "v1",
  reviewers: [],
  assignees: ["alice"],
  author: "bob",
  base: "main",
  head: "feat",
  updated_at: "2026-09-29T09:00:00.000Z",
  url: "https://evil.example/phish",
  ...over,
});
const synced = { sync: "synced", fetched_at: "2026-09-29T11:58:00Z" } as const;
const chip = (o: PrOverview | null, sync: { sync: "synced" | "out_of_sync" | "never"; fetched_at: string | null } = synced) =>
  prChip({ ref: "me/app#123", overview: o, sync }, now);

describe("prUrl", () => {
  it("is built from the normalized ref", () => {
    expect(prUrl("me/app#123")).toBe("https://github.com/me/app/pull/123");
    expect(prUrl("javascript:alert(1)")).toBeNull();
    expect(prUrl("me/app#0")).toBeNull();
  });
});

describe("prChip", () => {
  it("reads every state", () => {
    expect(chip(overview()).text).toBe("PR #123 · open");
    expect(chip(overview({ state: "draft" })).text).toBe("PR #123 · draft");
    expect(chip(overview({ state: "closed" })).text).toBe("PR #123 · closed");
    expect(chip(overview({ state: "merged", merged_at: "2026-09-29T10:00:00Z" }))).toMatchObject({ text: "PR #123 · merged", tone: "accent" });
  });

  it("shows approved and changes requested for an open PR", () => {
    const approved = overview({ reviewers: [{ login: "c", state: "approved" }, { login: "d", state: "pending" }] });
    expect(chip(approved)).toMatchObject({ text: "PR #123 · approved", tone: "ok" });
    const changes = overview({ reviewers: [{ login: "c", state: "approved" }, { login: "d", state: "changes_requested" }] });
    expect(chip(changes)).toMatchObject({ text: "PR #123 · changes requested", tone: "danger" });
    expect(reviewOutcome([{ login: "c", state: "commented" }])).toBeNull();
  });

  it("a merged PR reads merged even with approvals", () => {
    expect(chip(overview({ state: "merged", reviewers: [{ login: "c", state: "approved" }] })).text).toBe("PR #123 · merged");
  });

  it("out of sync keeps the old data, flags it and says when", () => {
    const c = chip(overview(), { sync: "out_of_sync", fetched_at: "2026-09-29T11:46:00Z" });
    expect(c).toMatchObject({ text: "PR #123 · open", outOfSync: true });
    expect(c.title).toContain("Out of sync, last synced 14m ago");
  });

  it("never synced has no data but keeps the link", () => {
    const c = chip(null, { sync: "never", fetched_at: null });
    expect(c).toMatchObject({ text: "PR #123 · not synced", outOfSync: false, href: "https://github.com/me/app/pull/123" });
    expect(c.title).toContain("Never synced");
  });

  it("never links to the snapshot's own url", () => {
    expect(chip(overview()).href).toBe("https://github.com/me/app/pull/123");
  });
});

describe("prCardView", () => {
  it("carries the overview fields", () => {
    const v = prCardView(
      overview({ state: "merged", merged_at: "2026-09-29T10:05:00Z", reviewers: [{ login: "c", state: "changes_requested" }] }),
      "me/app#123",
    );
    expect(v).toMatchObject({
      state: "merged",
      mergedAt: "2026-09-29 10:05 UTC",
      milestone: "v1",
      assignees: ["alice"],
      author: "bob",
      branches: "main ← feat",
      updatedAt: "2026-09-29 09:00 UTC",
      href: "https://github.com/me/app/pull/123",
      reviewers: [{ login: "c", text: "changes requested", tone: "danger" }],
    });
  });

  it("has no merged time for an open PR", () => {
    expect(prCardView(overview({ merged_at: "2026-09-29T10:05:00Z" }), "me/app#123").mergedAt).toBeNull();
  });
});
