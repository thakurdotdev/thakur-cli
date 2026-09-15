import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  AllowAllGate,
  EventBus,
  ReadTracker,
  asAbsolutePath,
  createTruncator,
  runAgent,
} from "@harness/core";
import type { HarnessEvent, ToolDefinition } from "@harness/core";

/**
 * JSON-Schema tools (the MCP path) flow through the same agent loop as zod
 * tools: the AI SDK exposes the raw schema to the model, and the gated
 * execute receives the model's arguments unvalidated-but-intact.
 */

const usage = (inputTotal: number, outputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

describe("runAgent with JSON-Schema tool definitions", () => {
  it("executes an MCP-style tool and feeds the result back to the model", async () => {
    const events = new EventBus<HarnessEvent>();
    const recorded: HarnessEvent[] = [];
    events.onAny((event) => recorded.push(event));

    const calls: Array<{ input: unknown; signal: AbortSignal | undefined }> = [];
    const mcpStyleTool: ToolDefinition = {
      name: "mcp__echo__echo",
      description: 'Echo the message back (MCP tool from server "echo")',
      risk: "write",
      inputJsonSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      async execute(rawInput, context) {
        calls.push({ input: rawInput, signal: context.signal });
        const message = (rawInput as { message?: unknown }).message;
        return { ok: true, data: `echo: ${String(message ?? "")}` };
      },
    };

    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "mcp__echo__echo",
                input: JSON.stringify({ message: "hello json schema" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(15, 8),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              {
                type: "text-delta",
                id: "t1",
                delta: "The echo tool said: echo: hello json schema",
              },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(25, 10),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "use the echo tool" }],
      tools: { mcp__echo__echo: mcpStyleTool },
      permissions: new AllowAllGate(),
      events,
      toolContext: {
        cwd: asAbsolutePath(process.cwd()),
        readTracker: new ReadTracker(),
        truncator: createTruncator({ maxChars: 1_000 }),
      },
      budget: { maxSteps: 5 },
    });

    expect(result.stopReason).toBe("stop");
    expect(result.steps).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ message: "hello json schema" });

    const toolResults = recorded.filter((event) => event.type === "tool:result");
    expect(toolResults).toEqual([
      expect.objectContaining({
        type: "tool:result",
        name: "mcp__echo__echo",
        result: { ok: true, data: "echo: hello json schema" },
      }),
    ]);

    // The tool message reached the conversation so the model could use it.
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain("echo: hello json schema");
  });
});
