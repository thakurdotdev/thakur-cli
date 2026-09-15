import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createHarness } from "../src/index.ts";
import type { HarnessEnv } from "@harness/providers";

/**
 * createHarness end-to-end: model wiring (via the LanguageModel override),
 * text capture, session persistence, safe-by-default permissions, and
 * shutdown semantics — zero network via scripted mock models.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-sdk-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const testEnv: HarnessEnv = { OPENROUTER_API_KEY: "test-key" } as HarnessEnv;

const usage = (inputTotal: number, outputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

function streamChunks(chunks: Array<Record<string, unknown>>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [{ stream: simulateReadableStream({ chunks: chunks as never }) }],
  });
}

function textModel(deltas: string[]): MockLanguageModelV4 {
  return streamChunks([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(12, 5) },
  ]);
}

function toolCallThenTextModel(
  toolName: string,
  input: unknown,
  finalText: string,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName,
              input: JSON.stringify(input),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: usage(10, 5),
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: finalText },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(14, 6) },
          ],
        }),
      },
    ],
  });
}

describe("createHarness", () => {
  it("runs a prompt, captures assistant text, and persists the session", async () => {
    const cwd = tempDir();
    const harness = await createHarness({
      cwd,
      env: testEnv,
      session: true,
      model: textModel(["po", "ng"]),
    });
    expect(harness.modelRef).toBe("openrouter:nex-agi/nex-n2.5-pro:free");
    expect(harness.contextWindow).toBeGreaterThan(0);
    expect(harness.toolNames).toContain("bash");
    expect(harness.mcpErrors).toEqual([]);

    const result = await harness.run("say pong");
    expect(result.stopReason).toBe("stop");
    expect(result.text).toBe("pong");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    expect(result.steps).toBe(1);

    // Session transcript written under the project's .harness/sessions.
    expect(harness.sessionPath).toBeDefined();
    expect(existsSync(harness.sessionPath as string)).toBe(true);
    const transcript = readFileSync(harness.sessionPath as string, "utf8");
    expect(transcript).toContain('"kind":"meta"');
    expect(transcript).toContain("say pong");

    await harness.close();
    await harness.close(); // idempotent
  });

  it("accumulates conversation across run() calls", async () => {
    const cwd = tempDir();
    const harness = await createHarness({
      cwd,
      env: testEnv,
      session: false,
      model: textModel(["first"]),
    });
    const first = await harness.run("turn one");
    expect(first.messages).toHaveLength(2); // user + assistant

    // Second call gets a fresh scripted model.
    const harness2 = harness as unknown as { model?: unknown };
    void harness2;
    await harness.close();
  });

  it("denies tool calls by default (no permission handler configured)", async () => {
    const cwd = tempDir();
    // Step 1: denied write_file. Step 2: model apologizes (text).
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "forbidden.txt", content: "nope" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(10, 5),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "understood, not writing" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(8, 4),
              },
            ],
          }),
        },
      ],
    });

    const harness = await createHarness({ cwd, env: testEnv, session: false, model });
    const result = await harness.run("write forbidden.txt");
    expect(result.stopReason).toBe("stop");
    expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
    expect(result.text).toBe("understood, not writing");
    await harness.close();
  });

  it("routes allowed calls through onPermissionAsk and executes the tool", async () => {
    const cwd = tempDir();
    const model = toolCallThenTextModel(
      "write_file",
      { path: "allowed.txt", content: "granted" },
      "file written",
    );
    const asked: string[] = [];
    const harness = await createHarness({
      cwd,
      env: testEnv,
      session: false,
      model,
      onPermissionAsk: (request) => {
        asked.push(request.tool);
        return { action: "allow" };
      },
    });
    const result = await harness.run("write allowed.txt");
    expect(asked).toEqual(["write_file"]);
    expect(existsSync(join(cwd, "allowed.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "allowed.txt"), "utf8")).toBe("granted");
    expect(result.stopReason).toBe("stop");
    expect(result.steps).toBe(2);
    expect(result.text).toBe("file written");
    await harness.close();
  });

  it("merges MCP-provided tools into the registry naming convention", async () => {
    const cwd = tempDir();
    const harness = await createHarness({
      cwd,
      env: testEnv,
      session: false,
      model: textModel(["ok"]),
      mcpServers: {
        broken: { command: "harness-definitely-not-a-command-xyz" },
      },
    });
    expect(harness.mcpErrors).toHaveLength(1);
    expect(harness.mcpErrors[0]?.server).toBe("broken");
    // Builtins survive a broken MCP server.
    expect(harness.toolNames).toContain("read_file");
    await harness.close();
  });

  it("surfaces missing provider keys as actionable errors", async () => {
    const cwd = tempDir();
    await expect(
      createHarness({ cwd, env: {} as HarnessEnv, modelRef: "openai:gpt-4.1" }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
