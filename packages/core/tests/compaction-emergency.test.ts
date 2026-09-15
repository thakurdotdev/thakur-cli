import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, emergencyCompact } from "@harness/core";
import type { ModelMessage } from "ai";

/**
 * Mechanical (model-free) compaction — the seatbelt that runs when a request
 * was already rejected with context_length_exceeded. It must always produce
 * a protocol-safe history at or under the target budget. Unlike session
 * resume, the recovered history MAY end on a user turn: it is re-sent to the
 * model directly, and "the last message is the user's task" is the right
 * place to continue from.
 */

/** ~400 chars of ASCII ≈ ~100 estimated tokens + 4 overhead per message. */
function fillerHistory(count: number, marker = ""): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "user" as const,
    content: `message ${index}${marker}: ${"x".repeat(396)}`,
  }));
}

const toolCallMessage = (id: string): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: "src/a.ts" } },
  ],
});

const toolResultMessage = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read_file",
      output: { type: "text", value: "contents" },
    },
  ],
});

function hasUnresolvedToolCall(messages: ReadonlyArray<ModelMessage>): boolean {
  let pending = 0;
  let lastIsToolCall = false;
  for (const message of messages) {
    lastIsToolCall = false;
    if (message.role === "assistant") {
      const calls = Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "tool-call").length
        : 0;
      pending += calls;
      if (calls > 0) {
        lastIsToolCall = true;
      }
    }
    if (message.role === "tool") {
      pending = Math.max(0, pending - 1);
    }
  }
  return pending > 0 || lastIsToolCall;
}

describe("emergencyCompact", () => {
  it("returns history unchanged when it already fits and not forced", () => {
    const messages = fillerHistory(4);
    const outcome = emergencyCompact({ messages, maxTokens: 10_000 });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(messages);
    expect(outcome.reason).toBe("history already fits the limit");
  });

  it("keeps the newest messages that fit, note merged into the head", () => {
    const messages = fillerHistory(30);
    const before = estimateMessagesTokens(messages);
    const outcome = emergencyCompact({ messages, maxTokens: 1_000 });

    expect(outcome.compacted).toBe(true);
    expect(outcome.beforeTokens).toBe(before);
    expect(estimateMessagesTokens(outcome.messages)).toBeLessThanOrEqual(1_000);
    expect(outcome.messages.length).toBeLessThan(messages.length);

    // The note is merged into the first kept user message (no illegal
    // consecutive-user messages for strict providers).
    const head = outcome.messages[0];
    expect(head?.role).toBe("user");
    expect(JSON.stringify(head)).toContain("<context-truncated>");
    expect(JSON.stringify(head)).toContain("Dropped:");

    // The newest message survived verbatim.
    const last = outcome.messages[outcome.messages.length - 1];
    expect(last).toEqual(messages[messages.length - 1]);
  });

  it("force mode halves by count even when the estimate claims it fits", () => {
    // The estimator-drift scenario: provider counted 265k, estimate says 2k.
    const messages = fillerHistory(10);
    const outcome = emergencyCompact({ messages, maxTokens: 1_000_000, force: true });

    expect(outcome.compacted).toBe(true);
    // Newest half kept (ceil(10/2) = 5); the note merges into the head.
    expect(outcome.messages.length).toBe(5);
    expect(JSON.stringify(outcome.messages[0])).toContain("<context-truncated>");
    expect(outcome.messages[outcome.messages.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it("cuts a trailing unresolved tool-call exchange", () => {
    // Walk lands after 3 fillers + the dangling tool-call (no result).
    const messages: ModelMessage[] = [...fillerHistory(8), toolCallMessage("call-1")];
    const outcome = emergencyCompact({ messages, maxTokens: 500 });

    expect(outcome.compacted).toBe(true);
    expect(hasUnresolvedToolCall(outcome.messages)).toBe(false);
    // The unresolved call was dropped; history still ends where continuing is legal.
    expect(outcome.messages[outcome.messages.length - 1]?.role).toBe("user");
  });

  it("keeps a closed tool exchange that fits", () => {
    const messages: ModelMessage[] = [
      ...fillerHistory(8),
      toolCallMessage("call-1"),
      toolResultMessage("call-1"),
    ];
    const outcome = emergencyCompact({ messages, maxTokens: 600 });

    expect(outcome.compacted).toBe(true);
    expect(hasUnresolvedToolCall(outcome.messages)).toBe(false);
    const flat = JSON.stringify(outcome.messages);
    expect(flat).toContain("call-1"); // the resolved exchange survived
    expect(flat).toContain("tool-result");
  });

  it("never starts the tail with an orphan tool result", () => {
    const messages: ModelMessage[] = [...fillerHistory(4), toolResultMessage("orphan")];
    const outcome = emergencyCompact({ messages, maxTokens: 300 });
    expect(outcome.compacted).toBe(true);
    expect(outcome.messages[0]?.role).toBe("user");
    expect(JSON.stringify(outcome.messages)).not.toContain('"tool"');
  });

  it("degenerates to just the note when even the newest message overshoots", () => {
    const huge: ModelMessage = { role: "user", content: "x".repeat(600_000) };
    const outcome = emergencyCompact({ messages: [huge], maxTokens: 1_000 });

    expect(outcome.compacted).toBe(true);
    expect(outcome.messages).toHaveLength(1);
    expect(estimateMessagesTokens(outcome.messages)).toBeLessThanOrEqual(1_000);
  });

  it("keeps its promise: result is always at or under maxTokens", () => {
    for (const maxTokens of [200, 500, 1_000, 5_000]) {
      const outcome = emergencyCompact({ messages: fillerHistory(50), maxTokens });
      expect(estimateMessagesTokens(outcome.messages)).toBeLessThanOrEqual(maxTokens);
    }
  });
});
