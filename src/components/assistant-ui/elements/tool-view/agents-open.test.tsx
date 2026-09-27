// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAgentPanelStore } from "@/session/agent-panel-state";
import { ToolCallView } from "./registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function openTrigger(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="agent-open-panel"]');
}

const PART = {
  type: "tool-call" as const,
  toolCallId: "call-1",
  argsText: "{}",
  addResult: () => {},
  resume: () => {},
  respondToApproval: () => Promise.resolve(),
};

beforeEach(() => {
  useAgentPanelStore.getState().clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("delegated-run tool views", () => {
  it("opens a background run from the call header", () => {
    const view = mount(
      <ToolCallView
        {...PART}
        toolName="spawn_agent"
        args={{ prompt: "map the repo", background: true }}
        status={{ type: "complete" }}
        result={{
          ok: true,
          code: "ok",
          value: { status: "running", runId: "run-9", label: "scout" },
        }}
      />,
    );

    const open = openTrigger(view.container);
    expect(open).not.toBeNull();
    act(() => {
      open?.click();
    });

    expect(useAgentPanelStore.getState().selectedRunId).toBe("run-9");
    view.unmount();
  });

  it("opens an awaited run too, using the run id on its completed result", () => {
    const view = mount(
      <ToolCallView
        {...PART}
        toolName="spawn_agent"
        args={{ prompt: "answer inline" }}
        status={{ type: "complete" }}
        result={{
          ok: true,
          code: "ok",
          value: { status: "completed", runId: "run-7", result: "done" },
        }}
      />,
    );

    const open = openTrigger(view.container);
    expect(open).not.toBeNull();
    act(() => {
      open?.click();
    });
    expect(useAgentPanelStore.getState().selectedRunId).toBe("run-7");
    view.unmount();
  });

  it("offers no open action when the call carries no run id", () => {
    const view = mount(
      <ToolCallView
        {...PART}
        toolName="spawn_agent"
        args={{ prompt: "answer inline" }}
        status={{ type: "complete" }}
        result={{ ok: true, code: "ok", value: { status: "completed", result: "done" } }}
      />,
    );

    expect(openTrigger(view.container)).toBeNull();
    view.unmount();
  });
});
