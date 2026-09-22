import { describe, expect, it } from "vitest";
import {
  WorkspaceConflictError,
  WorkspaceInvalidInputError,
  WorkspaceLimitError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspacePermissionError,
} from "./errors";
import { createFakeWorkspace } from "./fake-handle";
import type { WorkspaceFs } from "./fs";
import {
  createWorkspaceFs,
  readWorkspaceBlob,
  resolveSegments,
  sanitizeUploadName,
  uniqueUploadPath,
  writeWorkspaceBlob,
} from "./fs";
import { createInlineSearchRunner } from "./search-runner";

function buildFs(initial: Record<string, string> = {}, sizeCap?: number) {
  const fake = createFakeWorkspace(initial);
  const ref: { fs?: WorkspaceFs } = {};
  const searchRunner = createInlineSearchRunner({
    list: (path, options) => (ref.fs as WorkspaceFs).list(path, options),
    readFile: (path) => (ref.fs as WorkspaceFs).readFile(path),
  });
  const fs = createWorkspaceFs(fake.handle, {
    ...(sizeCap === undefined ? {} : { sizeCap }),
    searchRunner,
  });
  ref.fs = fs;
  return { fake, fs };
}

describe("resolveSegments", () => {
  it("accepts a nested relative path", () => {
    expect(resolveSegments("docs/nested/readme.md")).toEqual([
      "docs",
      "nested",
      "readme.md",
    ]);
  });

  it("resolves dot segments against the workspace root", () => {
    expect(resolveSegments(".")).toEqual([]);
    expect(resolveSegments("./")).toEqual([]);
    expect(resolveSegments("a/./b")).toEqual(["a", "b"]);
  });

  it("rejects every path-escape class", () => {
    for (const path of [
      "/abs",
      "../x",
      "..",
      "a/../b",
      "a\\..\\b",
      "C:\\x",
      "\\\\server\\share",
      "nul\0",
    ]) {
      expect(() => resolveSegments(path), path).toThrow(WorkspacePathError);
    }
  });
});

