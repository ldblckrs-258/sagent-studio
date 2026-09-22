import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IngestProgressRow } from "./ingest-progress";

describe("IngestProgressRow", () => {
  it("shows a determinate bar with the phase, count, and percent width", () => {
    const markup = renderToStaticMarkup(
      <IngestProgressRow progress={{ phase: "embedding", done: 32, total: 83 }} />,
    );
    expect(markup).toContain("Embedding");
    expect(markup).toContain("32");
    expect(markup).toContain("/83");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="32"');
    expect(markup).toContain('aria-valuemax="83"');
    expect(markup).toContain("width:39%");
  });

  it("renders an indeterminate sweep for a single-step phase", () => {
    const markup = renderToStaticMarkup(
      <IngestProgressRow progress={{ phase: "extracting", done: 0, total: 1 }} />,
    );
    expect(markup).toContain("Extracting text");
    expect(markup).toContain("ingest-sweep");
    expect(markup).not.toContain("aria-valuenow");
  });
});
