import { describe, expect, it } from "vitest";
import { displayToolName } from "../src/renderers/plain.ts";
import { buildRunJson, readStdinPrompt, runExitCode } from "../src/commands/run.ts";
import type { Harness } from "@harness/sdk";

/**
 * Headless run command — pure helpers (JSON shape, exit codes, stdin prompt
 * reading) plus the renderer's MCP tool-name display.
 */

describe("displayToolName", () => {
  it("shortens MCP namespaced names to server/tool", () => {
    expect(displayToolName("mcp__fs__read_file")).toBe("fs/read_file");
    expect(displayToolName("mcp__weather__get-forecast")).toBe("weather/get-forecast");
  });

  it("leaves builtin and unusual names untouched", () => {
    expect(displayToolName("bash")).toBe("bash");
    expect(displayToolName("mcp__weird")).toBe("weird");
    expect(displayToolName("mcp__")).toBe("");
  });
});

describe("runExitCode", () => {
  it("maps stop reasons to process exit codes", () => {
    expect(runExitCode("stop")).toBe(0);
    expect(runExitCode("tool-calls")).toBe(0);
    expect(runExitCode("length")).toBe(0);
    expect(runExitCode("other")).toBe(0);
    expect(runExitCode("error")).toBe(1);
    expect(runExitCode("aborted")).toBe(130);
  });
});

function makeFakeHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    events: { onAny: () => () => {} } as unknown as Harness["events"],
    get modelRef() {
      return "openrouter:anthropic/claude-sonnet-4.5";
    },
    get contextWindow() {
      return 262_144;
    },
    get sessionPath() {
      return "/tmp/session.jsonl";
    },
    get toolNames() {
      return [];
    },
    get mcpErrors() {
      return [{ server: "broken", message: "boom" }];
    },
    run: async () => {
      throw new Error("not used");
    },
    switchModel: async () => {},
    close: async () => {},
    ...overrides,
  } as Harness;
}

describe("buildRunJson", () => {
  it("shapes the final JSON output for a successful run", () => {
    const harness = makeFakeHarness();
    const json = buildRunJson({
      harness,
      modelRef: harness.modelRef,
      result: {
        stopReason: "stop",
        steps: 3,
        usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234 },
        lastInputTokens: 1200,
        text: "All done.",
      },
    });
    expect(json.ok).toBe(true);
    expect(json.model).toBe("openrouter:anthropic/claude-sonnet-4.5");
    expect(json.stopReason).toBe("stop");
    expect(json.steps).toBe(3);
    expect(json.usage).toEqual({ inputTokens: 1200, outputTokens: 34, totalTokens: 1234 });
    expect(json.contextTokens).toBe(1200);
    expect(json.contextWindow).toBe(262_144);
    expect(json.text).toBe("All done.");
    expect(json.sessionPath).toBe("/tmp/session.jsonl");
    expect(json.mcpErrors).toEqual([{ server: "broken", message: "boom" }]);
    expect("error" in json).toBe(false);
  });

  it("marks failed runs and carries the error message", () => {
    const harness = makeFakeHarness();
    const json = buildRunJson({
      harness,
      modelRef: harness.modelRef,
      result: {
        stopReason: "error",
        error: "provider rejected the request",
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        text: "",
      },
    });
    expect(json.ok).toBe(false);
    expect(json.error).toBe("provider rejected the request");
  });
});

describe("readStdinPrompt", () => {
  it("returns empty for interactive TTYs", async () => {
    const tty = { isTTY: true, [Symbol.asyncIterator]: async function* () {} };
    await expect(readStdinPrompt(tty)).resolves.toBe("");
  });

  it("joins piped chunks and trims", async () => {
    async function* piped(): AsyncGenerator<Buffer | string> {
      yield Buffer.from("fix the ");
      yield Buffer.from("failing test\n");
    }
    await expect(readStdinPrompt(piped())).resolves.toBe("fix the failing test");
  });
});
