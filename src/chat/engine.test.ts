import type { LanguageModel, UIMessage } from "ai";
import { APICallError, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillStore } from "../skills/registry";
import { SkillRegistry } from "../skills/registry";
import { createPlanToolProvider } from "../tools/builtin/plan";
import { createSkillToolProvider } from "../tools/builtin/skills";
import { ToolRegistry } from "../tools/registry";
import type { ToolProvider, WorkspaceApi } from "../tools/types";
import type { Settings } from "../vault/settings";
import { createFakeWorkspace } from "../workspace/fake-handle";
import { createWorkspaceFs } from "../workspace/fs";
import type { WorkspaceFs } from "../workspace/fs";
import { WorkspacePermissionError } from "../workspace/errors";
import { createWorkspaceJournal } from "../workspace/journal";
import type { WorkspaceJournal } from "../workspace/journal";
import { journaledWrite } from "../workspace/journal-io";
import { defaultSettings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import type { ResolvedAttachments } from "./attachments";
import type { EngineDeps } from "./engine";
import { createEngine } from "./engine";
import { ChatRewindBusyError } from "./errors";
import { rehydrateThread } from "./sanitize";
import { abortersCount, useChatStore } from "./store";
import type { ChatMode, ChatThread } from "./types";
import { convertAgentNoticePart, defaultThreadConfig } from "./types";

type Usage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
};

type FinishReason = { unified: "stop" | "tool-calls"; raw: string | undefined };

type Chunk =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason };

function usage(): Usage {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textStep(id: string, delta: string): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta },
    { type: "text-end", id },
    {
      type: "finish",
      usage: usage(),
      finishReason: { unified: "stop", raw: undefined },
    },
  ];
}

function toolStep(id: string, toolName: string, input: string): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: input },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input },
    {
      type: "finish",
      usage: usage(),
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    },
  ];
}

function makeModel(
  entries: Array<{ stream: ReadableStream<Chunk> }>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: entries });
}

/*
  Step variants that carry explicit counts, so a multi-step turn can be given
  per-step usage and the summed-versus-final-step distinction asserted.
*/
function textStepWithUsage(
  id: string,
  delta: string,
  input: number,
  output: number,
): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta },
    { type: "text-end", id },
    {
      type: "finish",
      usage: {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      finishReason: { unified: "stop", raw: undefined },
    },
  ];
}

function toolStepWithUsage(
  id: string,
  toolName: string,
  input: string,
  inputTokens: number,
  outputTokens: number,
): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: input },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input },
    {
      type: "finish",
      usage: {
        inputTokens: {
          total: inputTokens,
          noCache: inputTokens,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
      },
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    },
  ];
}

/** A model that can both stream a turn and answer the compaction summary call. */
function compactingModel(
  summary: string,
  entries: Array<{ stream: ReadableStream<Chunk> }>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: entries,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: summary }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: usage(),
      warnings: [],
    }),
  });
}

/** Settings whose cap is small enough for a seeded thread to cross it. */
function cappedSettings(maxContextTokens: number): Settings {
  const base = defaultSettings();
  return { ...base, context: { ...base.context, maxContextTokens } };
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

const skillStore: SkillStore = {
  save: async () => {},
  remove: async () => {},
  list: async () => [],
};

function echoProvider(): ToolProvider {
  return {
    names: ["test_tool"],
    isAvailable: () => true,
    create: () =>
      tool({
        description: "Echo a value.",
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: { value: { type: "string" } },
        }),
        execute: async (input) =>
          `echo:${String((input as { value?: unknown }).value ?? "")}`,
      }),
  };
}

function slowProvider(): ToolProvider {
  return {
    names: ["slow_tool"],
    isAvailable: () => true,
    create: () =>
      tool({
        description: "Never resolves until aborted.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            const signal = (options as { abortSignal?: AbortSignal })
              .abortSignal;
            const abort = () =>
              reject(new DOMException("aborted", "AbortError"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort);
          }),
      }),
  };
}

interface MemoryStore {
  loadThread(id: string): Promise<ChatThread | null>;
  saveThread(thread: ChatThread): Promise<void>;
  listThreads(): Promise<
    Array<{
      id: string;
      title: string;
      workspaceName?: string;
      updatedAt: number;
    }>
  >;
  deleteThread(id: string): Promise<void>;
  get(id: string): ChatThread | undefined;
}

function memoryStore(initial: ChatThread[] = []): MemoryStore {
  const threads = new Map(initial.map((thread) => [thread.id, thread]));
  return {
    loadThread: async (id) => threads.get(id) ?? null,
    saveThread: async (thread) => {
      threads.set(thread.id, thread);
    },
    listThreads: async () =>
      [...threads.values()].map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      })),
    deleteThread: async (id) => {
      threads.delete(id);
    },
    get: (id) => threads.get(id),
  };
}

function setup(options: {
  model: LanguageModel;
  toolRegistry?: ToolRegistry;
  skillRegistry?: SkillRegistry;
  settings?: Settings | null;
  store?: MemoryStore;
  modelFactory?: EngineDeps["modelFactory"];
  persistApproval?: EngineDeps["persistApproval"];
  workspace?: EngineDeps["workspace"];
  journalFor?: EngineDeps["journalFor"];
  activeAgentsFor?: EngineDeps["activeAgentsFor"];
}) {
  const store = options.store ?? memoryStore();
  const toolRegistry = options.toolRegistry ?? new ToolRegistry();
  const skillRegistry = options.skillRegistry ?? new SkillRegistry(skillStore);
  const deps: EngineDeps = {
    getSettings: () =>
      options.settings === undefined ? defaultSettings() : options.settings,
    skillRegistry,
    toolRegistry,
    threadStore: store,
    modelFactory: options.modelFactory ?? (() => options.model),
    ...(options.persistApproval ? { persistApproval: options.persistApproval } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.journalFor ? { journalFor: options.journalFor } : {}),
    ...(options.activeAgentsFor ? { activeAgentsFor: options.activeAgentsFor } : {}),
  };
  return { engine: createEngine(deps), store, toolRegistry, skillRegistry };
}

function seed(
  id: string,
  messages: UIMessage[],
  config = defaultThreadConfig("p1", "m1"),
  mode?: ChatMode,
): ChatThread {
  const thread: ChatThread = {
    id,
    title: "Thread",
    messages,
    config,
    createdAt: 1,
    updatedAt: 1,
    ...(mode ? { mode } : {}),
  };
  useChatStore.getState().setThread(thread);
  return thread;
}

function toolNamesOf(model: MockLanguageModelV4, call: number): string[] {
  const tools = model.doStreamCalls[call]?.tools ?? [];
  return tools.map((entry) => (entry as { name?: string }).name ?? "");
}

