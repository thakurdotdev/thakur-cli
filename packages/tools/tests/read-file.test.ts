import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { read_file } from "@harness/tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-read-"));
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

describe("read_file tool", () => {
  it("returns numbered lines with a header and file size metadata", async () => {
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const result = await read_file.execute({ path: "a.txt" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("a.txt — lines 1-3 of 3");
      expect(result.data).toContain("B)");
      expect(result.data).toContain("     1\talpha");
      expect(result.data).toContain("     3\tgamma");
    }
  });

  it("supports offset/limit slicing", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
    writeFileSync(join(dir, "b.txt"), content, "utf8");
    const result = await read_file.execute({ path: "b.txt", offset: 4, limit: 3 }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("lines 4-6 of 10");
      expect(result.data).toContain("line-4");
      expect(result.data).toContain("line-6");
      expect(result.data).not.toContain("line-7");
    }
  });

  it("errors for missing files with an actionable hint", async () => {
    const result = await read_file.execute({ path: "missing.txt" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Could not read");
    }
  });

  it("refuses paths outside the project root", async () => {
    const result = await read_file.execute(
      { path: join(tmpdir(), "..", "..", "etc", "passwd") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escapes the project root");
    }
  });

  it("marks the file as read for the edit tracker", async () => {
    writeFileSync(join(dir, "c.txt"), "content\n", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "c.txt" }, context);
    expect(context.readTracker.wasRead(realpathSync(join(dir, "c.txt")))).toBe(true);
  });

  it("truncates very large files via the truncator", async () => {
    writeFileSync(join(dir, "big.txt"), "z".repeat(100_000), "utf8");
    const context: ToolContext = {
      ...makeContext(),
      truncator: createTruncator({ maxChars: 2_000 }),
    };
    const result = await read_file.execute({ path: "big.txt" }, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as string;
      expect(data).toContain("output truncated");
      expect(data.length).toBeLessThan(4_000);
    }
  });
});
