import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { grep } from "@harness/tools";
import { resolveRgBinary } from "../src/internal/rg.ts";

const hasRg = (await resolveRgBinary()) !== null;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-grep-"));
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

function seedFixture(): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# hello needle\n", "utf8");
  writeFileSync(join(dir, "node_modules", "junk", "x.js"), "needle in deps\n", "utf8");
}

describe.skipIf(!hasRg)("grep tool", () => {
  it("finds matches across files with file:line: text format", async () => {
    seedFixture();
    const result = await grep.execute({ pattern: "needle" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("src/a.ts:1: const needle = 1;");
      expect(result.data).toContain("README.md:1: # hello needle");
    }
  });

  it("excludes node_modules by default", async () => {
    seedFixture();
    const result = await grep.execute({ pattern: "needle" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toContain("node_modules");
    }
  });

  it("respects the include glob filter", async () => {
    seedFixture();
    const result = await grep.execute({ pattern: "needle", include: "*.md" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("README.md:1");
      expect(result.data).not.toContain("src/a.ts");
    }
  });

  it("supports case-insensitive search", async () => {
    writeFileSync(join(dir, "case.txt"), "MIXED Case Value\n", "utf8");
    const sensitive = await grep.execute({ pattern: "case value" }, makeContext());
    const insensitive = await grep.execute(
      { pattern: "case value", ignore_case: true },
      makeContext(),
    );
    expect(sensitive.ok).toBe(true);
    if (sensitive.ok) {
      expect(sensitive.data).toContain("No matches");
    }
    expect(insensitive.ok).toBe(true);
    if (insensitive.ok) {
      expect(insensitive.data).toContain("case.txt:1: MIXED Case Value");
    }
  });

  it("returns an actionable no-match result", async () => {
    writeFileSync(join(dir, "a.txt"), "nothing special\n", "utf8");
    const result = await grep.execute({ pattern: "zzz-not-there" }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("No matches");
    }
  });

  it("caps output at max_results with a truncation note", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `hit-${i + 1}`).join("\n");
    writeFileSync(join(dir, "many.txt"), lines, "utf8");
    const result = await grep.execute({ pattern: "hit-", max_results: 5 }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("hit-5");
      expect(result.data).not.toContain("hit-6:");
      expect(result.data).toContain("showing 5 of 20");
    }
  });

  it("reports invalid regex as an error result, not a throw", async () => {
    const result = await grep.execute({ pattern: "(unclosed" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Search failed");
    }
  });

  it("rejects paths that escape the project root", async () => {
    const result = await grep.execute({ pattern: "needle", path: "../outside" }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escapes the project root");
    }
  });

  it("supports fixed_string literal search without regex syntax errors", async () => {
    writeFileSync(join(dir, "literal.txt"), "function (unclosed() {}\n", "utf8");
    const result = await grep.execute({ pattern: "(unclosed", fixed_string: true }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("literal.txt:1: function (unclosed() {}");
    }
  });

  it("includes surrounding context lines when context_lines is specified", async () => {
    writeFileSync(join(dir, "ctx.txt"), "line-before\nTARGET-MATCH\nline-after\n", "utf8");
    const result = await grep.execute({ pattern: "TARGET-MATCH", context_lines: 1 }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("ctx.txt:1- line-before");
      expect(result.data).toContain("ctx.txt:2: TARGET-MATCH");
      expect(result.data).toContain("ctx.txt:3- line-after");
    }
  });
});