describe("chat engine", () => {
  beforeEach(() => {
    useChatStore.getState().clear();
  });

  it("streams a text turn and persists it", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "Hello")) }]);
    const { engine, store } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(textOf(messages[1])).toBe("Hello");
    expect(messages[1].metadata).toMatchObject({ chatStatus: "done" });
    expect(store.get("th1")?.messages).toHaveLength(2);
  });

  it("names a new conversation from the first reply", async () => {
    const model = compactingModel("Vault Key Derivation", [
      { stream: streamOf(textStep("t1", "The vault derives a key from your password.")) },
    ]);
    const { engine, store } = setup({ model });
    seed("th1", []);
    useChatStore.getState().setThread({
      ...useChatStore.getState().threads.th1,
      title: "New chat",
    });

    await engine.sendTurn("th1", "How does the vault work?");

    await vi.waitFor(() =>
      expect(store.get("th1")?.title).toBe("Vault Key Derivation"),
    );
    expect(useChatStore.getState().threads.th1.title).toBe("Vault Key Derivation");
  });

  it("never overwrites a conversation the user already named", async () => {
    const model = compactingModel("Ignored", [
      { stream: streamOf(textStep("t1", "Hello")) },
    ]);
    const { engine, store } = setup({ model });
    seed("th1", [], defaultThreadConfig("p1", "m1"));
    useChatStore.getState().setThread({
      ...useChatStore.getState().threads.th1,
      title: "My own title",
    });

    await engine.sendTurn("th1", "hi");

    expect(store.get("th1")?.title).toBe("My own title");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("re-names the conversation every fifth user turn", async () => {
    const model = compactingModel("Updated Title", [
      { stream: streamOf(textStep("t1", "Reply")) },
    ]);
    const { engine, store } = setup({ model });
    seed("th1", [user("u1", "a"), user("u2", "b"), user("u3", "c"), user("u4", "d")]);
    useChatStore.getState().setThread({
      ...useChatStore.getState().threads.th1,
      title: "Old title",
      titleSource: "auto",
    });

    await engine.sendTurn("th1", "fifth");

    await vi.waitFor(() => expect(store.get("th1")?.title).toBe("Updated Title"));
    expect(store.get("th1")?.titleSource).toBe("auto");
    expect(store.get("th1")?.titleUserCount).toBe(5);
  });

  it("never re-names a user title, even at the cadence", async () => {
    const model = compactingModel("Ignored", [
      { stream: streamOf(textStep("t1", "Reply")) },
    ]);
    const { engine, store } = setup({ model });
    seed("th1", [user("u1", "a"), user("u2", "b"), user("u3", "c"), user("u4", "d")]);
    useChatStore.getState().setThread({
      ...useChatStore.getState().threads.th1,
      title: "Mine",
      titleSource: "user",
    });

    await engine.sendTurn("th1", "fifth");

    expect(store.get("th1")?.title).toBe("Mine");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("carries resolved attachments and records what it inlined", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "Hello")) }]);
    const { engine } = setup({ model });
    seed("th1", []);

    const resolved: ResolvedAttachments = {
      nonce: "abcdef0123456789",
      items: [
        {
          record: { path: "a.ts", hash: "cafe", mode: "inline" },
          parts: [{ type: "text", text: "<attached …>const a = 1</attached-…>" }],
          fenced: true,
        },
      ],
      errors: [],
    };

    await engine.sendTurn("th1", "explain this", { attachments: resolved });

    const userMessage = useChatStore.getState().threads.th1.messages[0];
    expect(userMessage.parts).toHaveLength(3);
    expect(textOf(userMessage)).toContain("const a = 1");
    // The question stays last, so the model reads the instruction after the data.
    expect((userMessage.parts[2] as { text: string }).text).toBe("explain this");
    expect(userMessage.metadata).toMatchObject({
      attachments: [{ path: "a.ts", hash: "cafe", mode: "inline" }],
    });
  });

  it("suppresses a repeat of bytes already in the window", async () => {
    const model = makeModel([
      { stream: streamOf(textStep("t1", "One")) },
      { stream: streamOf(textStep("t2", "Two")) },
    ]);
    const { engine } = setup({ model });
    seed("th1", []);

    const resolved = (): ResolvedAttachments => ({
      nonce: "abcdef0123456789",
      items: [
        {
          record: { path: "a.ts", hash: "cafe", mode: "inline" },
          parts: [{ type: "text", text: "INLINED BODY" }],
          fenced: true,
        },
      ],
      errors: [],
    });

    await engine.sendTurn("th1", "first", { attachments: resolved() });
    await engine.sendTurn("th1", "second", { attachments: resolved() });

    const messages = useChatStore.getState().threads.th1.messages;
    const second = messages[2];
    expect(textOf(second)).not.toContain("INLINED BODY");
    // The marker has to fail safe: compaction can bury the original in the same
    // run that suppresses it.
    expect(textOf(second)).toContain("read_file");
    expect(second.metadata).toMatchObject({
      attachments: [{ path: "a.ts", mode: "unchanged" }],
    });
  });

  it("sends the same single-part message as before when nothing is attached", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "Hello")) }]);
    const { engine } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    const userMessage = useChatStore.getState().threads.th1.messages[0];
    expect(userMessage.parts).toEqual([{ type: "text", text: "hi" }]);
    expect(userMessage.metadata).toBeUndefined();
  });

  it("records the turn usage without clobbering the run status", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "Hello")) }]);
    const { engine, store } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    const assistantMessage = useChatStore.getState().threads["th1"]?.messages[1];
    // Both fields have to survive: the metadata callback and `setChatStatus`
    // write to the same object, so one overwriting the other is the failure
    // mode this asserts against.
    expect(assistantMessage?.metadata).toMatchObject({
      chatStatus: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
    });
    const persisted = store.get("th1")?.messages[1];
    expect(persisted?.metadata).toMatchObject({
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it("clears the live stream stats when a run ends and never persists them", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "Hello")) }]);
    const { engine, store } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    expect(useChatStore.getState().liveStats["th1"]).toBeUndefined();
    expect(JSON.stringify(store.get("th1"))).not.toContain("liveStats");
  });

  it("records a multi-step turn's context from its final step", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStepWithUsage("t1", "echo", '{"value":"x"}', 10, 5)) },
        { stream: streamOf(textStepWithUsage("t2", "done", 20, 7)) },
      ],
    });
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(2);
    const usage = (
      useChatStore.getState().threads.th1.messages[1].metadata as {
        usage?: { contextTokens?: number; inputTokens?: number };
      }
    ).usage;
    // The provider sums the prompts across steps (10 + 20 = 30). Only the final
    // step's 20 + 7 describes the conversation the next request will carry.
    expect(usage?.inputTokens).toBe(30);
    expect(usage?.contextTokens).toBe(27);
  });

  it("does not compact again on the turn after an auto-compaction", async () => {
    const model = compactingModel("AUTO_SUMMARY", [
      { stream: streamOf(textStep("t1", "ok")) },
      { stream: streamOf(textStep("t2", "ok again")) },
    ]);
    const { engine } = setup({ model, settings: cappedSettings(1000) });
    seed("th1", [
      user("u1", "PRE_COMPACT"),
      {
        ...assistant("a1", "OLD_ANSWER"),
        metadata: {
          chatStatus: "done",
          usage: { inputTokens: 900, outputTokens: 100, estimated: false },
        },
      },
    ]);

    await engine.sendTurn("th1", "first question");
    expect(model.doGenerateCalls).toHaveLength(1);

    // The boundary has to lower the number that triggered it, or every later
    // turn pays for another summarization call.
    await engine.sendTurn("th1", "second question");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("sends only the messages since the compaction boundary", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "ok")) }]);
    const { engine } = setup({ model });
    seed("th1", [
      user("u1", "PRE_BOUNDARY"),
      assistant("a1", "ALSO_PRE_BOUNDARY"),
      {
        id: "b1",
        role: "assistant",
        parts: [{ type: "text", text: "THE_SUMMARY" }],
        metadata: {
          chatStatus: "done",
          compaction: { at: 1, replacedCount: 2, tokensBefore: 50 },
        },
      },
    ]);

    await engine.sendTurn("th1", "POST_BOUNDARY");

    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).not.toContain("PRE_BOUNDARY");
    expect(prompt).toContain("THE_SUMMARY");
    expect(prompt).toContain("POST_BOUNDARY");
    // The stored transcript is untouched: the boundary changes the request, not
    // the conversation the user can still scroll through.
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(5);
  });

  it("auto-compacts before the run once the context reaches the cap", async () => {
    const model = compactingModel("AUTO_SUMMARY", [
      { stream: streamOf(textStep("t1", "ok")) },
    ]);
    const { engine, store } = setup({ model, settings: cappedSettings(1000) });
    seed("th1", [
      user("u1", "PRE_COMPACT"),
      {
        ...assistant("a1", "OLD_ANSWER"),
        metadata: {
          chatStatus: "done",
          usage: { inputTokens: 900, outputTokens: 100, estimated: false },
        },
      },
    ]);

    await engine.sendTurn("th1", "NEW_QUESTION");

    expect(model.doGenerateCalls).toHaveLength(1);
    const messages = useChatStore.getState().threads.th1.messages;
    const boundaries = messages.filter(
      (message) =>
        (message.metadata as { compaction?: unknown } | undefined)?.compaction !==
        undefined,
    );
    expect(boundaries).toHaveLength(1);
    // The boundary is persisted before the run, so a later failure cannot lose it.
    expect(
      store
        .get("th1")
        ?.messages.some(
          (message) =>
            (message.metadata as { compaction?: unknown } | undefined)
              ?.compaction !== undefined,
        ),
    ).toBe(true);

    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).not.toContain("PRE_COMPACT");
    expect(prompt).toContain("AUTO_SUMMARY");
    // The pending question has to survive the compaction that ran ahead of it.
    expect(prompt).toContain("NEW_QUESTION");
  });

  it("runs uncompacted, keeping the user's turn, when the summary call fails", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("summary provider down");
      },
      doStream: [{ stream: streamOf(textStep("t1", "ok")) }],
    });
    const { engine } = setup({ model, settings: cappedSettings(1000) });
    seed("th1", [
      user("u1", "PRE_COMPACT"),
      {
        ...assistant("a1", "OLD_ANSWER"),
        metadata: {
          chatStatus: "done",
          usage: { inputTokens: 900, outputTokens: 100, estimated: false },
        },
      },
    ]);

    await engine.sendTurn("th1", "NEW_QUESTION");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("NEW_QUESTION");
    expect(useChatStore.getState().error).toContain("summary provider down");
  });

  it("does not auto-compact an approval resume", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider({ count: 0 }));
    const model = compactingModel("SHOULD_NOT_HAPPEN", [
      { stream: streamOf(textStep("t1", "hi")) },
    ]);
    const { engine } = setup({
      model,
      toolRegistry: registry,
      settings: cappedSettings(1000),
    });
    seed("th1", [
      {
        ...assistant("a0", "OLD_ANSWER"),
        metadata: {
          chatStatus: "done",
          usage: { inputTokens: 900, outputTokens: 100, estimated: false },
        },
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-write_file",
            toolCallId: "c1",
            state: "approval-requested",
            input: { path: "a.txt" },
            approval: { id: "ap1" },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ]);

    await engine.respondToApproval("th1", { approvalId: "ap1", approved: true });

    // Re-slicing the history under a paused tool call would strand it, so the
    // resume must run on exactly the messages it was given.
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("forwards the system instruction and model parameters", async () => {
    const config = {
      ...defaultThreadConfig("p1", "m1"),
      systemInstruction: "SYSTEM_MARKER",
      params: { temperature: 0.5, topP: 0.9, maxOutputTokens: 123 },
    };
    const model = makeModel([{ stream: streamOf(textStep("t1", "done")) }]);
    const { engine } = setup({ model });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].temperature).toBe(0.5);
    expect(model.doStreamCalls[0].topP).toBe(0.9);
    expect(model.doStreamCalls[0].maxOutputTokens).toBe(123);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "SYSTEM_MARKER",
    );
  });

  it("injects the permission mode and the workspace project instruction", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "done")) }]);
    const workspace = {
      list: async () => [],
      readFile: async (path: string) =>
        path === "AGENTS.md" ? "PROJECT_RULE" : (() => { throw new Error("nope") })(),
      writeFile: async () => {},
      makeDir: async () => {},
      remove: async () => {},
      stat: async (path: string) => ({ path, kind: "file" as const, size: 0 }),
      move: async () => ({ from: "", to: "", kind: "file" as const, size: 0 }),
      copy: async () => ({ from: "", to: "", kind: "file" as const, size: 0 }),
      search: async () => ({ hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 }),
    } as WorkspaceApi;
    const { engine } = setup({ model, workspace });
    seed("th1", [], defaultThreadConfig("p1", "m1"), "read_only");

    await engine.sendTurn("th1", "go");

    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).toContain("## Permission mode");
    expect(prompt).toContain("`read_only` mode");
    expect(prompt).toContain("PROJECT_RULE");
  });

  it("retries a failed turn by resuming it instead of replaying its tools", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.registerProvider({
      names: ["test_tool"],
      isAvailable: () => true,
      create: () =>
        tool({
          description: "Echo a value.",
          inputSchema: jsonSchema<{ value: string }>({
            type: "object",
            properties: { value: { type: "string" } },
          }),
          execute: async (input) => {
            executions += 1;
            return `echo:${String((input as { value?: unknown }).value ?? "")}`;
          },
        }),
    });
    const model = makeModel([{ stream: streamOf(textStep("t2", "resumed")) }]);
    const { engine } = setup({ model, toolRegistry: registry });
    const failed = {
      id: "a1",
      role: "assistant" as const,
      parts: [
        { type: "text" as const, text: "checking" },
        {
          type: "tool-test_tool" as const,
          toolCallId: "c1",
          state: "output-available" as const,
          input: { value: "1" },
          output: "echo:1",
        },
      ],
      metadata: { chatStatus: "done", error: "provider exploded" },
    };
    seed("th1", [user("u1", "go"), failed]);

    await engine.rerun("th1", "a1");

    // The completed tool call was reused, not executed again.
    expect(executions).toBe(0);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("echo:1");
    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1].id).toBe("a1");
    expect(textOf(messages[1])).toContain("resumed");
    expect((messages[1].metadata as { error?: unknown }).error).toBeUndefined();
  });

  it("regenerates a healthy turn from the user message", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t2", "again")) }]);
    const { engine } = setup({ model });
    seed("th1", [user("u1", "go"), assistant("a1", "first")]);

    await engine.rerun("th1", "a1");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("u1");
    expect(textOf(messages[1])).toBe("again");
  });

  it("keeps running tool steps until the model stops calling tools", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const toolSteps = Array.from({ length: 12 }, (_value, index) => ({
      stream: streamOf(
        toolStep(`c${index}`, "test_tool", `{"value":"${index}"}`),
      ),
    }));
    const model = makeModel([
      ...toolSteps,
      { stream: streamOf(textStep("t13", "finished")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(13);
    const messages = useChatStore.getState().threads.th1.messages;
    expect(textOf(messages[1])).toBe("finished");
    expect(messages[1].metadata).toMatchObject({ chatStatus: "done" });
  });

  it("injects an enabled skill into the prompt and runs a tool step then a text step", async () => {
    const skillRegistry = new SkillRegistry(skillStore);
    skillRegistry.register(
      {
        id: "s1",
        name: "Skill One",
        description: "SKILL_DESC",
        instructions: "SKILL_MARKER",
        allowedTools: ["test_tool"],
        source: "vault",
      },
      { enabled: true },
    );
    const config = {
      ...defaultThreadConfig("p1", "m1"),
      enabledSkills: [{ id: "s1", source: "vault" as const }],
    };
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "test_tool", '{"value":"x"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry, skillRegistry });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(2);
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).toContain("SKILL_DESC");
    expect(prompt).not.toContain("SKILL_MARKER");
    expect(toolNamesOf(model, 0)).toContain("test_tool");
    const messages = useChatStore.getState().threads.th1.messages;
    const last = messages[messages.length - 1];
    expect(last.parts.some((part) => part.type.startsWith("tool-"))).toBe(true);
  });

  it("passes the model id and provider options through", async () => {
    const config = {
      ...defaultThreadConfig("p1", "MODEL_X"),
      providerOptions: { openai: { foo: "bar" } },
    };
    const model = makeModel([{ stream: streamOf(textStep("t1", "ok")) }]);
    const seen: Array<{ providerId: string; modelId?: string }> = [];
    const { engine } = setup({
      model,
      modelFactory: (_settings, providerId, modelId) => {
        seen.push({ providerId, modelId });
        return model;
      },
    });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(seen).toEqual([{ providerId: "p1", modelId: "MODEL_X" }]);
    expect(model.doStreamCalls[0].providerOptions).toMatchObject({
      openai: { foo: "bar" },
    });
  });

  it("drops the assistant placeholder when the stream fails to build", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "never")) }]);
    const { engine, store } = setup({
      model,
      modelFactory: () => {
        throw new Error("bad provider config");
      },
    });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    expect(
      useChatStore
        .getState()
        .threads.th1.messages.map((message) => message.role),
    ).toEqual(["user"]);
    expect(store.get("th1")?.messages.map((message) => message.role)).toEqual([
      "user",
    ]);
    expect(useChatStore.getState().error).toContain("bad provider config");
  });

  it("retries a transient provider error before giving up", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          throw new APICallError({
            message: "Service Unavailable",
            url: "https://example.com/v1/chat",
            requestBodyValues: {},
            statusCode: 503,
            responseHeaders: { "retry-after": "0" },
            isRetryable: true,
          });
        }
        return { stream: streamOf(textStep("t1", "recovered")) };
      },
    });
    const { engine } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(textOf(useChatStore.getState().threads.th1.messages[1])).toBe(
      "recovered",
    );
  });

  it("surfaces a failed run on the assistant message, not the global banner", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("provider exploded");
      },
    });
    const { engine, store } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1].metadata).toMatchObject({
      error: "Error: provider exploded",
    });
    expect(useChatStore.getState().error).toBeNull();
    expect(store.get("th1")?.messages[1].metadata).toMatchObject({
      error: "Error: provider exploded",
    });
  });

  it("removes a skill prompt block when the skill is not enabled", async () => {
    const skillRegistry = new SkillRegistry(skillStore);
    skillRegistry.register(
      {
        id: "s1",
        name: "Skill One",
        description: "",
        instructions: "SKILL_MARKER",
        allowedTools: ["test_tool"],
        source: "vault",
      },
      { enabled: false },
    );
    const config = {
      ...defaultThreadConfig("p1", "m1"),
      enabledSkills: [{ id: "s1", source: "vault" as const }],
    };
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const model = makeModel([{ stream: streamOf(textStep("t1", "ok")) }]);
    const { engine } = setup({ model, toolRegistry: registry, skillRegistry });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "SKILL_MARKER",
    );
  });

  it("edits a user message, truncates downstream, and reruns", async () => {
    const model = makeModel([
      { stream: streamOf(textStep("t1", "regenerated")) },
    ]);
    const { engine } = setup({ model });
    seed("th1", [
      user("u1", "old"),
      assistant("a1", "old answer"),
      user("u2", "later"),
      assistant("a2", "later answer"),
    ]);

    await engine.editMessage("th1", "u1", [{ type: "text", text: "edited" }]);

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(textOf(messages[0])).toBe("edited");
    expect(textOf(messages[1])).toBe("regenerated");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("edits an assistant message without rerunning", async () => {
    const model = makeModel([]);
    const { engine } = setup({ model });
    seed("th1", [user("u1", "q"), assistant("a1", "old")]);

    await engine.editMessage("th1", "a1", [
      { type: "text", text: "edited answer" },
    ]);

    expect(textOf(useChatStore.getState().threads.th1.messages[1])).toBe(
      "edited answer",
    );
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("reruns a middle assistant message from its own parent without duplication", async () => {
    const model = makeModel([
      { stream: streamOf(textStep("t1", "regenerated")) },
    ]);
    const { engine, store } = setup({ model });
    seed("th1", [
      user("u1", "q1"),
      assistant("a1", "answer1"),
      user("u2", "q2"),
      assistant("a2", "answer2"),
    ]);

    await engine.rerun("th1", "a1");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("u1");
    expect(textOf(messages[1])).toBe("regenerated");
    expect(store.get("th1")?.messages).toHaveLength(2);
  });

  it("undoes the last turn", async () => {
    const model = makeModel([]);
    const { engine } = setup({ model });
    seed("th1", [user("u1", "q"), assistant("a1", "a")]);

    await engine.undo("th1");

    expect(useChatStore.getState().threads.th1.messages).toHaveLength(0);
  });

  it("cancels a tool-loop run and sanitizes the persisted assistant message", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
    ]);
    const { engine, store } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    await engine.cancel("th1");
    await run;

    const assistantMessage = useChatStore
      .getState()
      .threads.th1.messages.at(-1);
    if (!assistantMessage) throw new Error("missing assistant message");
    const toolPart = assistantMessage.parts.find((part) =>
      part.type.startsWith("tool-"),
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.state).toBe("output-error");
    expect(assistantMessage.metadata).toMatchObject({ chatStatus: "done" });
    expect(store.get("th1")?.messages.at(-1)?.metadata).toMatchObject({
      chatStatus: "done",
    });
  });

  it("rehydrates a poisoned persisted thread so the next request converts", async () => {
    const poisoned: ChatThread = {
      id: "th1",
      title: "Thread",
      messages: [
        user("u1", "q"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              toolCallId: "c1",
              state: "input-available",
              input: {},
            } as unknown as UIMessage["parts"][number],
          ],
          metadata: { chatStatus: "streaming" },
        },
      ],
      config: defaultThreadConfig("p1", "m1"),
      createdAt: 1,
      updatedAt: 1,
    };
    const model = makeModel([{ stream: streamOf(textStep("t2", "ok")) }]);
    const { engine } = setup({ model, store: memoryStore([poisoned]) });

    await engine.sendTurn("th1", "again");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(textOf(messages[3])).toBe("ok");
  });

  it("dispose unregisters its abort callback and aborts an in-flight run", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    useVaultStore.setState({ status: "unlocked" });

    const registered = abortersCount();
    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));

    engine.dispose();
    await run;

    expect(abortersCount()).toBe(registered - 1);
    expect(useChatStore.getState().activeRuns).toBe(0);
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("keeps streaming when one of two concurrent runs ends", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
      { stream: streamOf(toolStep("c2", "slow_tool", "{}")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    seed("th2", []);

    const first = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    const second = engine.sendTurn("th2", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(2));
    expect(useChatStore.getState().activeRuns).toBe(2);

    await engine.cancel("th1");
    await first;
    // th2 is still running: status must not flip to idle.
    expect(useChatStore.getState().activeRuns).toBe(1);
    expect(useChatStore.getState().status).toBe("streaming");

    await engine.cancel("th2");
    await second;
    expect(useChatStore.getState().activeRuns).toBe(0);
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("aborts and clears on vault lock without an unhandled rejection", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    useVaultStore.setState({ status: "unlocked" });

    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    useVaultStore.setState({ status: "locked" });
    await run;

    expect(useChatStore.getState().threads).toEqual({});
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("converts only an inline agent notice data part, leaving other data parts out", () => {
    const notice: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "data-agent-notice",
          data: { text: "NOTICE_TEXT", status: "completed", response: "done" },
        } as unknown as UIMessage["parts"][number],
      ],
    };
    expect(convertAgentNoticePart(notice.parts[0])).toEqual({
      type: "text",
      text: "NOTICE_TEXT",
    });
    const other = {
      type: "data-something-else",
      data: { text: "IGNORED" },
    } as unknown as UIMessage["parts"][number];
    expect(convertAgentNoticePart(other)).toBeUndefined();
    const malformed = {
      type: "data-agent-notice",
      data: { text: 42 },
    } as unknown as UIMessage["parts"][number];
    expect(convertAgentNoticePart(malformed)).toBeUndefined();
  });

  it("makes an inline agent notice visible to the model on the next turn", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "ok")) }]);
    const { engine } = setup({ model });
    const withNotice: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "parent answer" },
        {
          type: "data-agent-notice",
          data: {
            text: "INLINE_NOTICE_MARKER",
            status: "completed",
            response: "sub result",
          },
        } as unknown as UIMessage["parts"][number],
      ],
      metadata: { chatStatus: "done" },
    };
    seed("th1", [user("u1", "delegate"), withNotice]);

    await engine.sendTurn("th1", "next");

    // Without `convertDataPart` wired into `buildRunStream`, the data part is
    // dropped and the model never reads the notice it was shown.
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "INLINE_NOTICE_MARKER",
    );
  });
});

