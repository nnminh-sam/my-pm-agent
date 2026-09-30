import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RepoPrItem } from "@/lib/github/overview";
import type { ProjectPrs } from "@/lib/github/project-prs";
import { syncStatus } from "@/lib/github/sync";
import type { BadgeSync } from "@/lib/github/sync-view";

vi.mock("@/app/actions", () => ({ retryGithubSync: vi.fn(), addProjectRepoAction: vi.fn(), removeProjectRepoAction: vi.fn() }));
const { RepoPrs } = await import("./repo-prs");
const { RepoLinks } = await import("./repo-links");

const now = "2026-09-29T12:00:00.000Z";
const synced: BadgeSync = { ...syncStatus(null), sync: "synced", fetched_at: "2026-09-29T11:58:00.000Z" };
const item = (over: Partial<RepoPrItem> = {}): RepoPrItem => ({
  repo: "me/app",
  number: 7,
  title: "Add thing",
  state: "open",
  author: "alice",
  reviewers: ["bob"],
  assignees: ["carol"],
  updated_at: "2026-09-29T09:00:00.000Z",
  url: "https://evil.example/7",
  ...over,
});
const section = (repo: string, data: RepoPrItem[] | null, sync = synced) => ({ repo, view: { key: `repo:${repo}`, data, sync } });
const html = (prs: ProjectPrs | null) => renderToStaticMarkup(<RepoPrs prs={prs} now={now} />);

describe("RepoPrs", () => {
  it("renders nothing without a section", () => expect(html(null)).toBe(""));

  it("shows title, author, reviewers, assignees and a link built from the repo and number", () => {
    const out = html({ labeled: false, sections: [section("me/app", [item({ state: "draft" })])] });
    for (const text of ["Add thing", "#7", "by alice", "reviewers: bob", "assignees: carol", "draft", "synced 2m ago", "Open pull requests"])
      expect(out).toContain(text);
    expect(out).toContain('href="https://github.com/me/app/pull/7"');
    expect(out).not.toContain("evil.example");
  });

  it("labels each list by repo when there are several, and not when there is one", () => {
    const many = html({ labeled: true, sections: [section("me/one", [item()]), section("me/two", [])] });
    expect(many).toContain("me/one");
    expect(many).toContain("me/two");
    expect(many).toContain("No open pull requests.");
    expect(many.match(/synced 2m ago/g)).toHaveLength(2);
    expect(html({ labeled: false, sections: [section("me/one", [item()])] })).not.toContain(">me/one<");
  });

  it("a never-synced repo shows its badge and no rows", () => {
    const out = html({
      labeled: false,
      sections: [section("me/app", null, { ...syncStatus(null), sync: "never", reason: "github_down" })],
    });
    expect(out).toContain("Never synced");
    expect(out).toContain("Nothing fetched from GitHub yet.");
  });

  it("escapes markup in titles, authors and people", () => {
    const out = html({
      labeled: false,
      sections: [section("me/app", [item({ title: "<script>alert(1)</script>", author: "<b>x</b>", reviewers: ["<i>r</i>"], assignees: ["<img src=x onerror=1>"] })])],
    });
    expect(out).not.toMatch(/<(script|b|i|img)[ >]/);
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("RepoLinks", () => {
  const list = (repos: string[]) => renderToStaticMarkup(<RepoLinks project="p1" repos={repos} />);
  it("lists each repo with a remove button and an add input", () => {
    const out = list(["github.com/me/app", "gitlab.com/x/y"]);
    for (const text of ["github.com/me/app", "gitlab.com/x/y", 'aria-label="Remove github.com/me/app"', 'name="remote"', 'value="p1"']) expect(out).toContain(text);
  });
  it("says so when there are none", () => expect(list([])).toContain("No repositories linked."));
});
