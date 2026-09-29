import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./ui";

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