describe("progressive skill disclosure", () => {
  function skillRegistryWith(body: string): SkillRegistry {
    const registry = new SkillRegistry(skillStore);
    registry.resolve = (() => [
      {
        id: "s1",
        name: "S1",
        description: "D1",
        instructions: body,
        source: "vault" as const,
        allowedTools: ["test_tool"],
      },
    ]) as typeof registry.resolve;
    registry.toolNamesFor = (() => ["test_tool"]) as typeof registry.toolNamesFor;
    return registry;
  }

  function registryWithTools(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    registry.registerProvider(createSkillToolProvider({ isEnabled: () => true }));
    return registry;
  }

  it("unions load_skill into a narrowed tool set and sends only the index", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "done")) }]);
    const { engine } = setup({
      model,
      toolRegistry: registryWithTools(),
      skillRegistry: skillRegistryWith("BODY_MARKER"),
    });
    seed("th1", []);

    await engine.sendTurn("th1", "go");
    const names = toolNamesOf(model, 0);
    expect(names).toContain("test_tool");
    expect(names).toContain("load_skill");
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).toContain("D1");
    expect(prompt).not.toContain("BODY_MARKER");
  });

  it("omits load_skill when no skill is enabled", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "done")) }]);
    const { engine } = setup({ model, toolRegistry: registryWithTools() });
    seed("th1", []);

    await engine.sendTurn("th1", "go");
    expect(toolNamesOf(model, 0)).not.toContain("load_skill");
  });
});

