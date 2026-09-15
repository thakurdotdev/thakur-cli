import { streamText, stepCountIs } from "ai";
import type { ModelMessage, StopCondition, ToolSet } from "ai";
import { toGatedAiTools } from "./gating.ts";
import { RECOVERY_TARGET_RATIO, compactMessages } from "./compaction.ts";
import { emergencyCompact } from "./emergency.ts";
import { detectContextOverflow, describeApiError, formatTokens } from "./overflow.ts";
import { DEFAULT_MAX_RETRIES, DEFAULT_MAX_STEPS } from "./types.ts";
import type { RunOptions, RunResult, RunUsage } from "./types.ts";
import { describeError, isAbortError } from "../result.ts";

/**
 * The agent loop.
 *
 * The engine emits events; renderers subscribe. Compaction, permissions,
 * sessions, cancellation and tool execution are independent modules composed
 * here. The loop must never depend on CLI/presentation code.
 *
 * Context-window recovery: if the provider rejects a request because it
 * exceeds the model's context window, the loop mechanically truncates the
 * history (emergencyCompact — a summarization pass itself would be rejected
 * for the same reason) and retries the run once against the truncated
 * history. Successful steps from before the overflow are kept.
 */

/** One in-run overflow recovery attempt — beyond that, failures are fatal. */
const MAX_OVERFLOW_RECOVERIES = 1;

/** Consecutive failures of the same tool before emitting a reflection event. */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/** Fraction of maxSteps at which a budget warning is emitted. */
const STEP_BUDGET_WARNING_RATIO = 0.8;

async function safeAwait<T>(supplier: () => PromiseLike<T>): Promise<T | undefined> {
  try {
    return await supplier();
  } catch {
    return undefined;
  }
}

