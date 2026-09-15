import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
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
 * Transient-error retries. The AI SDK retries retryable APICallErrors
 * (rate limits, 5xx, network) with exponential backoff when maxRetries > 0;
 * these tests prove the budget flag is wired through the agent loop.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-retry-"));
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

// Narrow the AI SDK union (model ids | V2/V3/V4 spec objects) to the V4 spec
// object — same type the mock implements — without importing @ai-sdk/provider.
type V4Spec = Extract<LanguageModel, { specificationVersion: "v4" }>;

function flakyModel(inner: V4Spec, failures: number, retryable: boolean) {
  let calls = 0;
  const model: V4Spec = {
    specificationVersion: "v4",
    provider: inner.provider,
    modelId: inner.modelId,
    get supportedUrls() {
      return inner.supportedUrls;
    },
    doGenerate: async () => {
      throw new Error("doGenerate not used in retry tests");
    },
    doStream: (callOptions) => {
      calls += 1;
      if (calls <= failures) {
        throw new APICallError({
          message: retryable ? "rate limited by provider" : "bad request shape",
          url: "https://mock.invalid/v1",
          requestBodyValues: {},
          statusCode: retryable ? 429 : 400,
          isRetryable: retryable,
        });
      }
      return inner.doStream(callOptions);
    },
  };
  return { model, calls: () => calls };
}

function successModel() {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "recovered after retry" },
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

describe("runAgent retries", () => {
  it("recovers from a transient rate limit when maxRetries allows it", async () => {
    const cwd = tempDir();
    const inner = successModel();
    const { model, calls } = flakyModel(inner, 1, true);

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "ping" }],
      tools,
      permissions: new AllowAllGate(),
      events: new EventBus<HarnessEvent>(),
      toolContext: makeContext(cwd),
      budget: { maxSteps: 3, maxRetries: 1 },
    });

    expect(result.stopReason).toBe("stop");
    expect(calls()).toBe(2); // one failure, one successful retry
  }, 20_000);

  it("fails fast on non-retryable errors without consuming retries", async () => {
    const cwd = tempDir();
    const inner = successModel();
    const { model, calls } = flakyModel(inner, 1, false);

    const result = await runAgent({
      model,
      system: "test",
      messages: [{ role: "user", content: "ping" }],
      tools,
      permissions: new AllowAllGate(),
      events: new EventBus<HarnessEvent>(),
      toolContext: makeContext(cwd),
      budget: { maxSteps: 3, maxRetries: 3 },
    });

    expect(result.stopReason).toBe("error");
    expect(result.error).toBeDefined();
    expect(calls()).toBe(1); // 400 is never retried
  });
});