describe("WorkspaceFs", () => {
  it("reads a nested file", async () => {
    const fake = createFakeWorkspace({ "docs/readme.md": "hello" });
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.readFile("docs/readme.md")).resolves.toBe("hello");
  });

  it("writes a file and creates its parent directories", async () => {
    const fake = createFakeWorkspace();
    const fs = createWorkspaceFs(fake.handle);

    await fs.writeFile("a/b/c.txt", "content");
    await expect(fs.readFile("a/b/c.txt")).resolves.toBe("content");
    await expect(fs.list("a/b")).resolves.toMatchObject([
      { name: "c.txt", kind: "file" },
    ]);
  });

  it("lists entries sorted by name", async () => {
    const fake = createFakeWorkspace({
      "root/zeta.txt": "z",
      "root/alpha.txt": "a",
    });
    const fs = createWorkspaceFs(fake.handle);
    const names = (await fs.list("root")).map((entry) => entry.name);
    expect(names).toEqual(["alpha.txt", "zeta.txt"]);
  });

  it("lists nested entries recursively with root-relative paths", async () => {
    const fake = createFakeWorkspace({
      "root/a.txt": "a",
      "root/sub/b.ts": "b",
    });
    const fs = createWorkspaceFs(fake.handle);
    const paths = (await fs.list("root", { recursive: true })).map(
      (entry) => entry.path,
    );
    expect(paths).toEqual(["root/a.txt", "root/sub", "root/sub/b.ts"]);
  });

  it("filters a list with a glob", async () => {
    const fake = createFakeWorkspace({
      "root/a.txt": "a",
      "root/sub/b.ts": "b",
    });
    const fs = createWorkspaceFs(fake.handle);
    const paths = (
      await fs.list("root", { recursive: true, glob: "**/*.ts" })
    ).map((entry) => entry.path);
    expect(paths).toEqual(["root/sub/b.ts"]);
  });

  it("truncates the walk at maxEntries", async () => {
    const fake = createFakeWorkspace({
      "root/a.txt": "a",
      "root/b.txt": "b",
      "root/c.txt": "c",
    });
    const fs = createWorkspaceFs(fake.handle);
    const entries = await fs.list("root", { recursive: true, maxEntries: 2 });
    expect(entries).toHaveLength(2);
  });

  it("lists the workspace root for a dot path", async () => {
    const fake = createFakeWorkspace({ "root/a.txt": "a" });
    const fs = createWorkspaceFs(fake.handle);
    const paths = (await fs.list(".", { recursive: true })).map(
      (entry) => entry.path,
    );
    expect(paths).toEqual(["root", "root/a.txt"]);
  });

  it("rejects a traversal path with options supplied", async () => {
    const fake = createFakeWorkspace();
    const fs = createWorkspaceFs(fake.handle);
    await expect(
      fs.list("../secret", { recursive: true }),
    ).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it("rejects a denied handle with options supplied", async () => {
    const fake = createFakeWorkspace({ "root/a.txt": "a" });
    fake.setPermission("denied");
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.list("root", { recursive: true })).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
  });

  it("creates a directory", async () => {
    const fake = createFakeWorkspace();
    const fs = createWorkspaceFs(fake.handle);
    await fs.makeDir("notes");
    await expect(fs.stat("notes")).resolves.toEqual({
      path: "notes",
      kind: "directory",
      size: 0,
    });
  });

  it("removes a directory recursively", async () => {
    const fake = createFakeWorkspace({ "a/b/c.txt": "deep" });
    const fs = createWorkspaceFs(fake.handle);
    await fs.remove("a");
    await expect(fs.list("")).resolves.toEqual([]);
  });

  it("reports a missing entry", async () => {
    const fake = createFakeWorkspace();
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.readFile("missing.txt")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });

  it("enforces the read size cap", async () => {
    const fake = createFakeWorkspace({ "big.txt": "0123456789" });
    const fs = createWorkspaceFs(fake.handle, { sizeCap: 5 });
    await expect(fs.readFile("big.txt")).rejects.toBeInstanceOf(
      WorkspaceLimitError,
    );
  });

  it("enforces the write size cap before touching the handle", async () => {
    const fake = createFakeWorkspace();
    const fs = createWorkspaceFs(fake.handle, { sizeCap: 5 });
    await expect(fs.writeFile("big.txt", "0123456789")).rejects.toBeInstanceOf(
      WorkspaceLimitError,
    );
  });

  it("stats a file with its byte size", async () => {
    const fake = createFakeWorkspace({ "f.txt": "abc" });
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.stat("f.txt")).resolves.toEqual({
      path: "f.txt",
      kind: "file",
      size: 3,
    });
  });

  it("maps a denied permission to WorkspacePermissionError", async () => {
    const fake = createFakeWorkspace({ "f.txt": "abc" });
    fake.setPermission("denied");
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.ensurePermission("read")).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
    await expect(fs.readFile("f.txt")).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
  });

  it("maps a prompt permission to WorkspacePermissionError", async () => {
    const fake = createFakeWorkspace({ "f.txt": "abc" });
    fake.setPermission("prompt");
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.list("")).rejects.toBeInstanceOf(WorkspacePermissionError);
  });

  it("rejects a traversal path before touching the handle", async () => {
    const fake = createFakeWorkspace();
    const fs = createWorkspaceFs(fake.handle);
    await expect(fs.readFile("../secret")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(fs.writeFile("a\\..\\b", "x")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });
});

describe("WorkspaceFs.list exclusions", () => {
  it("spends the entry budget on what is left after the exclusions", async () => {
    const seeded: Record<string, string> = { "src/a.ts": "x" };
    // `node_modules` sorts first, so a walk that entered it would spend the
    // whole budget there and never reach `src/`.
    for (let index = 0; index < 1200; index += 1) {
      seeded[`node_modules/pkg/f${index}.js`] = "x";
    }
    const { fs } = buildFs(seeded);

    const unfiltered = await fs.list("", { recursive: true });
    expect(unfiltered.some((entry) => entry.path === "src/a.ts")).toBe(false);

    const filtered = await fs.list("", {
      recursive: true,
      excludeDirs: ["node_modules"],
    });
    expect(filtered.map((entry) => entry.path)).toEqual(["src", "src/a.ts"]);
  });

  it("skips dot-directories without hiding dotfiles", async () => {
    const { fs } = buildFs({
      ".cache/data.json": "x",
      ".gitignore": "dist",
      "src/a.ts": "x",
    });
    const entries = await fs.list("", {
      recursive: true,
      excludeDotDirs: true,
    });
    expect(entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "src",
      "src/a.ts",
    ]);
  });
});

