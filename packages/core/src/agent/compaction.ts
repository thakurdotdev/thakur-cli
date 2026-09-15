import { streamText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { estimateMessagesTokens, estimateTokens } from "../tokens.ts";
import { resumableMessages } from "../session/resume.ts";

/**
 * Context compaction.
 *
 * When the estimated context (system prompt + messages) approaches the
 * model's real context window, the oldest messages are replaced by a model
 * written summary. Recent messages are kept verbatim so the agent keeps its
 * immediate working state.
 *
 * Compaction is best-effort and fails open: if the summarization call fails,
 * the conversation continues uncompacted rather than aborting the user's
 * task. Estimates use the conservative char-based heuristic from tokens.ts —
 * never provider telemetry, which only exists after a request.
 */

export interface CompactionPolicy {
  /** Real context window of the target model, in tokens. */
  contextWindow: number;
  /** Compact when estimated tokens exceed this fraction of the window. */
  triggerRatio?: number;
  /** Newest messages kept verbatim outside the summary. */
  keepRecentMessages?: number;
}

export const DEFAULT_TRIGGER_RATIO = 0.8;
export const DEFAULT_KEEP_RECENT_MESSAGES = 6;

/**
 * Assumed context window when the model is unknown to the catalog and no
 * config override exists. Conservative by modern standards (262k models are
 * common) — but it means unknown models still get proactive compaction
 * instead of never compacting and dying with context_length_exceeded.
 */
export const FALLBACK_CONTEXT_WINDOW = 131_072;

/** After an in-run overflow, truncate history to this fraction of the real limit. */
export const RECOVERY_TARGET_RATIO = 0.6;

export interface CompactionOutcome {
  /** The messages to use going forward (summarized head + verbatim tail). */
  messages: ModelMessage[];
  beforeTokens: number;
  afterTokens: number;
  compacted: boolean;
  /** Why compaction was skipped — always set when compacted is false. */
  reason?: string;
}

export const COMPACTION_SYSTEM_PROMPT = [
  "You compress coding-agent conversations into dense handoff notes.",
  "Preserve, in this priority: (1) the user's current goal verbatim,",
  "(2) concrete state — file paths created or edited, commands run and their",
  "outcomes, errors hit and how they were resolved, (3) decisions made and",
  "alternatives rejected, (4) the exact next steps the agent was about to take.",
  "Keep tool results only as one-line outcomes. Never invent facts.",
  "Output only the summary, no preamble.",
].join(" ");

const MAX_CHARS_PER_MESSAGE = 4_000;
const MAX_TOTAL_SUMMARY_INPUT_CHARS = 400_000;

function messageToText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  try {
    return JSON.stringify(message.content) ?? "";
  } catch {
    return "";
  }
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function serializeForSummary(messages: ReadonlyArray<ModelMessage>): string {
  const lines: string[] = [];
  let total = 0;
  for (const message of messages) {
    const line = clip(messageToText(message), MAX_CHARS_PER_MESSAGE);
    total += line.length + 12;
    if (total > MAX_TOTAL_SUMMARY_INPUT_CHARS) {
      lines.push("...[older transcript elided]");
      break;
    }
    lines.push(`[${message.role}]: ${line}`);
  }
  return lines.join("\n");
}

/**
 * Trim a verbatim tail so it is protocol-safe to prepend a summary to:
 * leading tool results whose assistant tool-call was summarized away are
 * dropped, then an unclosed trailing tool-call exchange is cut.
 */
function safeTail(messages: ReadonlyArray<ModelMessage>): ModelMessage[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role === "tool") {
    start += 1;
  }
  return resumableMessages(messages.slice(start));
}

/** Estimated tokens (system + messages) versus the compaction trigger. */
export function shouldCompact(options: {
  system: string;
  messages: ReadonlyArray<ModelMessage>;
  policy: CompactionPolicy;
  /**
   * Provider-reported context size from the previous request (last step's
   * input tokens). The char-based estimator drifts up to ~2.7x low on
   * tool-output-heavy histories, so when real telemetry exists it wins.
   */
  observedTokens?: number;
}): boolean {
  const ratio = options.policy.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
  const estimated = estimateTokens(options.system) + estimateMessagesTokens(options.messages);
  const current = Math.max(estimated, options.observedTokens ?? 0);
  return current > ratio * options.policy.contextWindow;
}

