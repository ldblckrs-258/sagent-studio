// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "sagent-bridge/protocol";
import type { BridgeView, OutputListener } from "../../terminal/types";

const controls = vi.hoisted(() => {
  const state = {
    view: { status: "unpaired", capabilities: [], sessions: [], paired: false } as unknown as BridgeView,
    listeners: new Set<() => void>(),
  };
  return {
    state,
    view: () => state.view,
    onChange: (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    sessions: () => state.view.sessions,
    pair: vi.fn(async () => true),
    retry: vi.fn(),
    forget: vi.fn(async () => {}),
    kill: vi.fn(async () => ({ killed: true })),
    create: vi.fn(async () => ({ id: "new" })),
    subscribe: vi.fn(() => () => {}),
  };
});

vi.mock("../../session/session-context", () => ({
  useSession: () => ({ terminal: controls }),
}));

import { TerminalPanel } from "./terminal";
import { attachSession, DROPPED_NOTICE } from "../terminal/use-terminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string, owner: SessionInfo["owner"], overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    kind: "pty",
    shell: "model",
    command: "pnpm dev",
    cwd: ".",
    owner,
    running: true,
    startedAt: Date.now(),
    nextOffset: 0,
    ...overrides,
  };
}

function setView(view: Partial<BridgeView>) {
  controls.state.view = { status: "ready", capabilities: [], sessions: [], paired: true, ...view } as BridgeView;
  for (const listener of controls.state.listeners) listener();
}

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.includes(label) || entry.getAttribute("aria-label") === label,
  );
}

beforeEach(() => {
  controls.pair.mockClear();
  controls.kill.mockClear();
  controls.state.view = { status: "unpaired", capabilities: [], sessions: [], paired: false } as unknown as BridgeView;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TerminalPanel status", () => {
  it.each([
    ["unpaired", undefined, "not paired"],
    ["connecting", "Reconnecting to the bridge…", "Reconnecting to the bridge…"],
    ["needs-auth", "Pairing expired — press Enter in the bridge terminal and open the new link.", "Pairing expired"],
    ["error", "Bridge not running: npx sagent-bridge@0.1.0 --root <your project folder>", "Bridge not running"],
  ] as const)("shows %s with its reason", async (status, reason, expected) => {
    controls.state.view = { status, reason, capabilities: [], sessions: [], paired: status !== "unpaired" } as BridgeView;
    const view = await mount(<TerminalPanel />);
    const line = view.container.querySelector('[data-slot="terminal-status"]');
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.textContent).toContain(expected);
    view.unmount();
  });

  it("shows the root and bridge version when connected", async () => {
    setView({ rootName: "sagent-studio", bridgeVersion: "0.1.0" });
    const view = await mount(<TerminalPanel />);
    expect(view.container.textContent).toContain("Connected · root: sagent-studio · bridge 0.1.0");
    view.unmount();
  });
});

describe("manual pairing", () => {
  it("refuses a non-loopback address before any connection is tried", async () => {
    const view = await mount(<TerminalPanel />);
    await act(async () => button(view.container, "Pair manually")?.click());
    const url = view.container.querySelector<HTMLInputElement>('input[name="bridge-url"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(url, "ws://evil.example:7717");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(view.container, "Connect")?.click());
    expect(controls.pair).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("127.0.0.1");
    view.unmount();
  });

  it("pairs with a valid address and token", async () => {
    const view = await mount(<TerminalPanel />);
    await act(async () => button(view.container, "Pair manually")?.click());
    await act(async () => button(view.container, "Reveal API key")?.click());
    const token = view.container.querySelector<HTMLInputElement>('input[name="bridge-token"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(token, "tok_0123456789abcdef");
      token.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(view.container, "Connect")?.click());
    expect(controls.pair).toHaveBeenCalledWith({ url: "ws://127.0.0.1:7717", token: "tok_0123456789abcdef" });
    view.unmount();
  });
});

describe("session list", () => {
  it("labels who started each session and groups finished ones", async () => {
    setView({
      sessions: [
        session("a", { source: "user" }, { command: null }),
        session("b", { source: "model", threadId: "t1" }),
        session("c", { source: "agent", threadId: "t1", runId: "run-12345678x" }, { running: false, exitCode: 0 }),
      ],
    });
    const view = await mount(<TerminalPanel />);
    const rows = [...view.container.querySelectorAll('[role="option"]')].map((row) => row.textContent);
    expect(rows[0]).toContain("shell");
    expect(rows[0]).toContain("you");
    expect(rows[1]).toContain("model");
    expect(view.container.querySelector('[data-slot="finished-sessions"]')?.textContent).toContain("agent: run-1234");
    expect(view.container.querySelector('[data-slot="finished-sessions"]')?.textContent).toContain("exit 0");
    view.unmount();
  });

  it("asks before killing the user's own running shell but not a model session", async () => {
    setView({
      sessions: [session("a", { source: "user" }, { command: null }), session("b", { source: "model", threadId: "t1" })],
    });
    const view = await mount(<TerminalPanel />);
    await act(async () => button(view.container, "Kill pnpm dev")?.click());
    expect(controls.kill).toHaveBeenCalledWith("b");
    await act(async () => button(view.container, "Kill shell")?.click());
    expect(controls.kill).toHaveBeenCalledTimes(1);
    await act(async () => button(view.container, "Kill")?.click());
    expect(controls.kill).toHaveBeenLastCalledWith("a");
    view.unmount();
  });
});

describe("attachSession", () => {
  function fakePort() {
    let listener: OutputListener = () => {};
    const port = {
      subscribe: vi.fn((_id: string, fn: OutputListener, since?: number) => {
        listener = fn;
        expect(since).toBe(0);
        return () => {};
      }),
    };
    return { port, emit: (text: string, offset: number) => listener(new TextEncoder().encode(text), offset) };
  }

  it("replays from the start of the buffer", () => {
    const { port, emit } = fakePort();
    const written: (string | Uint8Array)[] = [];
    attachSession(port as never, "s1", (data) => written.push(data));
    emit("hello", 0);
    expect(written.map((w) => (typeof w === "string" ? w : new TextDecoder().decode(w)))).toEqual(["hello"]);
  });

  it("marks output that the bridge ring buffer already dropped", () => {
    const { port, emit } = fakePort();
    const written: (string | Uint8Array)[] = [];
    attachSession(port as never, "s1", (data) => written.push(data));
    emit("tail", 5000);
    emit("more", 5004);
    expect(written[0]).toBe(DROPPED_NOTICE);
    expect(written).toHaveLength(3);
  });
});