describe("thread plan", () => {
  it("writes the plan and reads it back from the thread store", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(createPlanToolProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "update_plan", '{"items":[{"text":"one"}]}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine, store } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    await engine.sendTurn("th1", "plan it");
    const expected = [{ id: "p1", text: "one", status: "pending" }];
    expect(useChatStore.getState().threads.th1.plan).toEqual(expected);
    expect(store.get("th1")?.plan).toEqual(expected);
  });
});

function gatedProvider(counter: { count: number }): ToolProvider {
  return {
    names: ["write_file"],
    isAvailable: () => true,
    create: () =>
      tool({
        description: "Write a file.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
        execute: async () => {
          counter.count += 1;
          return "written";
        },
      }),
  };
}

function pausedPart(messages: UIMessage[], id: string): Record<string, unknown> {
  const message = messages.find((entry) => entry.id === id);
  const part = message?.parts.find((entry) => entry.type === "tool-write_file");
  if (!part) throw new Error("no paused part");
  return part as unknown as Record<string, unknown>;
}

/** A `read_only` thread is the mode where a write is above the ceiling and asks. */
function seedReadOnly(id: string, messages: UIMessage[]): ChatThread {
  return seed(id, messages, defaultThreadConfig("p1", "m1"), "read_only");
}

describe("tool approval", () => {
  it("requests approval without executing, then executes once after approval", async () => {
    const counter = { count: 0 };
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider(counter));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine, store } = setup({ model, toolRegistry: registry });
    seedReadOnly("th1", []);

    await engine.sendTurn("th1", "go");
    let messages = useChatStore.getState().threads.th1.messages;
    const assistantId = messages[1].id;
    const part = pausedPart(messages, assistantId);
    expect(part.state).toBe("approval-requested");
    expect(counter.count).toBe(0);
    const approvalId = (part.approval as { id: string }).id;
    expect(typeof approvalId).toBe("string");

    await engine.respondToApproval("th1", { approvalId, approved: true });
    messages = useChatStore.getState().threads.th1.messages;
    expect(counter.count).toBe(1);
    expect(messages.filter((message) => message.id === assistantId)).toHaveLength(1);
    expect(textOf(messages.find((message) => message.id === assistantId)!)).toBe("done");
    expect(store.get("th1")?.messages.filter((m) => m.id === assistantId)).toHaveLength(1);
  });

  it("does not execute on denial", async () => {
    const counter = { count: 0 };
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider(counter));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seedReadOnly("th1", []);

    await engine.sendTurn("th1", "go");
    const messages = useChatStore.getState().threads.th1.messages;
    const approvalId = (pausedPart(messages, messages[1].id).approval as { id: string }).id;

    await engine.respondToApproval("th1", { approvalId, approved: false });
    expect(counter.count).toBe(0);
  });

  it("ignores an unknown approval id without starting a run", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider({ count: 0 }));
    const model = makeModel([{ stream: streamOf(textStep("t1", "hi")) }]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    await engine.respondToApproval("th1", { approvalId: "nope", approved: true });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("rejects a stale approval and expires it", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider({ count: 0 }));
    const model = makeModel([{ stream: streamOf(textStep("t1", "hi")) }]);
    const { engine } = setup({ model, toolRegistry: registry });
    const paused: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-write_file",
          toolCallId: "c1",
          state: "approval-requested",
          input: { path: "a.txt" },
          approval: { id: "ap1" },
        } as unknown as UIMessage["parts"][number],
      ],
    };
    const newer: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "later" }] };
    seed("th1", [paused, newer]);

    await engine.respondToApproval("th1", { approvalId: "ap1", approved: true });
    expect(model.doStreamCalls).toHaveLength(0);
    const part = useChatStore.getState().threads.th1.messages[0].parts[0] as unknown as Record<
      string,
      unknown
    >;
    expect(part.state).toBe("output-error");
    expect((part.approval as Record<string, unknown>).resolution).toBe("expired");
  });

  it("does not persist allow-once", async () => {
    const persisted: Array<[string, string]> = [];
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider({ count: 0 }));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({
      model,
      toolRegistry: registry,
      persistApproval: async (name, decision) => {
        persisted.push([name, decision]);
      },
    });
    seedReadOnly("th1", []);

    await engine.sendTurn("th1", "go");
    const messages = useChatStore.getState().threads.th1.messages;
    const approvalId = (pausedPart(messages, messages[1].id).approval as { id: string }).id;
    await engine.respondToApproval("th1", {
      approvalId,
      approved: true,
      optionId: "allow-once",
    });
    expect(persisted).toEqual([]);
  });

  it("persists allow-always", async () => {
    const persisted: Array<[string, string]> = [];
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider({ count: 0 }));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({
      model,
      toolRegistry: registry,
      persistApproval: async (name, decision) => {
        persisted.push([name, decision]);
      },
    });
    seedReadOnly("th1", []);

    await engine.sendTurn("th1", "go");
    const messages = useChatStore.getState().threads.th1.messages;
    const approvalId = (pausedPart(messages, messages[1].id).approval as { id: string }).id;
    await engine.respondToApproval("th1", {
      approvalId,
      approved: true,
      optionId: "allow-always",
    });
    expect(persisted).toEqual([["write_file", "allow"]]);
  });

  it("runs an editing-tier write without prompting", async () => {
    const counter = { count: 0 };
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider(counter));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    await engine.sendTurn("th1", "go");
    expect(counter.count).toBe(1);
    const messages = useChatStore.getState().threads.th1.messages;
    expect(pausedPart(messages, messages[1].id).state).toBe("output-available");
  });

  it("auto-approves a gated tool in god mode", async () => {
    const counter = { count: 0 };
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider(counter));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    useChatStore.getState().setThread({
      ...useChatStore.getState().threads.th1,
      mode: "god",
    });

    await engine.sendTurn("th1", "go");
    expect(counter.count).toBe(1);
    expect(textOf(useChatStore.getState().threads.th1.messages[1])).toBe("done");
  });
});

