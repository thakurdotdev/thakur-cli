import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { read_file, write_file } from "@harness/tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-write-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeContext(): ToolContext {
  return {
    cwd: asAbsolutePath(realpathSync(dir)),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 50_000 }),
  };
}

describe("write_file tool", () => {
  it("creates new files, including parent directories", async () => {
    const result = await write_file.execute(
      { path: "nested/dir/created.txt", content: "created" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { created: boolean; bytes: number };
      expect(data.created).toBe(true);
      expect(data.bytes).toBe(7);
    }
    expect(readFileSync(join(dir, "nested", "dir", "created.txt"), "utf8")).toBe("created");
  });

  it("refuses overwriting an existing file that was not read first", async () => {
    writeFileSync(join(dir, "exists.txt"), "original", "utf8");
    const result = await write_file.execute(
      { path: "exists.txt", content: "overwritten" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("has not been read");
    }
    expect(readFileSync(join(dir, "exists.txt"), "utf8")).toBe("original");
  });

  it("allows overwriting after the file was read", async () => {
    writeFileSync(join(dir, "exists.txt"), "original", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "exists.txt" }, context);
    const result = await write_file.execute(
      { path: "exists.txt", content: "overwritten" },
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { created: boolean };
      expect(data.created).toBe(false);
    }
    expect(readFileSync(join(dir, "exists.txt"), "utf8")).toBe("overwritten");
  });

  it("refuses writes outside the project root", async () => {
    const result = await write_file.execute(
      { path: "../outside.txt", content: "escaped" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escapes the project root");
    }
    expect(existsSync(join(dir, "..", "outside.txt"))).toBe(false);
  });

  it("tracks the new file state so subsequent edits work", async () => {
    const context = makeContext();
    await write_file.execute({ path: "fresh.txt", content: "v1" }, context);
    const result = await write_file.execute({ path: "fresh.txt", content: "v2" }, context);
    expect(result.ok).toBe(true);
    const stat = statSync(realpathSync(join(dir, "fresh.txt")));
    expect(
      context.readTracker.check(realpathSync(join(dir, "fresh.txt")), {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      }).ok,
    ).toBe(true);
  });
});
