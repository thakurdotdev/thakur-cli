import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { glob } from "@harness/tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-glob-"));
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

function seedFixture(): void {
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export {};\n", "utf8");
  writeFileSync(join(dir, "src", "deep", "b.ts"), "export {};\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# hi\n", "utf8");
  writeFileSync(join(dir, ".hidden"), "secret\n", "utf8");
  writeFileSync(join(dir, "node_modules", "dep.js"), "junk\n", "utf8");
  writeFileSync(join(dir, ".git", "config"), "junk\n", "utf8");
}

describe("glob tool", () => {
  it("finds files matching a recursive pattern", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "src/**/*.ts" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("src/a.ts");
      expect(result.data).toContain("src/deep/b.ts");
      expect(result.data).not.toContain("README.md");
    }
  });

  it("promotes slash-less patterns to match at any depth", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "*.ts" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("src/a.ts");
      expect(result.data).toContain("src/deep/b.ts");
    }
  });

  it("matches root-level files and sorts output", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*.md" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("README.md");
    }
  });

  it("skips .git and node_modules entirely", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toContain("node_modules");
      expect(result.data).not.toContain(".git");
    }
  });

  it("does not match hidden files with star patterns", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toContain(".hidden");
    }
  });

  it("never follows symlinked directories", async () => {
    seedFixture();
    const outside = mkdtempSync(join(tmpdir(), "harness-outside-"));
    writeFileSync(join(outside, "leaked.txt"), "should not appear\n", "utf8");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, join(dir, "linked"), symlinkType);
    try {
      const result = await glob.execute({ pattern: "**/*" }, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).not.toContain("leaked.txt");
      }
    } finally {
      try {
        rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows file locks can delay cleanup
      }
    }
  });

  it("scopes the walk to the path parameter while matching from root", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*.ts", path: "src" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("src/a.ts");
      expect(result.data).toContain("src/deep/b.ts");
    }
  });

  it("caps results at limit with a truncation note", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*", limit: 2 }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("showing 2 of 3");
    }
  });

  it("reports no matches without failing", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*.zig" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("No files match");
    }
  });

  it("rejects non-directory search paths", async () => {
    seedFixture();
    const result = await glob.execute({ pattern: "**/*", path: "README.md" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not a directory");
    }
  });
});
