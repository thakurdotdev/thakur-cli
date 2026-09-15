import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { edit_file, read_file } from "@harness/tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-edit-"));
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

describe("edit_file tool", () => {
  it("refuses to edit files that have not been read", async () => {
    writeFileSync(join(dir, "code.ts"), "const a = 1;\n", "utf8");
    const result = await edit_file.execute(
      { path: "code.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("has not been read");
    }
  });

  it("performs an exact replacement after a read", async () => {
    writeFileSync(join(dir, "code.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "code.ts" }, context);

    const result = await edit_file.execute(
      { path: "code.ts", old_string: "const a = 1;", new_string: "const a = 42;" },
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { replacements: number };
      expect(data.replacements).toBe(1);
    }
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toContain("const a = 42;");
  });

  it("rejects old_string that does not exist in the file", async () => {
    writeFileSync(join(dir, "code.ts"), "const a = 1;\n", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "code.ts" }, context);

    const result = await edit_file.execute(
      { path: "code.ts", old_string: "NOT PRESENT", new_string: "x" },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("old_string not found");
      expect(result.hint).toContain("exactly");
    }
  });

  it("rejects ambiguous matches unless replace_all is set", async () => {
    writeFileSync(join(dir, "code.ts"), "let x = f(x);\nlet y = f(y);\n", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "code.ts" }, context);

    const ambiguous = await edit_file.execute(
      { path: "code.ts", old_string: "let", new_string: "const" },
      context,
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error).toContain("2 times");
    }

    const replaceAll = await edit_file.execute(
      { path: "code.ts", old_string: "let", new_string: "const", replace_all: true },
      context,
    );
    expect(replaceAll.ok).toBe(true);
    if (replaceAll.ok) {
      const data = replaceAll.data as { replacements: number };
      expect(data.replacements).toBe(2);
    }
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const x = f(x);\nconst y = f(y);\n");
  });

  it("detects external modification between read and edit", async () => {
    writeFileSync(join(dir, "code.ts"), "const a = 1;\n", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "code.ts" }, context);

    // Simulate an external process mutating the file after the read.
    writeFileSync(join(dir, "code.ts"), "externally changed\n", "utf8");

    const result = await edit_file.execute(
      { path: "code.ts", old_string: "externally changed", new_string: "sneaky" },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("changed since it was last read");
    }
  });

  it("supports deletion via empty new_string", async () => {
    writeFileSync(join(dir, "code.ts"), "keep;\ndelete-me;\n", "utf8");
    const context = makeContext();
    await read_file.execute({ path: "code.ts" }, context);
    const result = await edit_file.execute(
      { path: "code.ts", old_string: "delete-me;\n", new_string: "" },
      context,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("keep;\n");
  });

  it("refuses to edit a non-existent file", async () => {
    const context = makeContext();
    const result = await edit_file.execute(
      { path: "ghost.ts", old_string: "a", new_string: "b" },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toContain("write_file");
    }
  });
});