describe("compact", () => {
  it("refuses while a run is in flight, rather than clobbering it", async () => {
    let release: (() => void) | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { stream: streamOf(textStep("t1", "hi")) };
      },
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "SUMMARY" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    });
    const { engine } = setup({ model });
    seed("th1", [user("u1", "hi"), assistant("a1", "there")]);

    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(release).toBeDefined());

    await expect(engine.compact("th1")).rejects.toThrow(/run is in flight/);
    expect(model.doGenerateCalls).toHaveLength(0);

    release?.();
    await run;
  });

  it("moves only the messages, leaving the plan and mode intact", async () => {
    const model = compactingModel("SUMMARY", []);
    const { engine } = setup({ model });
    const seeded = seed("th1", [user("u1", "hi"), assistant("a1", "there")]);
    useChatStore.getState().setThread({
      ...seeded,
      mode: "read_only",
      plan: [{ id: "p1", text: "keep me", status: "pending" }],
    });

    await engine.compact("th1");

    const thread = useChatStore.getState().threads.th1;
    expect(thread.mode).toBe("read_only");
    expect(thread.plan).toEqual([{ id: "p1", text: "keep me", status: "pending" }]);
    expect(thread.messages).toHaveLength(3);
  });

  it("aborts an in-flight summarization on cancel", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        await new Promise((resolve, reject) => {
          abortSignal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
          setTimeout(resolve, 5000);
        });
        return {
          content: [{ type: "text" as const, text: "SUMMARY" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: usage(),
          warnings: [],
        };
      },
    });
    const { engine } = setup({ model });
    seed("th1", [user("u1", "hi"), assistant("a1", "there")]);

    const compacting = engine.compact("th1");
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    await engine.cancel("th1");

    await expect(compacting).rejects.toThrow();
    // Nothing was appended: compaction is transactional.
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(2);
  });
});

