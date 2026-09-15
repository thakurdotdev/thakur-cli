import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { list_dir } from "@harness/tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-list-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Windows file locks from child processes can delay cleanup
  }
});

function makeContext(): ToolContext {
  return {
    cwd: asAbsolutePath(realpathSync(dir)),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 50_000 }),
  };
}

describe("list_dir tool", () => {
  it("lists directories first (with slash) then files, alphabetically", async () => {
    writeFileSync(join(dir, "zeta.txt"), "x\n", "utf8");
    mkdirSync(join(dir, "beta"));
    writeFileSync(join(dir, "alpha.txt"), "x\n", "utf8");
    mkdirSync(join(dir, "kappa"));

    const result = await list_dir.execute({}, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = (result.data as string).split("\n");
      const headerIndex = lines.findIndex((line) => line.includes("entries"));
      const body = lines.slice(headerIndex + 1);
      expect(body).toEqual(["beta/", "kappa/", "alpha.txt", "zeta.txt"]);
    }
  });

  it("marks symlinks with @ and shows their target", async () => {
    const targetDir = join(dir, "target-dir");
    mkdirSync(targetDir);
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(targetDir, join(dir, "link"), symlinkType);

    const result = await list_dir.execute({}, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("target-dir/");
      expect(result.data).toContain("link@ -> ");
      expect(result.data).toContain("target-dir");
    }
  });

  it("reports an empty directory", async () => {
    const result = await list_dir.execute({}, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("empty directory");
    }
  });

  it("scopes to the given path in the header", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.ts"), "export {};\n", "utf8");

    const result = await list_dir.execute({ path: "src" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("src — 1 entries");
      expect(result.data).toContain("main.ts");
    }
  });

  it("fails with a hint when given a file path", async () => {
    writeFileSync(join(dir, "file.txt"), "x\n", "utf8");
    const result = await list_dir.execute({ path: "file.txt" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not a directory");
      expect(result.hint).toContain("read_file");
    }
  });

  it("fails for nonexistent directories", async () => {
    const result = await list_dir.execute({ path: "nope" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Could not list directory");
    }
  });

  it("rejects paths that escape the project root", async () => {
    const result = await list_dir.execute({ path: "../elsewhere" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escapes the project root");
    }
  });
});
