import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextMeterRow } from "./context-meter";
import type { MeterView } from "./context-meter-view";

/*
  Only the row's markup is asserted here. The repository runs vitest with
  `environment: "node"`, so the numbers themselves are covered as pure
  functions in `context-meter-view.test.ts`.
*/

function view(overrides: Partial<MeterView> = {}): MeterView {
  return {
    visible: true,
    totalTokens: 1200,
    contextTokens: 800,
    maxContextTokens: 1000,
    usedPercent: 80,
    thresholdPercent: 80,
    overThreshold: false,
    estimated: false,
    tokensPerSecond: 25,
    rateEstimated: false,
    ...overrides,
  };
}

function render(overrides: Partial<MeterView> = {}, busy = false): string {
  return renderToStaticMarkup(
    <ContextMeterRow view={view(overrides)} busy={busy} onCompact={() => {}} />,
  );
}

describe("ContextMeterRow", () => {
  it("shows the billed total, the context against the cap, and the rate", () => {
    const markup = render();
    expect(markup).toContain("1.2k");
    expect(markup).toContain("800");
    expect(markup).toContain("1.0k");
    expect(markup).toContain("80%");
    expect(markup).toContain("25 tok/s");
  });

  it("calls the cumulative figure billed, not tokens", () => {
    // The two numbers are different kinds of quantity: the cumulative sum grows
    // with every turn because each turn re-sends the conversation, while the
    // context is the size of one request. Naming both "tokens" reads as though
    // they should agree.
    const markup = render();
    expect(markup).toContain("billed");
    expect(markup).not.toContain("> tokens");
    expect(markup).toContain("grows faster than the context");
  });

  it("explains what the context figure measures on hover", () => {
    expect(render()).toContain("Context the next request will send");
  });

  it("marks an estimated context figure and explains it on hover", () => {
    const markup = render({ estimated: true });
    expect(markup).toContain("~800");
    expect(markup).toContain("provider reported no token usage");
  });

  it("leaves a measured figure unmarked", () => {
    expect(render()).not.toContain("~");
  });

  it("draws the bar at the used share and the tick at the threshold", () => {
    const markup = render({ usedPercent: 42, thresholdPercent: 80 });
    expect(markup).toContain("width:42%");
    expect(markup).toContain("left:80%");
  });

  it("switches to the caution tone once the threshold is crossed", () => {
    expect(render({ overThreshold: false })).toContain("bg-accent");
    const crossed = render({ overThreshold: true });
    expect(crossed).toContain("bg-caution");
    expect(crossed).not.toContain("bg-accent");
  });

  it("offers Compact now, disabled while a run is in flight", () => {
    // Matched as an attribute, since the class list carries `disabled:` variants.
    expect(render({}, false)).not.toContain('disabled=""');
    expect(render({}, true)).toContain('disabled=""');
    expect(render()).toContain("Compact now");
  });

  it("renders an em dash rather than a zero when there is no rate yet", () => {
    const markup = render({ tokensPerSecond: undefined, rateEstimated: true });
    expect(markup).toContain("—");
    expect(markup).not.toContain("tok/s");
  });
});
