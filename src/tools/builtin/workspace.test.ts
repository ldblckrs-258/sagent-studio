import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { createFakeWorkspace } from "../../workspace/fake-handle";
import type { WorkspaceFs } from "../../workspace/fs";
import { createWorkspaceFs } from "../../workspace/fs";
import { createInlineSearchRunner } from "../../workspace/search-runner";
import { ToolRegistry } from "../registry";
import { ToolRuntimeUnavailableError } from "../types";
import { workspaceToolProvider } from "./workspace";

const CALL = { toolCallId: "call-1", messages: [], context: {} };

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute;
  if (!execute) throw new Error(`missing execute for ${name}`);
  return execute;
}

async function build(initial: Record<string, string> = {}) {
  const fake = createFakeWorkspace(initial);
  const ref: { fs?: WorkspaceFs } = {};
  const searchRunner = createInlineSearchRunner({
    list: (path, options) => (ref.fs as WorkspaceFs).list(path, options),
    readFile: (path) => (ref.fs as WorkspaceFs).readFile(path),
  });
  const workspace = createWorkspaceFs(fake.handle, { searchRunner });
  ref.fs = workspace;
  const registry = new ToolRegistry();
  registry.registerProvider(workspaceToolProvider);
  return { fake, toolSet: registry.buildToolSet(undefined, { workspace }) };
}

