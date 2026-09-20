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
import { defaultSettings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import type { EngineDeps } from "./engine";
import { createEngine } from "./engine";
import { abortersCount, useChatStore } from "./store";
import type { ChatMode, ChatThread } from "./types";
import { defaultThreadConfig } from "./types";

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
