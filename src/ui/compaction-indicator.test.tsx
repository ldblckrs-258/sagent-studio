import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompactionIndicatorRow } from "./compaction-indicator";

describe("CompactionIndicatorRow", () => {
  it("names what is happening and animates while it runs", () => {
    const markup = renderToStaticMarkup(<CompactionIndicatorRow />);
    expect(markup).toContain("Compacting the conversation into a summary");
    expect(markup).toContain("shimmer");
    expect(markup).toContain('role="status"');
  });
});