function sumUsage(
  steps: ReadonlyArray<{
    usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  }>,
): {
  inputTokens: number;
  outputTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of steps) {
    inputTokens += step.usage.inputTokens ?? 0;
    outputTokens += step.usage.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const { model, system, tools, permissions, events, toolContext, session, signal } = options;
  const maxSteps = options.budget?.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxTotalTokens = options.budget?.maxTotalTokens ?? Number.POSITIVE_INFINITY;
  const maxRetries = options.budget?.maxRetries ?? DEFAULT_MAX_RETRIES;

  const modelLabel = typeof model === "string" ? model : model.modelId;
  events.emit({ type: "run:start", model: modelLabel, cwd: toolContext.cwd });

  let stepCount = 0;
  let budgetWarningEmitted = false;

  // Consecutive failure tracking: when the same tool fails repeatedly, the
  // model is likely stuck in a retry loop. A reflection event gives both the
  // renderer and (on the next step) the model a chance to course-correct.
  const consecutiveFailures = new Map<string, number>();
  let lastFailedTool: string | undefined;

  // Context compaction runs before the first model call: history is replaced
  // by a summarized head plus a verbatim tail. Best-effort — on failure the
  // run proceeds with the original messages (fail-open). Provider-reported
  // context size from the previous request (observedContextTokens) beats the
  // char-based estimate when deciding whether to compact.
  let effectiveMessages: ModelMessage[] = options.messages;
  if (options.compaction !== undefined) {
    const outcome = await compactMessages({
      model,
      system,
      messages: options.messages,
      policy: options.compaction,
      ...(options.observedContextTokens !== undefined && options.observedContextTokens > 0
        ? { observedTokens: options.observedContextTokens }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
      maxRetries,
    });
    if (outcome.compacted) {
      effectiveMessages = outcome.messages;
      events.emit({ type: "compaction", before: outcome.beforeTokens, after: outcome.afterTokens });
      session?.appendCompaction(outcome.beforeTokens, outcome.afterTokens);
    }
  }

  const tokenBudgetExceeded: StopCondition<ToolSet> = ({ steps }) => {
    const total = sumUsage(steps);
    return total.inputTokens + total.outputTokens > maxTotalTokens;
  };

  // State that survives across recovery attempts.
  let stopReason = "other";
  let runError: string | undefined;
  let learnedContextWindow: number | undefined;
  let lastInputTokens: number | undefined;
  const allResponseMessages: ModelMessage[] = [];
  let steppedInputTokens = 0;
  let steppedOutputTokens = 0;
  let totalsInputTokens = 0;
  let totalsOutputTokens = 0;

  const onStepFinish = (step: {
    usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
  }): void => {
    // Provider quirks can omit usage on partial steps — never throw here.
    const inputTokens = step.usage?.inputTokens ?? 0;
    const outputTokens = step.usage?.outputTokens ?? 0;
    steppedInputTokens += inputTokens;
    steppedOutputTokens += outputTokens;
    if (inputTokens > 0) {
      lastInputTokens = inputTokens;
    }
    events.emit({ type: "usage", inputTokens, outputTokens });
    session?.appendUsage(inputTokens, outputTokens);
  };

  const isAborted = (): boolean => signal?.aborted === true;

  attemptLoop: for (let attempt = 0; ; attempt += 1) {
    if (isAborted()) {
      stopReason = "aborted";
      break;
    }

    let streamError: unknown;
    let aborted = false;

    const result = streamText({
      model,
      system,
      messages: effectiveMessages,
      tools: toGatedAiTools({ definitions: tools, context: toolContext, permissions, events }),
      stopWhen: [stepCountIs(maxSteps), tokenBudgetExceeded],
      maxRetries,
      onStepFinish,
      // Provide an explicit onError callback to prevent AI SDK from falling back
      // to its default `console.error(error)` which dumps raw internal objects & stack traces.
      onError: ({ error }) => {
        if (isAbortError(error) || isAborted()) {
          aborted = true;
          stopReason = "aborted";
        } else if (streamError === undefined) {
          streamError = error;
        }
      },
      // exactOptionalPropertyTypes: only include abortSignal when present
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    });

    // Suppress unhandled promise rejections on result properties when doStream fails early.
    const noopCatch = () => {};
    void result.text.then(undefined, noopCatch);
    void result.responseMessages.then(undefined, noopCatch);
    void result.totalUsage.then(undefined, noopCatch);
    void result.steps.then(undefined, noopCatch);

    try {
      for await (const chunk of result.fullStream) {
        switch (chunk.type) {
          case "start-step": {
            events.emit({ type: "step:start", step: stepCount });
            stepCount += 1;

            // Step budget warning: emit once when approaching the limit.
            if (
              !budgetWarningEmitted &&
              maxSteps < Number.POSITIVE_INFINITY &&
              stepCount >= Math.floor(maxSteps * STEP_BUDGET_WARNING_RATIO)
            ) {
              budgetWarningEmitted = true;
              const remaining = maxSteps - stepCount;
              events.emit({
                type: "progress",
                message: `${remaining} step${remaining === 1 ? "" : "s"} remaining out of ${maxSteps} — prioritize completing the most important changes.`,
                step: stepCount,
                maxSteps,
              });
            }
            break;
          }
          case "text-delta": {
            events.emit({ type: "text:delta", text: chunk.text });
            break;
          }
          case "reasoning-delta": {
            const delta =
              (chunk as { delta?: unknown }).delta ?? (chunk as { text?: unknown }).text;
            if (typeof delta === "string" && delta.length > 0) {
              events.emit({ type: "thinking:delta", text: delta });
            }
            break;
          }
          case "tool-error": {
            // Invalid tool input caught by AI SDK validation — surfaced as an
            // error result so the model can correct itself next step.
            events.emit({
              type: "tool:result",
              name: chunk.toolName,
              result: { ok: false, error: describeError(chunk.error) },
              ms: 0,
            });

            // Track consecutive failures for the same tool.
            if (lastFailedTool === chunk.toolName) {
              const count = (consecutiveFailures.get(chunk.toolName) ?? 0) + 1;
              consecutiveFailures.set(chunk.toolName, count);
              if (count >= CONSECUTIVE_FAILURE_THRESHOLD) {
                events.emit({
                  type: "reflection",
                  message: `Tool "${chunk.toolName}" has failed ${count} times in a row. Consider a different approach: re-read relevant files, check your assumptions, or try a different tool.`,
                });
                consecutiveFailures.set(chunk.toolName, 0); // reset to avoid spamming
              }
            } else {
              lastFailedTool = chunk.toolName;
              consecutiveFailures.set(chunk.toolName, 1);
            }
            break;
          }
          case "finish": {
            stopReason = chunk.finishReason;
            break;
          }
          case "abort": {
            aborted = true;
            stopReason = "aborted";
            break;
          }
          case "error": {
            streamError = chunk.error;
            break;
          }
          default:
            // tool-input-*, source, file, raw, custom, reasoning-start/end …
            break;
        }
        if (streamError !== undefined || aborted) {
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || isAborted()) {
        aborted = true;
        stopReason = "aborted";
      } else {
        streamError = error;
      }
    }

    // Collect this attempt's outputs. These promises can reject after a
    // stream error — tolerate both outcomes.
    const attemptResponseMessages = (await safeAwait(() => result.responseMessages)) ?? [];
    const attemptTotals = await safeAwait(() => result.totalUsage);
    totalsInputTokens += attemptTotals?.inputTokens ?? 0;
    totalsOutputTokens += attemptTotals?.outputTokens ?? 0;
    allResponseMessages.push(...attemptResponseMessages);
    effectiveMessages = [...effectiveMessages, ...attemptResponseMessages];

    if (streamError === undefined) {
      break; // clean end (stop, tool-calls, length, abort …)
    }

    // --- Error handling -------------------------------------------------
    if (aborted || isAbortError(streamError) || isAborted()) {
      stopReason = "aborted";
      break;
    }

    const overflow = detectContextOverflow(streamError);
    const canRecover = overflow !== undefined && attempt < MAX_OVERFLOW_RECOVERIES;

    if (canRecover && overflow !== undefined) {
      const target = Math.floor(overflow.limit * RECOVERY_TARGET_RATIO);
      const outcome = emergencyCompact({
        messages: effectiveMessages,
        maxTokens: target,
        // The provider just rejected this history — if the estimator claims
        // it fits the target, the estimate is wrong. Force the truncation.
        force: true,
      });
      if (outcome.compacted) {
        // Teach the caller the model's real window (unknown-model case).
        learnedContextWindow = overflow.limit;
        effectiveMessages = outcome.messages;
        events.emit({
          type: "error",
          message: [
            `context window exceeded — request ~${formatTokens(overflow.used ?? outcome.beforeTokens)} tokens`,
            `vs ${formatTokens(overflow.limit)} limit`,
            "compacting history and retrying",
          ].join(" · "),
        });
        events.emit({
          type: "compaction",
          before: outcome.beforeTokens,
          after: outcome.afterTokens,
        });
        session?.appendCompaction(outcome.beforeTokens, outcome.afterTokens);
        continue attemptLoop;
      }
      // Could not compact (history too short / nothing droppable) — fall
      // through to the fatal path below.
    }

    stopReason = "error";
    runError = describeApiError(streamError);
    events.emit({ type: "error", message: runError });
    if (process.env["HARNESS_DEBUG"] === "1") {
      // Debug escape hatch: the event bus deliberately carries clean strings,
      // so raw provider payloads are only shown when explicitly requested.
      console.error("[harness:debug] stream error:", streamError);
    }
    break;
  }

  if (session !== undefined) {
    for (const message of allResponseMessages) {
      session.appendMessage(message as ModelMessage);
    }
    session.appendDone(stopReason);
  }

  events.emit({ type: "done", stopReason });

  // Step-by-step accumulation is the primary usage source (it survives
  // post-error promise rejections); the SDK totals are the fallback when no
  // step reported usage at all.
  const inputTokens = steppedInputTokens > 0 ? steppedInputTokens : totalsInputTokens;
  const outputTokens = steppedOutputTokens > 0 ? steppedOutputTokens : totalsOutputTokens;
  const usage: RunUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };

  return {
    messages: effectiveMessages,
    stopReason,
    ...(runError !== undefined ? { error: runError } : {}),
    usage,
    steps: stepCount,
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    ...(learnedContextWindow !== undefined ? { learnedContextWindow } : {}),
  };
}
