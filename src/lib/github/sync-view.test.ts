import { describe, expect, it } from "vitest";
import { syncStatus } from "./sync";
import { badgeView, formatWhen, parseSyncKey, reasonText, relativeTime, retryFeedback, type BadgeSync } from "./sync-view";

const now = new Date("2026-09-29T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const future = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();

const failed = (reason: BadgeSync["reason"], extra: Partial<BadgeSync> = {}): BadgeSync => ({
  sync: "out_of_sync",
  fetched_at: ago(14),
  last_attempt_at: ago(1),
  reason,
  error: { reason: reason!, status: 503, message: "Service Unavailable", request_id: "AB12:34" },
  retry_after: null,
  ...extra,
});

describe("relativeTime", () => {
  it("formats minutes, hours, days", () => {
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(2), now)).toBe("2m ago");
    expect(relativeTime(ago(180), now)).toBe("3h ago");
    expect(relativeTime(ago(60 * 24 * 4), now)).toBe("4d ago");
    expect(relativeTime(future(5), now)).toBe("just now");
  });
});

describe("badgeView", () => {
  it("synced is quiet with no details", () => {
    const v = badgeView({ ...syncStatus(null), sync: "synced", fetched_at: ago(2) }, now);
    expect(v).toMatchObject({ tone: "quiet", label: "synced 2m ago", hasDetails: false, reason: null });
  });

  it("out of sync is amber with reason, status, message, request id", () => {
    const v = badgeView(failed("github_down"), now);
    expect(v).toMatchObject({
      tone: "warn",
      label: "Out of sync · last synced 14m ago",
      reason: "GitHub is unavailable",
      status: 503,
      message: "Service Unavailable",
      requestId: "AB12:34",
      canRetry: true,
      retryBlocked: null,
    });
    expect(v.lastAttempt).toBe("2026-09-29 11:59 UTC");
  });

  it("never synced is red", () => {
    const v = badgeView(failed("no_access", { sync: "never", fetched_at: null }), now);
    expect(v).toMatchObject({ tone: "danger", label: "Never synced", reason: "Repo renamed, deleted or not granted to the token" });
  });

  it("words every reason", () => {
    expect(reasonText(failed("timeout"))).toBe("GitHub didn't respond in time");
    expect(reasonText(failed("bad_token"))).toBe("Token invalid or expired");
    expect(reasonText(failed("rate_limited", { retry_after: "2026-09-29T12:30:00Z" }))).toBe("Rate-limited until 2026-09-29 12:30 UTC");
  });

  it("blocks Retry now until retry_after", () => {
    const limited = failed("rate_limited", { retry_after: future(10) });
    expect(badgeView(limited, now)).toMatchObject({ canRetry: false, retryBlocked: expect.stringContaining("Rate-limited until") });
    expect(badgeView(limited, new Date(now.getTime() + 11 * 60_000)).canRetry).toBe(true);
  });

  it("read-time refusals show their reason and cannot retry", () => {
    const base = { ...syncStatus(null) };
    const notLinked = badgeView({ ...base, refusal: "not_linked" }, now);
    expect(notLinked).toMatchObject({ tone: "danger", reason: "Repo isn't linked to this project", canRetry: false });
  });
});

describe("parseSyncKey", () => {
  it("accepts pr: and repo: keys only", () => {
    expect(parseSyncKey("pr:acme/app#12")).toEqual({ kind: "pr", target: "acme/app#12" });
    expect(parseSyncKey("repo:acme/app")).toEqual({ kind: "repo", target: "acme/app" });
    for (const bad of ["acme/app#1", "pr:acme/app", "repo:acme", "pr:acme/app#0", "", null, undefined, 5, {}, ["repo:a/b"]])
      expect(parseSyncKey(bad)).toBeNull();
  });
});

describe("formatWhen", () => {
  it("is fixed UTC", () => expect(formatWhen("2026-09-29T09:05:59Z")).toBe("2026-09-29 09:05 UTC"));
});

describe("retryFeedback", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const base = { sync: "out_of_sync", fetched_at: "2026-09-29T11:00:00Z", last_attempt_at: null, reason: "github_down", error: null, retry_after: null } as const;
  it("is silent when the retry worked", () => expect(retryFeedback({ ...base, sync: "synced", reason: null }, now)).toBeNull());
  it("says still unavailable with the reason", () =>
    expect(retryFeedback(base, now)).toBe("Still unavailable: GitHub is unavailable"));
  it("says rate-limited until the reset while retry_after is in the future", () =>
    expect(retryFeedback({ ...base, reason: "rate_limited", retry_after: "2026-09-29T12:10:00Z" }, now)).toBe("Rate-limited until 2026-09-29 12:10 UTC"));
});