function noticePartOf(message: UIMessage) {
  return message.parts.find((part) => part.type === "data-agent-notice") as
    | { type: "data-agent-notice"; data: { text: string } & Record<string, unknown> }
    | undefined;
}

describe("chat engine agent notices", () => {
  beforeEach(() => {
    useChatStore.getState().clear();
  });

  it("appends and persists a background notice when idle", async () => {
    const { engine, store } = setup({ model: makeModel([]) });
    seed("th1", [user("u1", "hi")]);

    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-1");

    await vi.waitFor(() => expect(useChatStore.getState().threads.th1.messages).toHaveLength(2));
    const notice = useChatStore.getState().threads.th1.messages[1];
    expect(notice.metadata).toMatchObject({
      agentNotice: true,
      untrusted: true,
      runId: "run-1",
    });
    expect(noticePartOf(notice)).toMatchObject({
      data: { text: "Sub-agent finished: done", runId: "run-1" },
    });
    expect(notice.id).not.toBe(useChatStore.getState().threads.th1.messages[0].id);
    await vi.waitFor(async () =>
      expect((await store.loadThread("th1"))?.messages).toHaveLength(2),
    );
  });

  it("carries a structured report so the notice can render as a sub-agent card", async () => {
    const { engine } = setup({ model: makeModel([]) });
    seed("th1", [user("u1", "hi")]);

    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-3", {
      label: "audit",
      status: "completed",
      response: "Four call sites.",
    });

    await vi.waitFor(() => expect(useChatStore.getState().threads.th1.messages).toHaveLength(2));
    const notice = useChatStore.getState().threads.th1.messages[1];
    expect(notice.metadata).toMatchObject({
      agentReport: {
        runId: "run-3",
        label: "audit",
        status: "completed",
        response: "Four call sites.",
      },
    });
  });

  it("shows a notice inline while the run streams, across chunks and a reload", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<Chunk>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "first " });
            await gate;
            controller.enqueue({ type: "text-delta", id: "t1", delta: "second" });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              usage: usage(),
              finishReason: { unified: "stop", raw: undefined },
            });
            controller.close();
          },
        }),
      }),
    });
    const { engine, store } = setup({ model });
    seed("th1", [user("u1", "hi")]);

    const running = engine.sendTurn("th1", "do it");
    await vi.waitFor(() => {
      const last = useChatStore.getState().threads.th1.messages.at(-1);
      expect(last && textOf(last)).toBe("first ");
    });

    engine.appendAgentNotice("th1", "arrived mid-run", "run-2", {
      label: "audit",
      status: "completed",
      response: "Four call sites.",
    });

    // Visible immediately, inside the still-streaming assistant message.
    const streaming = useChatStore.getState().threads.th1.messages.at(-1)!;
    expect(streaming.metadata).toMatchObject({ chatStatus: "streaming" });
    expect(noticePartOf(streaming)?.data).toMatchObject({
      text: "arrived mid-run",
      runId: "run-2",
      label: "audit",
      status: "completed",
      response: "Four call sites.",
    });
    // The seeded user turn, this turn's user message, and the streaming reply.
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(3);

    release();
    await running;

    // The later chunk and the final write keep the notice.
    const settled = useChatStore.getState().threads.th1.messages.at(-1)!;
    expect(textOf(settled)).toBe("first second");
    expect(settled.metadata).toMatchObject({ chatStatus: "done" });
    expect(noticePartOf(settled)?.data).toMatchObject({ runId: "run-2" });

    // A reload keeps it: sanitize/rehydrate only rewrite tool parts.
    const saved = store.get("th1");
    expect(saved).toBeDefined();
    const reloaded = rehydrateThread(saved!);
    expect(noticePartOf(reloaded.messages.at(-1)!)?.data).toMatchObject({
      text: "arrived mid-run",
      label: "audit",
      response: "Four call sites.",
    });
  });
});

