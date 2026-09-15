import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  AllowAllGate,
  EventBus,
  ReadTracker,
  SessionStore,
  asAbsolutePath,
  compactMessages,
  createTruncator,
  estimateMessagesTokens,
  estimateTokens,
  runAgent,
  shouldCompact,
} from "@harness/core";
import type { HarnessEvent } from "@harness/core";
import type { LanguageModel, ModelMessage } from "ai";
import { tools } from "@harness/tools";

/** Narrow the AI SDK union to the concrete V4 spec object (no extra dep). */
type V4Spec = Extract<LanguageModel, { specificationVersion: "v4" }>;
type V4StreamPart =
  Awaited<ReturnType<V4Spec["doStream"]>> extends { stream: ReadableStream<infer T> } ? T : never;

/**
 * Context compaction: threshold logic, summarization swap, fail-open
 * behavior, and the end-to-end integration through runAgent.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-compact-"));
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

function textStreamResponse(
  text: string,
  usageIn = 10,
  usageOut = 10,
): {
  stream: ReadableStream<V4StreamPart>;
} {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(usageIn, usageOut),
        },
      ],
    }),
  };
}

const bigHistory = (pairs: number): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  for (let index = 0; index < pairs; index += 1) {
    messages.push({ role: "user", content: `task step ${index}: ${"detail ".repeat(40)}` });
    messages.push({
      role: "assistant",
      content: `progress on step ${index}: ${"work ".repeat(40)}`,
    });
  }
  return messages;
};

function makeContext(cwd: string) {
  return {
    cwd: asAbsolutePath(cwd),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 50_000 }),
  };
}

describe("shouldCompact", () => {
  it("is false under the trigger ratio and true over it", () => {
    const system = "s";
    const messages: ModelMessage[] = [{ role: "user", content: "x".repeat(400) }]; // ~100 tokens
    expect(
      shouldCompact({ system, messages, policy: { contextWindow: 1_000, triggerRatio: 0.5 } }),
    ).toBe(false);
    expect(
      shouldCompact({ system, messages, policy: { contextWindow: 110, triggerRatio: 0.5 } }),
    ).toBe(true);
  });
});

describe("compactMessages", () => {
  it("replaces old turns with a summary head and keeps the verbatim tail", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        textStreamResponse("User wants tests for feature X; files: src/a.ts; next: run verify."),
      ],
    });
    const messages = bigHistory(8);
    const system = "system prompt";

    const outcome = await compactMessages({
      model,
      system,
      messages,
      policy: { contextWindow: 500, triggerRatio: 0.5, keepRecentMessages: 4 },
    });

    expect(outcome.compacted).toBe(true);
    expect(outcome.messages).toHaveLength(5); // summary head + 4 kept
    const head = outcome.messages[0];
    if (head === undefined) {
      expect.unreachable("expected a summary head message");
    }
    expect(head.role).toBe("user");
    expect(JSON.stringify(head.content)).toContain("<context-summary>");
    expect(JSON.stringify(head.content)).toContain("run verify");
    // The kept tail is the END of the original history.
    expect(outcome.messages.slice(1)).toEqual(messages.slice(-4));
    expect(outcome.afterTokens).toBeLessThan(outcome.beforeTokens);
    expect(outcome.beforeTokens).toBe(estimateTokens(system) + estimateMessagesTokens(messages));
  });

  it("skips when history is too short", async () => {
    const model = new MockLanguageModelV4({ doStream: [] });
    const messages: ModelMessage[] = [bigHistory(2)[0] as ModelMessage];
    const outcome = await compactMessages({
      model,
      system: "s",
      messages,
      policy: { contextWindow: 50, triggerRatio: 0.1, keepRecentMessages: 6 },
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe("history too short to compact");
    expect(outcome.messages).toEqual(messages);
  });

  it("fails open when the summarization model errors", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "error", error: new Error("summarizer down") },
            ],
          }),
        },
      ],
    });
    const messages = bigHistory(8);
    const outcome = await compactMessages({
      model,
      system: "s",
      messages,
      policy: { contextWindow: 500, triggerRatio: 0.5, keepRecentMessages: 4 },
      maxRetries: 0,
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toContain("compaction failed");
    expect(outcome.messages).toEqual(messages);
  });
});

describe("runAgent compaction integration", () => {
  it("compacts before the run, emits the event, and records the session line", async () => {
    const cwd = tempDir();
    const events = new EventBus<HarnessEvent>();
    const recorded: HarnessEvent[] = [];
    events.onAny((event) => recorded.push(event));

    const session = SessionStore.create(join(cwd, ".harness", "sessions"), {
      model: "mock",
      cwd,
    });

    // Call 1 = summarizer, call 2 = the actual agent turn.
    const model = new MockLanguageModelV4({
      doStream: [
        textStreamResponse(
          "Summary: user tested compaction; next step is verifying the transcript.",
        ),
        textStreamResponse("Compaction works."),
      ],
    });

    const result = await runAgent({
      model,
      system: "test system",
      messages: bigHistory(8),
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext: makeContext(cwd),
      session,
      compaction: { contextWindow: 500, triggerRatio: 0.5, keepRecentMessages: 4 },
    });

    expect(result.stopReason).toBe("stop");
    // The run itself saw the compacted history: summary head first.
    expect(result.messages[0]?.role).toBe("user");
    expect(JSON.stringify(result.messages[0]?.content)).toContain("<context-summary>");
    expect(JSON.stringify(result.messages[0]?.content)).toContain("verifying the transcript");
    expect(result.messages).toHaveLength(6); // head + 4 kept + new assistant reply

    const compactionEvents = recorded.filter((event) => event.type === "compaction");
    expect(compactionEvents).toHaveLength(1);
    const compaction = compactionEvents[0];
    if (compaction === undefined || compaction.type !== "compaction") {
      expect.unreachable("expected a compaction event");
    }
    expect(compaction.after).toBeLessThan(compaction.before);

    const { lines, errors } = SessionStore.load(session.path);
    expect(errors).toEqual([]);
    const compactionLines = lines.filter((line) => line.kind === "compaction");
    expect(compactionLines).toHaveLength(1);
    const line = compactionLines[0];
    if (line === undefined || line.kind !== "compaction") {
      expect.unreachable("expected a compaction session line");
    }
    expect(line.before).toBe(compaction.before);
  });

  it("runs uncompacted when the context is under the threshold", async () => {
    const cwd = tempDir();
    const events = new EventBus<HarnessEvent>();
    const recorded: HarnessEvent[] = [];
    events.onAny((event) => recorded.push(event));

    const model = new MockLanguageModelV4({
      doStream: [textStreamResponse("No compaction needed.")],
    });

    const result = await runAgent({
      model,
      system: "tiny",
      messages: [{ role: "user", content: "hello" }],
      tools,
      permissions: new AllowAllGate(),
      events,
      toolContext: makeContext(cwd),
      compaction: { contextWindow: 200_000, triggerRatio: 0.8, keepRecentMessages: 4 },
    });

    expect(result.stopReason).toBe("stop");
    expect(result.messages[0]?.content).toBe("hello");
    expect(recorded.filter((event) => event.type === "compaction")).toHaveLength(0);
  });
});
