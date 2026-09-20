import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "../chat/types";
import { PlanPanel } from "./plan-panel";

/*
  The panel reads the live chat store, and a static server render resolves
  zustand's server snapshot (the store's initial state) rather than current
  state. The store is therefore stood in for here, which keeps the assertions
  focused on what this component owns: the disclosure, the meter, and the copy.
*/
const state = vi.hoisted(() => ({
  plan: undefined as PlanItem[] | undefined,
  running: false,
}));

vi.mock("../chat/store", () => ({
  useChatStore: (selector: (slice: unknown) => unknown) =>
    selector({
      activeThreadId: "t1",
      threads: { t1: { plan: state.plan } },
      runningThreads: state.running ? { t1: 1 } : {},
    }),
}));

const PLAN: PlanItem[] = [
  { id: "p1", text: "Read the failing test output", status: "completed" },
  { id: "p2", text: "Patch the parser", status: "in_progress" },
  { id: "p3", text: "Rerun the suite", status: "pending" },
];

function render(): string {
  return renderToStaticMarkup(<PlanPanel />);
}

function open(): void {
  vi.stubGlobal("sessionStorage", { getItem: () => "open", setItem: () => {} });
}

beforeEach(() => {
  state.plan = PLAN;
  state.running = false;
  vi.unstubAllGlobals();
});

describe("PlanPanel", () => {
  it("renders nothing at all when the thread carries no plan", () => {
    state.plan = undefined;
    expect(render()).toBe("");
    state.plan = [];
    expect(render()).toBe("");
  });

  it("starts collapsed and still reports the step in flight", () => {
    const html = render();

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1/3");
    expect(html).toContain("Patch the parser");
    expect(html).toContain("In progress: ");
    // The collapsed disclosure holds its rows back, so the queue stays out of sight.
    expect(html).not.toContain("Rerun the suite");
    expect(html).not.toContain("Read the failing test output");
  });

  it("opens to the full checklist when the session already asked it to", () => {
    open();
    const html = render();

    expect(html).toContain('aria-expanded="true"');
    for (const item of PLAN) expect(html).toContain(item.text);
    expect(html).toContain("Completed: ");
    expect(html).toContain("Pending: ");
  });

  it("carries status in the meter instead of a second column of labels", () => {
    const html = render();

    expect(html).toContain("bg-positive");
    expect(html).toContain("bg-caution");
    expect(html).toContain("1 of 3 steps completed");
    // Nothing to report, so nothing is drawn for that status.
    expect(html).not.toContain("bg-danger");
  });

  it("spins the step in flight only while the thread is actually running", () => {
    expect(render()).not.toContain("animate-spin");

    state.running = true;
    expect(render()).toContain("animate-spin");
  });

  it("keeps em-dashes out of the visible copy", () => {
    expect(render()).not.toContain("—");
    open();
    expect(render()).not.toContain("—");
  });
});