describe("chat engine auto-continue", () => {
  beforeEach(() => {
    useChatStore.getState().clear();
  });

  function autoSettings(enabled: boolean, max = 3): Settings {
    return { ...defaultSettings(), agents: { autoContinue: enabled, maxAutoContinues: max } };
  }

  function marker(id: string): UIMessage {
    return {
      id,
      role: "user",
      parts: [{ type: "text", text: "Sub-agent finished; continue using its result." }],
      metadata: { autoContinue: { runId: id } },
    };
  }

  function lastUserText(model: MockLanguageModelV4, call: number): string {
    const prompt = model.doStreamCalls[call].prompt;
    const lastUser = [...prompt].reverse().find((message) => message.role === "user");
    return JSON.stringify(lastUser?.content ?? "");
  }

  it("starts no run for an idle notice while the setting is off", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "acting on it")) }]);
    const { engine } = setup({ model, settings: autoSettings(false) });
    seed("th1", [user("u1", "hi")]);

    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-1", {
      label: "audit",
      status: "completed",
      response: "done",
    });

    await vi.waitFor(() => expect(useChatStore.getState().threads.th1.messages).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("wakes the model once behind a marker when an idle notice lands", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "acting on it")) }]);
    const { engine } = setup({ model, settings: autoSettings(true) });
    seed("th1", [user("u1", "hi")]);

    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-1", {
      label: "audit",
      status: "completed",
      response: "done",
    });

    await vi.waitFor(() => {
      const last = useChatStore.getState().threads.th1.messages.at(-1);
      expect(last && textOf(last)).toBe("acting on it");
    });
    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[2].metadata).toMatchObject({ autoContinue: { runId: "run-1", label: "audit" } });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(lastUserText(model, 0)).toContain('Sub-agent \\"audit\\" finished; continue using its result.');
  });

  it("stops after the cap until the user speaks again", async () => {
    const model = makeModel([
      { stream: streamOf(textStep("t1", "fourth")) },
      { stream: streamOf(textStep("t2", "after user")) },
      { stream: streamOf(textStep("t3", "resumed")) },
    ]);
    const { engine } = setup({ model, settings: autoSettings(true, 3) });
    seed("th1", [
      user("u1", "hi"),
      marker("m1"),
      assistant("a1", "one"),
      marker("m2"),
      assistant("a2", "two"),
      marker("m3"),
      assistant("a3", "three"),
    ]);

    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-4");
    await vi.waitFor(() => expect(useChatStore.getState().threads.th1.messages).toHaveLength(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(model.doStreamCalls).toHaveLength(0);

    await engine.sendTurn("th1", "carry on");
    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-5");
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(2));
    await vi.waitFor(() => {
      const last = useChatStore.getState().threads.th1.messages.at(-1);
      expect(last && textOf(last)).toBe("after user");
    });
  });

  it("keeps a turn paused on the user's approval answerable when a notice lands meanwhile", async () => {
    const counter = { count: 0 };
    const registry = new ToolRegistry();
    registry.registerProvider(gatedProvider(counter));
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "write_file", '{"path":"a.txt"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry, settings: autoSettings(true) });
    seedReadOnly("th1", []);
    await engine.sendTurn("th1", "go");
    const assistantId = useChatStore.getState().threads.th1.messages[1].id;
    const approvalId = (pausedPart(useChatStore.getState().threads.th1.messages, assistantId).approval as {
      id: string;
    }).id;

    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-1", {
      label: "audit",
      status: "completed",
      response: "done",
    });
    await vi.waitFor(() =>
      expect(
        noticePartOf(useChatStore.getState().threads.th1.messages.find((message) => message.id === assistantId)!),
      ).toBeDefined(),
    );
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(2);
    expect(model.doStreamCalls).toHaveLength(1);

    await engine.respondToApproval("th1", { approvalId, approved: true });

    const messages = useChatStore.getState().threads.th1.messages;
    const resumed = messages.find((message) => message.id === assistantId)!;
    expect(counter.count).toBe(1);
    expect(textOf(resumed)).toContain("done");
    expect(noticePartOf(resumed)?.data).toMatchObject({ runId: "run-1" });
    expect(messages).toHaveLength(2);
  });

  it("never auto-continues a notice that arrives while a run is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<Chunk>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "working" });
            await gate;
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({ type: "finish", usage: usage(), finishReason: { unified: "stop", raw: undefined } });
            controller.close();
          },
        }),
      }),
    });
    const { engine } = setup({ model, settings: autoSettings(true) });
    seed("th1", [user("u1", "hi")]);

    const running = engine.sendTurn("th1", "go");
    await vi.waitFor(() => {
      const last = useChatStore.getState().threads.th1.messages.at(-1);
      expect(last && textOf(last)).toBe("working");
    });
    engine.appendAgentNotice("th1", "Sub-agent finished: done", "run-1");
    release();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(model.doStreamCalls).toHaveLength(1);
    expect(
      useChatStore.getState().threads.th1.messages.some(
        (message) => (message.metadata as { autoContinue?: unknown } | undefined)?.autoContinue !== undefined,
      ),
    ).toBe(false);
  });
});

