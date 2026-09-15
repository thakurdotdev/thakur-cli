import type { ToolResult } from "../result.ts";

/**
 * The typed event bus payload.
 *
 * The event bus is the primary decoupling mechanism between the engine and its
 * renderers (plain stdout renderer now, Ink TUI later). Renderers subscribe and
 * switch exhaustively; the compiler flags unhandled event types.
 *
 * Tool names are plain strings here because `core` must not depend on the
 * tools package (dependency direction: tools -> core).
 */
export type HarnessEvent =
  | { type: "run:start"; model: string; cwd: string }
  | { type: "step:start"; step: number }
  | { type: "text:delta"; text: string }
  /** Model reasoning stream (opencode-style "Thought" blocks). */
  | { type: "thinking:delta"; text: string }
  | { type: "tool:call"; name: string; input: unknown; id?: string }
  | { type: "tool:result"; name: string; result: ToolResult<unknown>; ms: number; id?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "compaction"; before: number; after: number }
  /**
   * A run-level failure. Emitted once for fatal errors (the run ends right
   * after) and once when a context overflow triggers compaction + retry
   * (the run continues). The message is always clean — one human sentence,
   * never a stack trace or provider payload.
   */
  | { type: "error"; message: string; hint?: string }
  /**
   * Self-correction hint injected when the agent appears stuck (e.g.
   * consecutive tool failures). The message is informational — renderers
   * may display it or ignore it.
   */
  | { type: "reflection"; message: string }
  /**
   * Step budget progress. Emitted when the run approaches its step limit
   * so renderers can show a heads-up.
   */
  | { type: "progress"; message: string; step: number; maxSteps: number }
  | { type: "done"; stopReason: string };

/** Compile-time exhaustiveness helper for event switches. */
export function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled harness event: ${JSON.stringify(event)}`);
}