describe("WorkspaceFs.search", () => {
  it("finds a pattern in a nested file with a 1-based line", async () => {
    const { fs } = buildFs({
      "root/a.txt": "hello world",
      "root/sub/b.txt": "world",
    });
    const result = await fs.search({ pattern: "world" });
    expect(result.hits).toEqual([
      { path: "root/a.txt", line: 1, text: "hello world" },
      { path: "root/sub/b.txt", line: 1, text: "world" },
    ]);
  });

  it("skips a file above the size cap and still returns other hits", async () => {
    const { fs } = buildFs(
      { "root/big.txt": "worldworld", "root/a.txt": "world" },
      5,
    );
    const result = await fs.search({ pattern: "world" });
    expect(result.filesSkipped).toBe(1);
    expect(result.hits.map((hit) => hit.path)).toEqual(["root/a.txt"]);
  });

  it("stops at maxResults and reports truncation", async () => {
    const { fs } = buildFs({ "root/a.txt": "world", "root/b.txt": "world" });
    const result = await fs.search({ pattern: "world", maxResults: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("stops at maxFilesScanned and reports truncation", async () => {
    const { fs } = buildFs({ "root/a.txt": "world", "root/b.txt": "world" });
    await expect(
      fs.search({ pattern: "world", maxFilesScanned: 1 }),
    ).resolves.toMatchObject({
      truncated: true,
    });
  });

  it("stops at maxDepth and reports truncation", async () => {
    const { fs } = buildFs({ "a/b/c.txt": "world" });
    await expect(
      fs.search({ pattern: "world", maxDepth: 0 }),
    ).resolves.toMatchObject({
      hits: [],
      truncated: true,
    });
  });
});

describe("WorkspaceFs.move and copy", () => {
  it("copies a file and leaves the source", async () => {
    const { fs } = buildFs({ "a.txt": "hello" });
    await expect(fs.copy("a.txt", "b.txt")).resolves.toEqual({
      from: "a.txt",
      to: "b.txt",
      kind: "file",
      size: 5,
    });
    await expect(fs.readFile("a.txt")).resolves.toBe("hello");
    await expect(fs.readFile("b.txt")).resolves.toBe("hello");
  });

  it("moves a file and removes the source", async () => {
    const { fs } = buildFs({ "a.txt": "hello" });
    await fs.move("a.txt", "dir/b.txt");
    await expect(fs.readFile("dir/b.txt")).resolves.toBe("hello");
    await expect(fs.readFile("a.txt")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });

  it("copies a directory tree including an empty directory", async () => {
    const { fake, fs } = buildFs({ "src/a.txt": "hello" });
    fake.makeNode("src/empty");
    await fs.copy("src", "dst");
    const paths = (await fs.list("dst", { recursive: true })).map(
      (entry) => entry.path,
    );
    expect(paths).toEqual(["dst/a.txt", "dst/empty"]);
  });

  it("moves a directory tree", async () => {
    const { fs } = buildFs({ "src/a.txt": "hello" });
    await fs.move("src", "dst");
    await expect(fs.readFile("dst/a.txt")).resolves.toBe("hello");
    await expect(fs.stat("src")).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("fails closed with conflict on an existing destination", async () => {
    const { fs } = buildFs({ "a.txt": "a", "b.txt": "b" });
    await expect(fs.copy("a.txt", "b.txt")).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );
    await expect(fs.move("a.txt", "b.txt")).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );
    await expect(fs.readFile("a.txt")).resolves.toBe("a");
    await expect(fs.readFile("b.txt")).resolves.toBe("b");
  });

  it("rejects a self or descendant destination before any write", async () => {
    const { fs } = buildFs({ "a/inner.txt": "x" });
    await expect(fs.move("a", "a")).rejects.toBeInstanceOf(
      WorkspaceInvalidInputError,
    );
    await expect(fs.move("a", "a/b")).rejects.toBeInstanceOf(
      WorkspaceInvalidInputError,
    );
    await expect(fs.copy("a", "a/b")).rejects.toBeInstanceOf(
      WorkspaceInvalidInputError,
    );
    await expect(fs.readFile("a/inner.txt")).resolves.toBe("x");
  });

  it("copies a file above the text size cap byte-for-byte", async () => {
    const content = "0123456789";
    const { fake, fs } = buildFs({ "big.txt": content }, 5);
    await fs.copy("big.txt", "copy.txt");
    const uncapped = createWorkspaceFs(fake.handle);
    await expect(uncapped.readFile("copy.txt")).resolves.toBe(content);
  });

  it("rejects traversal paths for either argument", async () => {
    const { fs } = buildFs({ "a.txt": "x" });
    await expect(fs.move("..", "b.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(fs.copy("a.txt", "a\\..\\b")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(fs.copy("C:\\x", "b.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it("rejects when the handle permission is denied", async () => {
    const { fake, fs } = buildFs({ "a.txt": "x" });
    fake.setPermission("denied");
    await expect(fs.copy("a.txt", "b.txt")).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
    await expect(fs.move("a.txt", "b.txt")).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
  });
});

describe("readWorkspaceBlob", () => {
  it("returns the file as a blob without decoding it as text", async () => {
    const { fs } = buildFs({ "assets/pixel.png": "hello" });
    const blob = await readWorkspaceBlob(fs, "assets/pixel.png");
    expect(blob.size).toBe(5);
    await expect(blob.text()).resolves.toBe("hello");
  });

  it("rejects a missing file", async () => {
    const { fs } = buildFs();
    await expect(readWorkspaceBlob(fs, "missing.png")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });

  it("rejects a file above the byte cap", async () => {
    const { fs } = buildFs({ "big.png": "hello" });
    await expect(
      readWorkspaceBlob(fs, "big.png", { maxBytes: 2 }),
    ).rejects.toBeInstanceOf(WorkspaceLimitError);
  });

  it("rejects traversal and empty paths", async () => {
    const { fs } = buildFs({ "a.png": "x" });
    await expect(readWorkspaceBlob(fs, "../secret.png")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(readWorkspaceBlob(fs, "")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it("rejects when the handle permission is denied", async () => {
    const { fake, fs } = buildFs({ "a.png": "x" });
    fake.setPermission("denied");
    await expect(readWorkspaceBlob(fs, "a.png")).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
  });
});

describe("sanitizeUploadName", () => {
  it("reduces a hostile name to one safe segment", () => {
    expect(sanitizeUploadName("../x\n</attached>.txt")).toBe("attached.txt");
    expect(sanitizeUploadName("x\n</attached>.txt")).toBe("attached.txt");
    expect(sanitizeUploadName("..")).toBe("upload");
    expect(sanitizeUploadName("")).toBe("upload");
    expect(sanitizeUploadName(".env")).toBe("env");
    expect(sanitizeUploadName("a/b/c/report final.csv")).toBe(
      "report final.csv",
    );
    // A non-Latin name keeps its characters and, crucially, its extension:
    // stripping it would leave the file unclassifiable.
    expect(sanitizeUploadName("báo cáo.pdf")).toBe("báo cáo.pdf");
  });

  it("caps the stem while keeping the extension", () => {
    const name = `${"a".repeat(200)}.png`;
    const safe = sanitizeUploadName(name);
    expect(safe.endsWith(".png")).toBe(true);
    expect(safe.length).toBe(84);
  });
});

describe("writeWorkspaceBlob", () => {
  it("round-trips bytes that are not valid UTF-8", async () => {
    const { fs } = buildFs();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff]);
    await writeWorkspaceBlob(fs, "uploads/pixel.png", new Blob([bytes]));
    const blob = await readWorkspaceBlob(fs, "uploads/pixel.png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a blob over the cap without creating the file", async () => {
    const { fs } = buildFs();
    await expect(
      writeWorkspaceBlob(fs, "uploads/big.bin", new Blob(["hello"]), {
        maxBytes: 2,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLimitError);
    await expect(fs.stat("uploads/big.bin")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });

  it("rejects traversal, empty paths, and denied permission", async () => {
    const { fake, fs } = buildFs();
    await expect(
      writeWorkspaceBlob(fs, "../escape.png", new Blob(["x"])),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(
      writeWorkspaceBlob(fs, "", new Blob(["x"])),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    fake.setPermission("denied");
    await expect(
      writeWorkspaceBlob(fs, "uploads/a.png", new Blob(["x"])),
    ).rejects.toBeInstanceOf(WorkspacePermissionError);
  });
});

describe("uniqueUploadPath", () => {
  it("suffixes a taken name", async () => {
    const { fs } = buildFs({ "uploads/a.png": "x" });
    await expect(uniqueUploadPath(fs, "uploads", "b.png")).resolves.toBe(
      "uploads/b.png",
    );
    await expect(uniqueUploadPath(fs, "uploads", "a.png")).resolves.toBe(
      "uploads/a-1.png",
    );
  });

  it("sanitizes the name before probing", async () => {
    const { fs } = buildFs();
    await expect(uniqueUploadPath(fs, "uploads", "../a b*.png")).resolves.toBe(
      "uploads/a b.png",
    );
  });

  it("throws once every suffix is taken", async () => {
    const seeded: Record<string, string> = { "uploads/a.png": "x" };
    for (let index = 1; index < 100; index += 1) {
      seeded[`uploads/a-${index}.png`] = "x";
    }
    const { fs } = buildFs(seeded);
    await expect(
      uniqueUploadPath(fs, "uploads", "a.png"),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
  });
});
