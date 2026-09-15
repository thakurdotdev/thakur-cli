import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel, ModelMessage } from "ai";
import {
  AllowAllGate,
  EventBus,
  ReadTracker,
  asAbsolutePath,
  createTruncator,
  runAgent,
} from "@harness/core";
import type { HarnessEvent } from "@harness/core";
import { tools } from "@harness/tools";

/**
 * In-run context-window recovery: the provider rejects a request with
 * context_length_exceeded (the real-world failure this harness shipped
 * with), the loop mechanically truncates the history and retries once.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-overflow-"));
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

// Narrow the AI SDK union to the V4 spec object — same as the retry tests.
type V4Spec = Extract<LanguageModel, { specificationVersion: "v4" }>;

const RAW_PROVIDER_ERROR = JSON.stringify({
  error: {
    message:
      "The request is 265113 tokens long and exceeds this model's context length of 262144 tokens.",
    type: "invalid_request_error",
    param: "",
    code: "context_length_exceeded",
  },
});

function overflowThenRecover(inner: V4Spec) {
  let calls = 0;
  const model: V4Spec = {
    specificationVersion: "v4",
    provider: inner.provider,
    modelId: inner.modelId,
    get supportedUrls() {
      return inner.supportedUrls;
    },
    doGenerate: async () => {
      throw new Error("doGenerate not used in overflow tests");
    },
    doStream: (callOptions) => {
      calls += 1;
      if (calls === 1) {
        throw new APICallError({
          message:
            "[Nex AGI] The request is 265113 tokens long and exceeds this model's context length of 262144 tokens.",
          url: "https://openrouter.ai/api/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
          data: {
            error: {
              message: "Provider returned error",
              code: 400,
              metadata: { raw: RAW_PROVIDER_ERROR },
            },
          },
        });
      }
      return inner.doStream(callOptions);
    },
  };
  return { model, calls: () => calls };
}

function successModel(text: string) {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: text },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: usage(12, 6),
            },
          ],
        }),
      },
    ],
  });
}

function makeContext(cwd: string) {
  return {
    cwd: asAbsolutePath(cwd),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 50_000 }),
  };
}

describe("runAgent context-overflow recovery", () => {
  it("truncates the history and retries when the provider reports overflow", async () => {
    const cwd = tempDir();
    const inner = successModel("recovered after compaction");
    const { model, calls } = overflowThenRecover(inner);

    const history: ModelMessage[] = [
      { role: "user", content: "old task" },
      { role: "assistant", content: "working on it" },
      { role: "user", content: "current task" },
    ];

    const events = new EventBus<HarnessEvent>();
    const recorded: HarnessEvent[] = [];
    events.onAny((event) => recorded.push(event));

    const result = await runAgent({
      model,
      system: "test",
      messages: history,
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext: makeContext(cwd),
      budget: { maxSteps: 3, maxRetries: 0 },
    });

    // Two provider calls: the rejected one, then the recovery retry.
    expect(calls()).toBe(2);
    expect(result.stopReason).toBe("stop");
    expect(result.learnedContextWindow).toBe(262144);

    // The recovered history starts with the truncation note and keeps the
    // live task; the model's reply is appended after it.
    const first = result.messages[0];
    expect(first?.role).toBe("user");
    expect(JSON.stringify(first)).toContain("<context-truncated>");
    expect(JSON.stringify(result.messages)).toContain("current task");
    expect(JSON.stringify(result.messages)).toContain("recovered after compaction");

    // Usage comes from the successful retry's steps (12 in / 6 out).
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(6);
    expect(result.lastInputTokens).toBe(12);

    // Event trail: recovery notice, then compaction, then done.
    const errorEvent = recorded.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent && errorEvent.type === "error" ? errorEvent.message : "").toContain(
      "context window exceeded",
    );
    expect(recorded.some((event) => event.type === "compaction")).toBe(true);
    const doneIndex = recorded.findIndex((event) => event.type === "done");
    expect(doneIndex).toBeGreaterThan(recorded.findIndex((event) => event.type === "compaction"));
  });

  it("does not attempt recovery for unrelated 400 errors", async () => {
    const cwd = tempDir();
    const inner = successModel("should never stream");
    let calls = 0;
    const model: V4Spec = {
      specificationVersion: "v4",
      provider: inner.provider,
      modelId: inner.modelId,
      get supportedUrls() {
        return inner.supportedUrls;
      },
      doGenerate: async () => {
        throw new Error("not used");
      },
      doStream: () => {
        calls += 1;
        throw new APICallError({
          message: "invalid api key",
          url: "https://mock.invalid",
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    };

    const events = new EventBus<HarnessEvent>();
    const recorded: HarnessEvent[] = [];
    events.onAny((event) => recorded.push(event));

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "hello" }],
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext: makeContext(cwd),
      budget: { maxSteps: 3, maxRetries: 0 },
    });

    expect(calls).toBe(1); // no compaction retry for a 401
    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("invalid api key");
    expect(result.learnedContextWindow).toBeUndefined();

    const errorEvent = recorded.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent && errorEvent.type === "error" ? errorEvent.message : "").toBe(
      "invalid api key",
    );
  });

  it("reports a clean error when recovery is exhausted", async () => {
    const cwd = tempDir();
    let calls = 0;
    const model: V4Spec = {
      specificationVersion: "v4",
      provider: "mock",
      modelId: "overflow-forever",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("not used");
      },
      doStream: () => {
        calls += 1;
        throw new APICallError({
          message:
            "The request is 265113 tokens long and exceeds this model's context length of 262144 tokens.",
          url: "https://mock.invalid",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    };

    const result = await runAgent({
      model,
      system: "test",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      tools,
      permissions: new AllowAllGate(),
      events: new EventBus<HarnessEvent>(),
      toolContext: makeContext(cwd),
      budget: { maxSteps: 3, maxRetries: 0 },
    });

    // One attempt + one recovery attempt, then the clean failure.
    expect(calls).toBe(2);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("265113 tokens long");
  });
});
