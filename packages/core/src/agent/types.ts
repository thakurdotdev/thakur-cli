import type { LanguageModel, ModelMessage } from "ai";
import type { EventBus } from "../events/bus.ts";
import type { HarnessEvent } from "../events/types.ts";
import type { PermissionGate } from "../permissions/types.ts";
import type { ToolContext, ToolDefinition } from "../tools/definition.ts";
import type { SessionStore } from "../session/store.ts";
import type { CompactionPolicy } from "./compaction.ts";

/**
 * Agent loop contracts. The engine owns orchestration but not presentation:
 * it emits events, callers decide how to render them.
 */

export interface RunBudget {
  /** Maximum model steps (each step = one model response; tool loops consume steps). */
  maxSteps?: number;
  /** Cumulative input+output token budget across all steps. */
  maxTotalTokens?: number;
  /**
   * Retry attempts for transient provider errors (rate limits, 5xx, network).
   * Applied per model call with exponential backoff by the AI SDK; 0 disables.
   */
  maxRetries?: number;
}

export interface RunOptions {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: Record<string, ToolDefinition>;
  permissions: PermissionGate;
  events: EventBus<HarnessEvent>;
  toolContext: ToolContext;
  budget?: RunBudget;
  /**
   * When set, the conversation is compacted before the run whenever the
   * context approaches the model's window. Best-effort, fail-open.
   */
  compaction?: CompactionPolicy;
  /**
   * Provider-reported context size from the previous request (last step's
   * input tokens), when the caller has one. Real telemetry beats the
   * char-based estimator for compaction decisions; see shouldCompact.
   */
  observedContextTokens?: number;
  /** When provided, usage and messages are appended to the session transcript. */
  session?: SessionStore;
  /** Cooperative cancellation for the whole run. */
  signal?: AbortSignal;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunResult {
  /** Full conversation including the assistant/tool messages from this run. */
  messages: ModelMessage[];
  /** "stop" | "tool-calls" | "length" | "aborted" | "error" | ... */
  stopReason: string;
  /** Present when stopReason is "error". Clean, human-readable message. */
  error?: string;
  usage: RunUsage;
  steps: number;
  /**
   * Input tokens reported by the provider for the last successful step —
   * the true size of the conversation as the model sees it. Undefined when
   * no step reported usage.
   */
  lastInputTokens?: number;
  /**
   * Set when the provider rejected a request with context_length_exceeded:
   * the model's real context window parsed from the error. Callers should
   * adopt it for compaction math and display (unknown-model case).
   */
  learnedContextWindow?: number;
}

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_MAX_RETRIES = 3;