describe("workspaceToolProvider", () => {
  it("is unavailable without a workspace port", () => {
    expect(workspaceToolProvider.isAvailable({})).toBe(false);
    expect(
      workspaceToolProvider.isAvailable({
        workspace: createWorkspaceFs(createFakeWorkspace().handle),
      }),
    ).toBe(true);
    expect(() => workspaceToolProvider.create("read_file", {})).toThrow(
      ToolRuntimeUnavailableError,
    );
  });

  it("contributes the twelve system tools", async () => {
    const { toolSet } = await build();
    expect(Object.keys(toolSet)).toEqual([
      "copy",
      "edit_file",
      "file_info",
      "find_lines",
      "list_dir",
      "make_dir",
      "move",
      "read_file",
      "remove",
      "search",
      "stat",
      "write_file",
    ]);
  });

  it("reads and writes through the workspace", async () => {
    const { toolSet } = await build({ "notes.txt": "original" });
    await expect(
      executor(toolSet, "read_file")({ path: "notes.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      code: "ok",
      value: {
        path: "notes.txt",
        content: "original",
        totalLines: 1,
        returnedLines: 1,
        truncated: false,
      },
    });

    await expect(
      executor(toolSet, "write_file")(
        { path: "deep/new.txt", content: "hi" },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: true,
      code: "ok",
      value: { path: "deep/new.txt", bytes: 2 },
    });
    await expect(
      executor(toolSet, "read_file")({ path: "deep/new.txt" }, CALL),
    ).resolves.toMatchObject({
      value: { path: "deep/new.txt", content: "hi" },
    });
  });

  it("returns exactly the requested line window", async () => {
    const { toolSet } = await build({ "lines.txt": "one\ntwo\nthree" });
    await expect(
      executor(toolSet, "read_file")(
        { path: "lines.txt", offset: 2, limit: 1 },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: "two",
        totalLines: 3,
        returnedLines: 1,
        offset: 2,
        truncated: true,
      },
    });
  });

  it("makes a directory and lists it", async () => {
    const { toolSet } = await build();
    await executor(toolSet, "make_dir")({ path: "notes" }, CALL);
    await expect(
      executor(toolSet, "list_dir")({}, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        path: "",
        entries: [{ name: "notes", path: "notes", kind: "directory" }],
        truncated: false,
      },
    });
  });

  it("treats a dot path as the workspace root", async () => {
    const { toolSet } = await build({ "notes.txt": "n" });
    await expect(
      executor(toolSet, "list_dir")({ path: "." }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        path: ".",
        entries: [{ name: "notes.txt", path: "notes.txt", kind: "file" }],
      },
    });
    await expect(
      executor(toolSet, "read_file")({ path: "." }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "path_rejected",
      message: 'The workspace path "." is not allowed.',
    });
  });

  it("lists recursively and filters with glob", async () => {
    const { toolSet } = await build({
      "root/a.txt": "a",
      "root/sub/b.ts": "b",
      "root/sub/c.md": "c",
    });
    const nested = await executor(toolSet, "list_dir")(
      { path: "root", recursive: true },
      CALL,
    );
    expect(nested).toMatchObject({ ok: true });
    expect(
      (
        nested as { value: { entries: Array<{ path: string }> } }
      ).value.entries.map((e) => e.path),
    ).toEqual(["root/a.txt", "root/sub", "root/sub/b.ts", "root/sub/c.md"]);

    await expect(
      executor(toolSet, "list_dir")(
        { path: "root", recursive: true, glob: "**/*.ts" },
        CALL,
      ),
    ).resolves.toMatchObject({
      value: {
        entries: [{ name: "b.ts", path: "root/sub/b.ts", kind: "file" }],
      },
    });
  });

  it("reports truncated when maxEntries stops the walk", async () => {
    const { toolSet } = await build({
      "root/a.txt": "a",
      "root/b.txt": "b",
      "root/c.txt": "c",
    });
    await expect(
      executor(toolSet, "list_dir")(
        { path: "root", recursive: true, maxEntries: 2 },
        CALL,
      ),
    ).resolves.toMatchObject({ value: { truncated: true } });
  });

  it("stats an entry", async () => {
    const { toolSet } = await build({ "f.txt": "abc" });
    await expect(
      executor(toolSet, "stat")({ path: "f.txt" }, CALL),
    ).resolves.toEqual({
      ok: true,
      code: "ok",
      value: { path: "f.txt", kind: "file", size: 3 },
    });
  });

  it("reports file metadata including line and character counts", async () => {
    const { toolSet } = await build({ "code.ts": "const a = 1\n\nconst b = 2" });
    await expect(
      executor(toolSet, "file_info")({ path: "code.ts" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      code: "ok",
      value: {
        path: "code.ts",
        kind: "file",
        size: 24,
        extension: "ts",
        lines: 3,
        nonEmptyLines: 2,
        characters: 24,
      },
    });
  });

  it("reports directory metadata without line counts", async () => {
    const { toolSet } = await build({ "notes/a.txt": "a" });
    await expect(
      executor(toolSet, "file_info")({ path: "notes" }, CALL),
    ).resolves.toEqual({
      ok: true,
      code: "ok",
      value: { path: "notes", kind: "directory", size: 0 },
    });
  });

  it("removes an entry", async () => {
    const { toolSet } = await build({ "gone.txt": "x" });
    await expect(
      executor(toolSet, "remove")({ path: "gone.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      code: "ok",
      value: { path: "gone.txt", removed: true },
    });
    await expect(
      executor(toolSet, "list_dir")({}, CALL),
    ).resolves.toMatchObject({
      value: { path: "", entries: [] },
    });
  });

  it("returns a structured failure for a traversal path without rejecting", async () => {
    const { toolSet } = await build();
    await expect(
      executor(toolSet, "read_file")({ path: "../escape" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "path_rejected",
    });
  });

  it("returns a structured failure for a missing file without rejecting", async () => {
    const { toolSet } = await build();
    await expect(
      executor(toolSet, "read_file")({ path: "missing.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("edits a unique match and rewrites the file", async () => {
    const { toolSet } = await build({ "a.txt": "one two three" });
    await expect(
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "two", new_string: "TWO" },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: true,
      code: "ok",
      value: { path: "a.txt", replacements: 1, linesChanged: [1] },
    });
    await expect(
      executor(toolSet, "read_file")({ path: "a.txt" }, CALL),
    ).resolves.toMatchObject({
      value: { content: "one TWO three" },
    });
  });

  it("fails edit_file on multiple matches and leaves the file unchanged", async () => {
    const { toolSet } = await build({ "a.txt": "x\nx" });
    await expect(
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "x", new_string: "y" },
        CALL,
      ),
    ).resolves.toMatchObject({ ok: false, code: "multiple_matches" });
    await expect(
      executor(toolSet, "read_file")({ path: "a.txt" }, CALL),
    ).resolves.toMatchObject({
      value: { content: "x\nx" },
    });
  });

  it("replaces every match when replace_all is set", async () => {
    const { toolSet } = await build({ "a.txt": "x\nx" });
    await expect(
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
        CALL,
      ),
    ).resolves.toMatchObject({ ok: true, value: { replacements: 2 } });
    await expect(
      executor(toolSet, "read_file")({ path: "a.txt" }, CALL),
    ).resolves.toMatchObject({
      value: { content: "y\ny" },
    });
  });

  it("reports not_found when editing a missing file", async () => {
    const { toolSet } = await build();
    await expect(
      executor(toolSet, "edit_file")(
        { path: "missing.txt", old_string: "a", new_string: "b" },
        CALL,
      ),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
  });

  it("searches the workspace and returns hits with a truncation flag", async () => {
    const { toolSet } = await build({
      "root/a.txt": "hello world",
      "root/b.txt": "world",
    });
    await expect(
      executor(toolSet, "search")({ pattern: "world" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        filesScanned: 2,
        truncated: false,
        hits: [
          { path: "root/a.txt", line: 1, text: "hello world" },
          { path: "root/b.txt", line: 1, text: "world" },
        ],
      },
    });
  });

  it("returns invalid_input for an invalid search pattern", async () => {
    const { toolSet } = await build({ "a.txt": "hello" });
    await expect(
      executor(toolSet, "search")({ pattern: "(" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("returns invalid_input for a catastrophic search pattern", async () => {
    const { toolSet } = await build({ "a.txt": "hello" });
    await expect(
      executor(toolSet, "search")({ pattern: "(a+)+" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("rejects a file as the search path and points at find_lines", async () => {
    const { toolSet } = await build({ "a.txt": "hello" });
    await expect(
      executor(toolSet, "search")({ pattern: "hello", path: "a.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
      hint: expect.stringContaining("find_lines"),
    });
  });

  it("skips vendor directories by default and can include them", async () => {
    const { toolSet } = await build({
      "src/a.txt": "needle",
      "node_modules/pkg/b.txt": "needle",
    });
    await expect(
      executor(toolSet, "search")({ pattern: "needle" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: { hits: [{ path: "src/a.txt" }] },
    });
    const included = await executor(toolSet, "search")(
      { pattern: "needle", include_excluded: true },
      CALL,
    );
    expect(
      (included as { value: { hits: Array<{ path: string }> } }).value.hits
        .map((hit) => hit.path)
        .sort(),
    ).toEqual(["node_modules/pkg/b.txt", "src/a.txt"]);
  });

  it("moves and copies entries and reports conflict on an existing destination", async () => {
    const { toolSet } = await build({ "a.txt": "hello", "b.txt": "other" });
    await expect(
      executor(toolSet, "copy")({ from: "a.txt", to: "c.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: { from: "a.txt", to: "c.txt", kind: "file", size: 5 },
    });
    await expect(
      executor(toolSet, "move")({ from: "c.txt", to: "d.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: { from: "c.txt", to: "d.txt" },
    });
    await expect(
      executor(toolSet, "move")({ from: "d.txt", to: "b.txt" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("rejects a descendant destination with invalid_input", async () => {
    const { toolSet } = await build({ "a/inner.txt": "x" });
    await expect(
      executor(toolSet, "move")({ from: "a", to: "a/b" }, CALL),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("serializes concurrent edits to one path so no write is lost", async () => {
    const { toolSet } = await build({ "a.txt": "alpha\nbeta\ngamma" });
    await Promise.all([
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "alpha", new_string: "ALPHA" },
        CALL,
      ),
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "gamma", new_string: "GAMMA" },
        CALL,
      ),
    ]);
    await expect(
      executor(toolSet, "read_file")({ path: "a.txt" }, CALL),
    ).resolves.toMatchObject({
      value: { content: "ALPHA\nbeta\nGAMMA" },
    });
  });

  it("reads the post-edit content when both calls are issued in one step", async () => {
    const { toolSet } = await build({ "a.txt": "EPSILON Y" });
    const edit = executor(toolSet, "edit_file")(
      { path: "a.txt", old_string: "EPSILON Y", new_string: "EPSILON W" },
      CALL,
    );
    const read = executor(toolSet, "read_file")({ path: "a.txt" }, CALL);
    const [, result] = await Promise.all([edit, read]);
    expect(result).toMatchObject({ value: { content: "EPSILON W" } });
  });

  it("reads the destination of a move issued in the same step", async () => {
    const { toolSet } = await build({ "a.txt": "alpha" });
    const move = executor(toolSet, "move")({ from: "a.txt", to: "b.txt" }, CALL);
    const read = executor(toolSet, "read_file")({ path: "b.txt" }, CALL);
    const [, result] = await Promise.all([move, read]);
    expect(result).toMatchObject({ ok: true, value: { content: "alpha" } });
  });

  it("applies a batch of hunks atomically against one revision", async () => {
    const { toolSet } = await build({ "a.txt": "one two three four" });
    await expect(
      executor(toolSet, "edit_file")(
        {
          path: "a.txt",
          edits: [
            { old_string: "one", new_string: "1" },
            { old_string: "three", new_string: "3" },
          ],
        },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { applied: true, replacements: 2 },
    });
    await expect(
      executor(toolSet, "read_file")({ path: "a.txt" }, CALL),
    ).resolves.toMatchObject({ value: { content: "1 two 3 four" } });
  });

  it("leaves the file unchanged when one hunk in a batch fails", async () => {
    const { toolSet } = await build({ "a.txt": "one two" });
    await expect(
      executor(toolSet, "edit_file")(
        {
          path: "a.txt",
          edits: [
            { old_string: "one", new_string: "1" },
            { old_string: "missing", new_string: "x" },
          ],
        },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "no_match",
      value: { failedIndex: 1 },
    });
    await expect(
      executor(toolSet, "read_file")({ path: "a.txt" }, CALL),
    ).resolves.toMatchObject({ value: { content: "one two" } });
  });

  it("reports already_satisfied when the new text is already present", async () => {
    const { toolSet } = await build({ "a.txt": "hello world" });
    await expect(
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "goodbye", new_string: "world" },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { applied: false, replacements: 0, reason: "already_satisfied" },
    });
  });

  it("treats a fully applied hunk batch as already_satisfied", async () => {
    const { toolSet } = await build({ "a.txt": "BETA GAMMA" });
    await expect(
      executor(toolSet, "edit_file")(
        {
          path: "a.txt",
          edits: [
            { old_string: "beta", new_string: "BETA" },
            { old_string: "gamma", new_string: "GAMMA" },
          ],
        },
        CALL,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { applied: false, replacements: 0, reason: "already_satisfied" },
    });
  });

  it("rejects a stale write when expect_revision does not match", async () => {
    const { toolSet } = await build({ "a.txt": "hello" });
    await expect(
      executor(toolSet, "edit_file")(
        { path: "a.txt", old_string: "hello", new_string: "hi", expect_revision: "deadbeef" },
        CALL,
      ),
    ).resolves.toMatchObject({ ok: false, code: "stale_write" });
  });

  it("returns a content revision and optional line gutter on read", async () => {
    const { toolSet } = await build({ "a.txt": "a\nb\nc" });
    const read = await executor(toolSet, "read_file")(
      { path: "a.txt", offset: 2, limit: 1, line_numbers: true },
      CALL,
    );
    expect(read).toMatchObject({
      ok: true,
      value: {
        content: "2: b",
        firstLine: 2,
        lastLine: 2,
      },
    });
    expect(typeof (read as { value: { revision: string } }).value.revision).toBe("string");
  });

  it("finds lines in a file without loading it whole", async () => {
    const { toolSet } = await build({ "big.txt": "alpha\nbeta\ngamma" });
    await expect(
      executor(toolSet, "find_lines")({ path: "big.txt", pattern: "beta" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: { path: "big.txt", hits: [{ path: "big.txt", line: 2, text: "beta" }] },
    });
  });

  it("finds a multibyte character that straddles the chunk boundary", async () => {
    const prefix = "a".repeat(1024 * 1024 - 1);
    const { toolSet } = await build({ "big.txt": `${prefix}\u20ac\nsecond` });
    await expect(
      executor(toolSet, "find_lines")({ path: "big.txt", pattern: "\u20ac" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: { hits: [{ path: "big.txt", line: 1 }] },
    });
  });

  it("reports why search files were skipped instead of returning a bare empty result", async () => {
    const { toolSet } = await build({
      "bin.txt": "a\u0000world",
      "clean.txt": "world",
    });
    await expect(
      executor(toolSet, "search")({ pattern: "world" }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        filesSkipped: 1,
        skipped: [{ path: "bin.txt", reason: expect.stringContaining("binary") }],
      },
    });
  });
});
