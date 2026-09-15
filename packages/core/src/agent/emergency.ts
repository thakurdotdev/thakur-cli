import type { ModelMessage } from "ai";
import { estimateMessagesTokens, estimateTokens } from "../tokens.ts";
import type { CompactionOutcome } from "./compaction.ts";

/**
 * Mechanical, model-free compaction — the seatbelt for in-run recovery.
 *
 * When a request is rejected with context_length_exceeded, a summarization
 * pass cannot necessarily help: sending the oversized history to the
 * summarizer would be rejected for the same reason. This function instead
 * keeps the newest messages that provably fit the target budget, replaces
 * everything older with a truncation note, and guarantees the result is
 * protocol-safe. No model call, deterministic, cannot fail.
 *
 * Unlike session resume (resumableMessages), the recovered history MAY end
 * on a user turn — it is sent straight back to the model, so "the last
 * message is the user's unanswered task" is exactly the right place to
 * resume from, and cutting it would lose the current goal.
 */

/** Count tool-call parts in a message (0 unless it is an assistant message). */
function countToolCalls(message: ModelMessage): number {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return 0;
  }
  let count = 0;
  for (const part of message.content) {
    if (part.type === "tool-call") {
      count += 1;
    }
  }
  return count;
}

/** Count tool-result parts in a message (0 unless it is a tool message). */
function countToolResults(message: ModelMessage): number {
  if (message.role !== "tool" || !Array.isArray(message.content)) {
    return 0;
  }
  let count = 0;
  for (const part of message.content) {
    if (part.type === "tool-result") {
      count += 1;
    }
  }
  return count;
}

/**
 * Sanitize a kept tail for direct re-sending:
 *   - drop tool results whose assistant tool-call is not in the kept history
 *     (orphans can sit at the head OR after a cut),
 *   - cut a trailing exchange with unresolved tool-calls,
 *   - everything else (including a trailing user turn) is kept.
 */
function recoveryTail(messages: ReadonlyArray<ModelMessage>): ModelMessage[] {
  const kept: ModelMessage[] = [];
  let pendingToolCalls = 0;
  let lastSafeIndex = -1; // index into kept

  for (const message of messages) {
    if (message.role === "assistant") {
      const calls = countToolCalls(message);
      pendingToolCalls += calls;
      kept.push(message);
      if (calls === 0) {
        lastSafeIndex = kept.length - 1; // pure-text assistant turn
      }
      continue;
    }
    if (message.role === "tool") {
      if (pendingToolCalls === 0) {
        continue; // orphan result — its call was cut away
      }
      kept.push(message);
      pendingToolCalls -= countToolResults(message);
      if (pendingToolCalls <= 0) {
        pendingToolCalls = 0;
        lastSafeIndex = kept.length - 1;
      }
      continue;
    }
    // A user turn is always safe to end on for an in-run continuation.
    kept.push(message);
    if (pendingToolCalls === 0) {
      lastSafeIndex = kept.length - 1;
    }
  }

  if (pendingToolCalls > 0) {
    return kept.slice(0, lastSafeIndex + 1); // cut unresolved trailing exchange
  }
  return kept;
}

/** Merge the truncation note into a leading user message (role alternation). */
function prependNote(note: string, tail: ReadonlyArray<ModelMessage>): ModelMessage[] {
  const head = tail[0];
  if (head?.role === "user") {
    if (typeof head.content === "string") {
      const merged: ModelMessage = { role: "user", content: `${note}\n\n${head.content}` };
      return [merged, ...tail.slice(1)];
    }
    if (Array.isArray(head.content)) {
      const merged: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: note }, ...head.content],
      };
      return [merged, ...tail.slice(1)];
    }
  }
  return [{ role: "user", content: note }, ...tail];
}

