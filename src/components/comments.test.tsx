import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskComment } from "@/lib/types";

vi.mock("@/app/actions", () => ({ addCommentAction: vi.fn(), deleteCommentAction: vi.fn() }));
const { Comments, CommentText } = await import("./comments");

const comment = (body: string, over: Partial<TaskComment> = {}): TaskComment => ({
  id: "c1",
  task_id: "t1",
  author: "you",
  created_at: "2026-09-29T09:05:00.000Z",
  body,
  ...over,
});

describe("Comments", () => {
  it("keeps line breaks as <br/>", () => {
    const html = renderToStaticMarkup(<CommentText body={"one\ntwo\r\nthree"} />);
    expect(html).toContain("one</span><span><br/>two</span><span><br/>three");
  });

  it("renders <script>, markdown and links as escaped plain text", () => {
    const html = renderToStaticMarkup(
      <Comments taskId="t1" comments={[comment("<script>alert(1)</script>\n**bold** https://example.com [x](http://a.b) #12")]} />,
    );
    // React's own form-replay <script> sits after the form; the comment list is what matters.
    const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    expect(list).not.toContain("<script");
    expect(list).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(list).toContain("**bold** https://example.com [x](http://a.b) #12");
    expect(list).not.toContain("<strong>");
    expect(list).not.toContain("<a ");
  });

  it("shows author, time, count, a Delete button and the add form", () => {
    const html = renderToStaticMarkup(<Comments taskId="t1" comments={[comment("hi"), comment("yo", { id: "c2", author: "agent" })]} />);
    expect(html).toContain("(2)");
    expect(html).toContain("agent");
    expect(html).toContain("2026-09-29 09:05 UTC");
    expect(html).toContain("Delete");
    expect(html).toContain('name="body"');
    expect(html).toContain('name="id" value="t1"');
    // Idle: the shared pending buttons are enabled and not busy (PF-1).
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("data-spinner");
  });

  it("has no comment list when empty", () => {
    expect(renderToStaticMarkup(<Comments taskId="t1" comments={[]} />)).not.toContain("<ul");
  });
});