describe("message rewind", () => {
  beforeEach(() => {
    useChatStore.getState().clear();
  });

  function turns(count: number): MockLanguageModelV4 {
    return makeModel(
      Array.from({ length: count }, (_, index) => ({
        stream: streamOf(textStep(`t${index}`, `reply ${index}`)),
      })),
    );
  }

  function rewindSetup(
    options: {
      files?: Record<string, string>;
      turns?: number;
      activeAgentsFor?: EngineDeps["activeAgentsFor"];
      messages?: UIMessage[];
    } = {},
  ) {
    const workspace: WorkspaceFs = createWorkspaceFs(
      createFakeWorkspace(options.files ?? {}).handle,
    );
    const journal: WorkspaceJournal = createWorkspaceJournal();
    const context = setup({
      model: turns(options.turns ?? 2),
      workspace,
      journalFor: async () => journal,
      ...(options.activeAgentsFor ? { activeAgentsFor: options.activeAgentsFor } : {}),
    });
    const thread = seed("th1", options.messages ?? []);
    useChatStore.getState().setThread({ ...thread, workspaceName: "proj" });
    useChatStore.getState().setActiveThread("th1");
    const userIds = () =>
      useChatStore
        .getState()
        .threads.th1.messages.filter((message) => message.role === "user")
        .map((message) => message.id);
    return { ...context, workspace, journal, userIds };
  }

  it("stamps each sent message with the journal head and keeps it through an edit", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup();
    await journaledWrite(journal, workspace, "a.txt", "one");
    await journaledWrite(journal, workspace, "a.txt", "two");

    await engine.sendTurn("th1", "first");
    const [id] = userIds();
    const stamped = () =>
      (useChatStore.getState().threads.th1.messages.find((message) => message.id === id)
        ?.metadata as { rewind?: unknown } | undefined)?.rewind;
    expect(stamped()).toEqual({ seq: 2, workspace: "proj" });

    await journaledWrite(journal, workspace, "a.txt", "three");
    await engine.editMessage("th1", id, [{ type: "text", text: "edited" }]);
    expect(stamped()).toEqual({ seq: 2, workspace: "proj" });
  });

  it("restores files to the moment the message was sent and cuts the thread before it", async () => {
    const { engine, store, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original" },
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "after first");
    await engine.sendTurn("th1", "second");
    await journaledWrite(journal, workspace, "a.txt", "after second");
    await journaledWrite(journal, workspace, "new.txt", "fresh");
    const [first, second] = userIds();

    const result = await engine.rewind("th1", second);

    expect(result).toMatchObject({
      text: "second",
      files: "ok",
      restored: ["a.txt"],
      removed: ["new.txt"],
      conflicts: [],
    });
    expect(result.failed).toBeUndefined();
    const ids = useChatStore.getState().threads.th1.messages.map((message) => message.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(first);
    expect(store.get("th1")?.messages.map((message) => message.id)).toEqual(ids);
    await expect(workspace.readFile("a.txt")).resolves.toBe("after first");
    await expect(workspace.readFile("new.txt")).rejects.toThrow();
  });

  it("previews the effect without touching files or messages", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original", "b.txt": "original" },
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "agent");
    await journaledWrite(journal, workspace, "b.txt", "agent");
    await journaledWrite(journal, workspace, "new.txt", "fresh");
    await workspace.writeFile("b.txt", "manual");
    const [id] = userIds();

    const preview = await engine.previewRewind("th1", id);

    expect(preview).toEqual({
      removedMessages: 2,
      text: "first",
      files: "ok",
      restore: ["a.txt"],
      remove: ["new.txt"],
      unrestorable: [],
      conflicts: ["b.txt"],
      busy: false,
    });
    await expect(workspace.readFile("a.txt")).resolves.toBe("agent");
    await expect(workspace.readFile("new.txt")).resolves.toBe("fresh");
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(2);
  });

  const busyCases: Array<[string, () => void, (() => number) | undefined]> = [
    ["a parent run", () => useChatStore.getState().beginRun("th1"), undefined],
    ["a compaction", () => useChatStore.getState().beginCompaction("th1"), undefined],
    ["a live sub-agent", () => undefined, () => 1],
  ];

  it.each(busyCases)("refuses while %s is active and changes nothing", async (_label, begin, agents) => {
    const { engine, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original" },
      ...(agents ? { activeAgentsFor: agents } : {}),
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "agent");
    const [id] = userIds();
    begin();

    await expect(engine.rewind("th1", id)).rejects.toBeInstanceOf(ChatRewindBusyError);
    expect((await engine.previewRewind("th1", id)).busy).toBe(true);
    await expect(workspace.readFile("a.txt")).resolves.toBe("agent");
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(2);
  });

  it("leaves a file changed outside the journal in place, reports it, and still cuts the thread", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original" },
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "agent");
    await workspace.writeFile("a.txt", "manual");
    const [id] = userIds();

    const result = await engine.rewind("th1", id);

    expect(result).toMatchObject({ files: "ok", conflicts: ["a.txt"], restored: [] });
    await expect(workspace.readFile("a.txt")).resolves.toBe("manual");
    expect(useChatStore.getState().threads.th1.messages).toEqual([]);
  });

  it("keeps a hand edit made before the message instead of reverting to the agent's earlier write", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup();
    await journaledWrite(journal, workspace, "a.txt", "agent");
    await workspace.writeFile("a.txt", "hand edit");
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "later");
    const [id] = userIds();

    const preview = await engine.previewRewind("th1", id);
    const result = await engine.rewind("th1", id);

    expect(preview.restore).toEqual(["a.txt"]);
    expect(result).toMatchObject({ restored: ["a.txt"], conflicts: [] });
    await expect(workspace.readFile("a.txt")).resolves.toBe("hand edit");
  });

  it("rewinds only the conversation when the thread moved to another folder", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original" },
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "agent");
    const [id] = userIds();
    const thread = useChatStore.getState().threads.th1;
    useChatStore.getState().setThread({ ...thread, workspaceName: "other" });

    const result = await engine.rewind("th1", id);

    expect(result).toMatchObject({ files: "folder-mismatch", restored: [], removed: [] });
    await expect(workspace.readFile("a.txt")).resolves.toBe("agent");
    expect(useChatStore.getState().threads.th1.messages).toEqual([]);
  });

  it("does not write into the live folder for a conversation that is not open", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original" },
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "agent");
    const [id] = userIds();
    useChatStore.getState().setActiveThread("th2");

    const result = await engine.rewind("th1", id);

    expect(result.files).toBe("no-workspace");
    await expect(workspace.readFile("a.txt")).resolves.toBe("agent");
    expect(useChatStore.getState().threads.th1.messages).toEqual([]);
  });

  it("rewinds a message sent before markers existed as a conversation-only rewind", async () => {
    const { engine, workspace } = rewindSetup({
      files: { "a.txt": "original" },
      messages: [user("u1", "legacy"), assistant("a1", "reply"), user("u2", "later")],
    });

    const result = await engine.rewind("th1", "u2");

    expect(result).toMatchObject({ files: "no-marker", text: "later", restored: [] });
    expect(useChatStore.getState().threads.th1.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
    ]);
    await expect(workspace.readFile("a.txt")).resolves.toBe("original");
  });

  it("keeps the thread intact and names what was restored when applying fails midway", async () => {
    const { engine, journal, workspace, userIds } = rewindSetup({
      files: { "a.txt": "original" },
    });
    await engine.sendTurn("th1", "first");
    await journaledWrite(journal, workspace, "a.txt", "agent");
    await journaledWrite(journal, workspace, "new.txt", "fresh");
    const [id] = userIds();
    vi.spyOn(workspace, "remove").mockRejectedValueOnce(new WorkspacePermissionError());

    const result = await engine.rewind("th1", id);

    expect(result).toMatchObject({
      restored: ["a.txt"],
      failed: { path: "new.txt" },
    });
    expect(useChatStore.getState().threads.th1.messages).toHaveLength(2);
  });

  it("rejects a message that is not a user message", async () => {
    const { engine } = rewindSetup({
      messages: [user("u1", "hi"), assistant("a1", "reply")],
    });

    await expect(engine.rewind("th1", "a1")).rejects.toThrow("user message");
  });
});
