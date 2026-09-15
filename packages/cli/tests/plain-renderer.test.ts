import { describe, expect, it } from "vitest";
import { EventBus } from "@harness/core";
import type { HarnessEvent } from "@harness/core";
import { createPlainRenderer } from "../src/renderers/plain.ts";

/**
 * Terminal rendering — claude-code/opencode style: named-arg tool headers,
 * one dim result line, no step/usage noise, clean single-line errors.
 */

class FakeOut {
  readonly parts: string[] = [];
  isTTY = false;
  write(text: string): void {
    this.parts.push(text);
  }
  text(): string {
    return this.parts.join("");
  }
}

function render(events: HarnessEvent[]): string {
  const bus = new EventBus<HarnessEvent>();
  const out = new FakeOut();
  const detach = createPlainRenderer({ events: bus, out, color: false });
  for (const event of events) {
    bus.emit(event);
  }
  detach();
  return out.text();
}

describe("plain renderer", () => {
  it("renders tool calls with the informative-argument header, not a JSON dump", () => {
    const text = render([
      {
        type: "tool:call",
        name: "grep",
        input: { pattern: ".*", path: "packages", include: "*.ts", ignore_case: false },
      },
    ]);
    expect(text).toContain("● Grep(.*");
    expect(text).toContain("packages");
    expect(text).not.toContain("include");
    expect(text).not.toContain("ignore_case");
    expect(text).not.toContain('{"pattern"');
  });

  it("renders bash calls with the command up front", () => {
    const text = render([{ type: "tool:call", name: "bash", input: { command: "git status" } }]);
    expect(text).toContain("● Bash(git status)");
  });

  it("renders ok results as a dim summary line", () => {
    const text = render([
      { type: "tool:result", name: "grep", result: { ok: true, data: "a\nb\nc" }, ms: 12 },
    ]);
    expect(text).toContain("⎿ 3 lines (12ms)");
  });

  it("previews single-line results", () => {
    const text = render([
      {
        type: "tool:result",
        name: "bash",
        result: { ok: true, data: "commit 2bf93b6 (HEAD, main)" },
        ms: 88,
      },
    ]);
    expect(text).toContain("⎿ commit 2bf93b6 (HEAD, main) (88ms)");
  });

  it("renders error results with the hint", () => {
    const text = render([
      {
        type: "tool:result",
        name: "bash",
        result: { ok: false, error: 'Permission denied for tool "bash"', hint: "not approved" },
        ms: 0,
      },
    ]);
    expect(text).toContain("⎿ ✗ Permission denied");
    expect(text).toContain("not approved");
  });

  it("stays silent for run:start / step:start / usage noise", () => {
    const text = render([
      { type: "run:start", model: "openrouter:x", cwd: "/tmp" },
      { type: "step:start", step: 0 },
      { type: "usage", inputTokens: 123963, outputTokens: 364 },
      { type: "step:start", step: 1 },
      { type: "usage", inputTokens: 5, outputTokens: 5 },
    ]);
    expect(text).toBe("");
  });

  it("renders run-level errors as one red sentence plus an optional hint", () => {
    const text = render([
      {
        type: "error",
        message:
          "context window exceeded — request ~265.1k tokens vs 262.1k limit · compacting history and retrying",
      },
      { type: "error", message: "invalid api key", hint: "check OPENROUTER_API_KEY" },
    ]);
    expect(text).toContain("✗ context window exceeded");
    expect(text).toContain("✗ invalid api key");
    expect(text).toContain("check OPENROUTER_API_KEY");
    expect(text).not.toContain("requestBodyValues");
    expect(text.split("\n").filter((line) => line.includes("invalid api key"))).toHaveLength(1);
  });

  it("renders compaction and done lines", () => {
    const text = render([
      { type: "compaction", before: 265113, after: 98400 },
      { type: "done", stopReason: "stop" },
    ]);
    expect(text).toContain("⟳ compacted context: 265113 → 98400 tokens");
    expect(text).toContain("▪ done (stop)");
  });

  it("renders reflection and progress lines", () => {
    const text = render([
      { type: "reflection", message: "Tool edit_file has failed 3 times in a row." },
      { type: "progress", message: "4 steps remaining out of 20", step: 16, maxSteps: 20 },
    ]);
    expect(text).toContain("⚡ Tool edit_file has failed 3 times in a row.");
    expect(text).toContain("⏳ 4 steps remaining out of 20");
  });

  it("streams assistant text through untouched", () => {
    const text = render([
      { type: "text:delta", text: "Hello " },
      { type: "text:delta", text: "world" },
    ]);
    expect(text).toBe("Hello world");
  });

  it("renders thinking deltas as a Thought block", () => {
    const text = render([
      { type: "thinking:delta", text: "checking " },
      { type: "thinking:delta", text: "auth flow" },
      { type: "text:delta", text: "Hello" },
    ]);
    expect(text).toContain("Thought");
    expect(text).toContain("checking auth flow");
    expect(text).toContain("Hello");
  });

  it("renders edit_file calls with red/green diff lines and line numbers", () => {
    const text = render([
      {
        type: "tool:call",
        name: "edit_file",
        input: { path: "src/a.ts", old_string: "const a = 1;\n", new_string: "const a = 2;\n" },
      },
    ]);
    expect(text).toContain("Edit(src/a.ts)");
    expect(text).toContain("- const a = 1;");
    expect(text).toContain("+ const a = 2;");
    expect(text).toContain("│-");
    expect(text).toContain("│+");
  });

  it("renders edit_file with replace_all showing ×all badge", () => {
    const text = render([
      {
        type: "tool:call",
        name: "edit_file",
        input: { path: "src/a.ts", old_string: "a", new_string: "b", replace_all: true },
      },
    ]);
    expect(text).toContain("Edit(src/a.ts)");
    expect(text).toContain("×all");
  });

  it("renders write_file calls with +new and line-numbered added lines", () => {
    const text = render([
      {
        type: "tool:call",
        name: "write_file",
        input: { path: "src/new.ts", content: "export const x = 1;\n" },
      },
    ]);
    expect(text).toContain("Write(src/new.ts)");
    expect(text).toContain("+new");
    expect(text).toContain("1│+ export const x = 1;");
  });
});