/**
 * Compact a conversation. Returns the original messages untouched (compacted
 * false, with a reason) whenever compaction is unnecessary, unnecessary-by-
 * size, or the summarization call fails.
 */
export async function compactMessages(options: {
  model: LanguageModel;
  system: string;
  messages: ReadonlyArray<ModelMessage>;
  policy: CompactionPolicy;
  /** Provider-reported context size from the previous request, when known. */
  observedTokens?: number;
  signal?: AbortSignal;
  maxRetries?: number;
}): Promise<CompactionOutcome> {
  const keep = options.policy.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const observed = options.observedTokens ?? 0;
  const beforeTokens = Math.max(
    estimateTokens(options.system) + estimateMessagesTokens(options.messages),
    observed,
  );

  const finish = (result: Omit<CompactionOutcome, "beforeTokens">): CompactionOutcome => ({
    ...result,
    beforeTokens,
  });

  if (
    shouldCompact({
      system: options.system,
      messages: options.messages,
      policy: options.policy,
      ...(observed > 0 ? { observedTokens: observed } : {}),
    }) === false
  ) {
    return finish({
      messages: [...options.messages],
      afterTokens: beforeTokens,
      compacted: false,
      reason: "context under trigger threshold",
    });
  }
  if (options.messages.length <= keep + 1) {
    return finish({
      messages: [...options.messages],
      afterTokens: beforeTokens,
      compacted: false,
      reason: "history too short to compact",
    });
  }

  const split = options.messages.length - keep;
  const tail = safeTail(options.messages.slice(split));
  // Whatever the tail trimming dropped must still reach the summary.
  const summaryInput = options.messages.slice(0, options.messages.length - tail.length);

  if (tail.length === 0 || summaryInput.length === 0) {
    return finish({
      messages: [...options.messages],
      afterTokens: beforeTokens,
      compacted: false,
      reason: "nothing safely compactable",
    });
  }

  try {
    // streamText (not generateText) keeps one streaming code path through the
    // engine — the same path the main loop uses and the same mock shapes.
    let summaryText = "";
    let streamError: unknown;

    const streamed = streamText({
      model: options.model,
      system: COMPACTION_SYSTEM_PROMPT,
      prompt: [
        "Compress this coding-agent transcript into a handoff note.",
        "Keep the user's goal, file paths, command outcomes, decisions, and next steps.",
        "",
        "Transcript:",
        serializeForSummary(summaryInput),
      ].join("\n"),
      onError: ({ error }) => {
        if (streamError === undefined) {
          streamError = error;
        }
      },
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });

    const noopCatch = () => {};
    void streamed.text.then(undefined, noopCatch);
    void streamed.responseMessages.then(undefined, noopCatch);
    void streamed.totalUsage.then(undefined, noopCatch);
    void streamed.steps.then(undefined, noopCatch);

    for await (const chunk of streamed.fullStream) {
      if (chunk.type === "text-delta") {
        summaryText += chunk.text;
      } else if (chunk.type === "error") {
        streamError = chunk.error;
      }
    }
    if (streamError !== undefined) {
      throw streamError;
    }

    summaryText = summaryText.trim().length > 0 ? summaryText.trim() : "(empty summary)";
    const head: ModelMessage = {
      role: "user",
      content: [
        "<context-summary>",
        "Earlier conversation replaced by this note to fit the context window:",
        "",
        summaryText,
        "</context-summary>",
        "Continue from this state. Ask for nothing — act on the goal above.",
      ].join("\n"),
    };
    const compactedMessages = [head, ...tail];
    const afterTokens = estimateTokens(options.system) + estimateMessagesTokens(compactedMessages);

    return {
      messages: compactedMessages,
      beforeTokens,
      afterTokens,
      compacted: true,
    };
  } catch (error) {
    return finish({
      messages: [...options.messages],
      afterTokens: beforeTokens,
      compacted: false,
      reason: `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