export function emergencyCompact(options: {
  messages: ReadonlyArray<ModelMessage>;
  /** Hard ceiling for the estimated tokens of the returned history. */
  maxTokens: number;
  /**
   * Recovery mode: the provider already rejected this exact history, so the
   * estimate claiming "it fits" is known to be wrong (char estimators drift
   * up to ~3x low on tool-output-heavy histories). Instead of trusting the
   * estimate, keep only the newest half of the messages and retry.
   */
  force?: boolean;
}): CompactionOutcome {
  const beforeTokens = estimateMessagesTokens(options.messages);
  const finishUnchanged = (reason: string): CompactionOutcome => ({
    messages: [...options.messages],
    beforeTokens,
    afterTokens: beforeTokens,
    compacted: false,
    reason,
  });

  if (options.messages.length === 0) {
    return finishUnchanged("no messages to compact");
  }

  const NOTE_OVERHEAD_TOKENS = 128;
  const budget = Math.max(options.maxTokens - NOTE_OVERHEAD_TOKENS, 0);

  const noteTextFor = (droppedCount: number): string =>
    [
      "<context-truncated>",
      "The conversation history was truncated to fit the model's context window.",
      `Dropped: ${droppedCount} message(s) from the older history; no summary of them is available.`,
      "Treat remembered file contents and earlier tool results as stale —",
      "re-read anything important before relying on it.",
      "Continue the user's task from the remaining recent context.",
      "</context-truncated>",
    ].join("\n");

  const buildOutcome = (keptTail: ModelMessage[], droppedCount: number): CompactionOutcome => {
    const noteTextForDropped = (extra: number): string => noteTextFor(droppedCount + extra);
    // The walk is estimate-based; after merging the note the result can
    // still be slightly over budget. Shed the OLDEST kept messages first —
    // never the newest (that is the live task) — until it fits.
    let kept = keptTail;
    let extraDropped = 0;
    let compacted = prependNote(noteTextForDropped(0), kept);
    while (estimateMessagesTokens(compacted) > options.maxTokens && kept.length > 0) {
      const next = kept.slice(1);
      // Dropping the head must not orphan a tool result.
      if (next[0]?.role === "tool") {
        break;
      }
      kept = next;
      extraDropped += 1;
      compacted = prependNote(noteTextForDropped(extraDropped), kept);
    }

    const afterTokens = estimateMessagesTokens(compacted);
    if (afterTokens > options.maxTokens) {
      // Degenerate seatbelt: nothing kept fits (or the budget is tiny).
      // Keep only the note — it is small by construction and protocol-safe.
      const noteText = noteTextFor(droppedCount + extraDropped);
      const noteOnly = estimateMessagesTokens([{ role: "user", content: noteText }]);
      if (noteOnly > options.maxTokens) {
        return finishUnchanged("budget too small for even a truncation note");
      }
      return {
        messages: [{ role: "user", content: noteText }],
        beforeTokens,
        afterTokens: noteOnly,
        compacted: true,
      };
    }
    return {
      messages: compacted,
      beforeTokens,
      afterTokens,
      compacted: true,
    };
  };

  // Forced mode with an estimate that claims to fit: the provider counted
  // more tokens than the estimator does, so token-budgeted trimming would
  // keep the same overflowing content. Halve by count instead — the newest
  // half is the working context; the older half is replaced by the note.
  if (beforeTokens <= options.maxTokens) {
    if (options.force !== true || options.messages.length < 2) {
      return finishUnchanged("history already fits the limit");
    }
    const keepCount = Math.ceil(options.messages.length / 2);
    const tail = recoveryTail(options.messages.slice(options.messages.length - keepCount));
    const dropped = options.messages.length - tail.length;
    if (dropped <= 0) {
      return finishUnchanged("nothing safely droppable");
    }
    return buildOutcome(tail, dropped);
  }

  const costOf = (message: ModelMessage): number => {
    let serialized: string;
    try {
      serialized = JSON.stringify(message) ?? "";
    } catch {
      serialized = "";
    }
    return estimateTokens(serialized) + 4;
  };

  // Greedily keep the newest messages that fit the budget.
  let start = options.messages.length;
  let accumulated = 0;
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index];
    if (message === undefined) {
      break;
    }
    const cost = costOf(message);
    if (accumulated + cost > budget) {
      break;
    }
    accumulated += cost;
    start = index;
  }

  // Trim the kept slice to a protocol-safe boundary (leading orphan tool
  // results dropped, unresolved trailing tool-call exchange cut).
  const tail = recoveryTail(options.messages.slice(start));

  const dropped = options.messages.length - tail.length;
  if (dropped <= 0) {
    return finishUnchanged("nothing safely droppable");
  }
  return buildOutcome(tail, dropped);
}
