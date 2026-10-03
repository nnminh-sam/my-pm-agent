import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, PageSkeleton, PendingButton, Spinner, SubmitButton } from "./ui";

describe("Markdown", () => {
  it("does not turn raw HTML into live HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href=\"javascript:alert(1)\" onclick=\"x()\">x</a>\n\n**ok**"}</Markdown>,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[^>]*\son(error|click)\s*=/); // only ever escaped text
    expect(html).toContain("&lt;")
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain("<strong>ok</strong>");
  });

  it("neutralizes javascript: links written in markdown", () => {
    expect(renderToStaticMarkup(<Markdown>{"[x](javascript:alert(1))"}</Markdown>)).not.toMatch(/href="javascript:/);
  });
});

describe("Spinner", () => {
  it("is hidden from assistive technology and static under reduced motion (PF-1.5, PF-1.6)", () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("motion-reduce:animate-none");
  });
});

describe("PendingButton (PF-1.2, PF-1.5)", () => {
  it("pending: disabled, aria-busy, spinner and a visually hidden status", () => {
    const html = renderToStaticMarkup(
      <PendingButton pending pendingText="Deleting…">
        Delete
      </PendingButton>,
    );
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toMatch(/<button[^>]*aria-busy="true"/);
    expect(html).toContain("data-spinner");
    expect(html).toMatch(/<span role="status" class="sr-only">Deleting…<\/span>/);
  });

  it("idle: enabled, not busy, no spinner, empty status", () => {
    const html = renderToStaticMarkup(
      <PendingButton pending={false} pendingText="Deleting…">
        Delete
      </PendingButton>,
    );
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("data-spinner");
    expect(html).toContain('<span role="status" class="sr-only"></span>');
  });

  it("keeps a caller's disabled while idle", () => {
    const html = renderToStaticMarkup(
      <PendingButton pending={false} pendingText="Retrying…" disabled>
        Retry now
      </PendingButton>,
    );
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain("aria-busy");
  });
});

describe("SubmitButton (PF-1.1)", () => {
  it("is an idle submit button outside a pending form", () => {
    const html = renderToStaticMarkup(
      <form>
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
      </form>,
    );
    expect(html).toMatch(/<button type="submit"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain("data-spinner");
  });
});

describe("PageSkeleton (PF-2.4)", () => {
  it("is aria-busy with a visually hidden Loading… status", () => {
    const html = renderToStaticMarkup(<PageSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<span role="status" class="sr-only">Loading…</span>');
  });
});
