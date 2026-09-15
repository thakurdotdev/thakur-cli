import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  AllowAllGate,
  EventBus,
  InteractiveGate,
  ReadTracker,
  SessionStore,
  asAbsolutePath,
  createTruncator,
  runAgent,
} from "@harness/core";
import type { HarnessEvent } from "@harness/core";
import { tools } from "@harness/tools";

/**
 * Agent-loop integration tests: model response -> tool call -> permission
 * evaluation -> tool execution -> tool result -> next model step -> completion.
 * Zero network, zero model cost — scripted via AI SDK mock models.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-loop-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const usage = (inputTotal: number, outputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

function makeContext(cwd: string) {
  return {
    cwd: asAbsolutePath(cwd),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 50_000 }),
  };
}

describe("runAgent", () => {
  it("completes a tool-call loop end to end: write_file then final text", async () => {
    const cwd = tempDir();
    const events = new EventBus<HarnessEvent>();
    const recorded: HarnessEvent[] = [];
    events.onAny((event) => recorded.push(event));

    const session = SessionStore.create(join(cwd, ".harness", "sessions"), { model: "mock", cwd });
    const toolContext = makeContext(cwd);

    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-1", modelId: "mock-model" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "hi.txt", content: "hello from the model" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(20, 10),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-2", modelId: "mock-model" },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Created hi.txt" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(30, 15),
              },
            ],
          }),
        },
      ],
    });

    const permissions = new InteractiveGate({ onAsk: () => ({ action: "always" }) });

    const result = await runAgent({
      model,
      system: "test system prompt",
      messages: [{ role: "user", content: "create hi.txt" }],
      tools,
      permissions,
      events,
      toolContext,
      session,
      budget: { maxSteps: 5 },
    });

    // File was actually written through the permission gate.
    expect(existsSync(join(cwd, "hi.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "hi.txt"), "utf8")).toBe("hello from the model");

    // Conversation shape: user + assistant(tool-call) + tool(result) + assistant(text)
    expect(result.messages).toHaveLength(4);
    expect(result.stopReason).toBe("stop");
    expect(result.steps).toBe(2);
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);

    // Event stream saw the full pipeline.
    const toolCall = recorded.find((event) => event.type === "tool:call");
    expect(toolCall).toMatchObject({ type: "tool:call", name: "write_file" });
    const toolResults = recorded.filter((event) => event.type === "tool:result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool:result",
      name: "write_file",
      result: { ok: true },
    });
    expect(recorded.filter((event) => event.type === "usage")).toHaveLength(2);
    expect(recorded.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      stopReason: "stop",
    });
    const deltas = recorded.filter((event) => event.type === "text:delta");
    expect(deltas.map((event) => (event.type === "text:delta" ? event.text : ""))).toContain(
      "Created hi.txt",
    );

    // Session captured: meta, per-step usage (onStepFinish), response
    // messages (appended post-run), done. The caller owns the user turn.
    const { lines, errors } = SessionStore.load(session.path);
    expect(errors).toEqual([]);
    const kinds = lines.map((line) => line.kind);
    expect(kinds).toEqual(["meta", "usage", "usage", "message", "message", "message", "done"]);
  });

  it("returns an error tool result to the model when permission is denied", async () => {
    const cwd = tempDir();
    const events = new EventBus<HarnessEvent>();
    const toolContext = makeContext(cwd);

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
              { type: "text-start", id: "text-1" },
              {
                type: "text-delta",
                id: "text-1",
                delta: "Understood, I will not write that file.",
              },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(20, 8),
              },
            ],
          }),
        },
      ],
    });

    const asks: string[] = [];
    const permissions = new InteractiveGate({
      onAsk: (request) => {
        asks.push(request.tool);
        return { action: "deny", reason: "not approved in test" };
      },
    });

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "write forbidden.txt" }],
      tools,
      permissions,
      events,
      toolContext,
    });

    expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
    expect(asks).toEqual(["write_file"]);
    expect(result.stopReason).toBe("stop");

    // The tool result the model received must be an actionable error.
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    const serialized = JSON.stringify(toolMessage);
    expect(serialized).toContain("Permission denied");
  });

  it("stops at maxSteps and does not call the model again", async () => {
    const cwd = tempDir();
    const events = new EventBus<HarnessEvent>();
    const toolContext = makeContext(cwd);

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
                input: JSON.stringify({ path: "loop.txt", content: "again" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(10, 5),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "keep writing" }],
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext,
      budget: { maxSteps: 1 },
    });

    expect(result.steps).toBe(1);
    expect(result.messages).toHaveLength(3);
    expect(existsSync(join(cwd, "loop.txt"))).toBe(true);
  });

  it("records session usage and messages for AllowAllGate headless runs", async () => {
    const cwd = tempDir();
    const toolContext = makeContext(cwd);
    const session = SessionStore.create(join(cwd, ".harness", "sessions"), { model: "mock", cwd });

    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "pong" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(3, 2),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "ping" }],
      tools,
      permissions: new AllowAllGate(),
      events: new EventBus<HarnessEvent>(),
      toolContext,
      session,
    });

    expect(result.stopReason).toBe("stop");
    const { lines, errors } = SessionStore.load(session.path);
    expect(errors).toEqual([]);
    expect(lines.filter((line) => line.kind === "usage")).toHaveLength(1);
    expect(lines[lines.length - 1]?.kind).toBe("done");
  });

  it("handles aborted signal cleanly without emitting error events", async () => {
    const cwd = tempDir();
    const toolContext = makeContext(cwd);
    const events = new EventBus<HarnessEvent>();
    const emittedErrors: string[] = [];
    events.on("error", (e) => emittedErrors.push(e.message));

    const controller = new AbortController();
    controller.abort();

    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "never" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(1, 1),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext,
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("aborted");
    expect(emittedErrors).toHaveLength(0);
  });

  it("surfaces API stream errors cleanly without dumping raw console.error", async () => {
    const cwd = tempDir();
    const toolContext = makeContext(cwd);
    const events = new EventBus<HarnessEvent>();
    const emittedErrors: string[] = [];
    events.on("error", (e) => emittedErrors.push(e.message));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const model = new MockLanguageModelV4({
      doStream: async () => {
        const err = new Error(
          "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 2666.",
        );
        err.name = "APICallError";
        (err as unknown as Record<string, unknown>)["statusCode"] = 402;
        throw err;
      },
    });

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "hello" }],
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext,
    });

    expect(result.stopReason).toBe("error");
    expect(emittedErrors).toHaveLength(1);
    expect(emittedErrors[0]).toContain("This request requires more credits");
    // Verify AI SDK default console.error was prevented
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
