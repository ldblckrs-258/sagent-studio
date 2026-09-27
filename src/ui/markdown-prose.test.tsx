import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownProse } from "./markdown-prose";

describe("MarkdownProse", () => {
  it("renders a heading, a list, and a fenced code block", () => {
    const html = renderToStaticMarkup(
      <MarkdownProse>
        {"# Findings\n\n- first\n- second\n\n```js\nconst x = 1\n```"}
      </MarkdownProse>,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Findings");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("first");
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1");
  });

  it("escapes raw HTML instead of injecting it", () => {
    const html = renderToStaticMarkup(
      <MarkdownProse>{'<script>alert("x")</script> <b>bold</b>'}</MarkdownProse>,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("marks links as safe to follow", () => {
    const html = renderToStaticMarkup(
      <MarkdownProse>{"[example](https://example.com)"}</MarkdownProse>,
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer"');
  });
});
