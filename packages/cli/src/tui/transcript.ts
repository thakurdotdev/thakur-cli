import type { HarnessEvent } from "@harness/core";
import { clip, describeToolResult, describeToolCall } from "../renderers/format.ts";

/**
 * Pure transcript state for the Ink TUI.
 *
 * The engine speaks HarnessEvent; the TUI speaks TranscriptItem. This module
 * is the one-directional reducer between them — no React, no I/O — so the
 * trickiest UI logic (streaming text flushes, thought blocks, tool
 * call/result pairing, turn boundaries) is unit-testable without mounting
 * anything.
 *
 * Rendering model (opencode-style): finalized items go into an Ink <Static>
 * block (immutable once displayed), while the live region shows the streaming
 * partial line, the in-progress thought, and the executing tool. Complete
 * lines of streamed text are flushed into the transcript as they arrive so
 * long answers scroll like in claude-code; only the trailing partial line
 * stays live. Thought (reasoning) deltas accumulate separately and flush as
 * a "Thought" block before the next assistant/tool boundary.
 */

export type TranscriptItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "thought"; id: number; text: string; ms?: number | undefined }
  | {
      kind: "tool";
      id: number;
      name: string;
      /** Full header, e.g. `Read(src/index.ts)` — claude-code style. */
      display: string;
      /** Unique tool call id for pairing multiple concurrent/sequential calls. */
      callId?: string;
      /** undefined while the call is still executing. */
      ok: boolean | undefined;
      summary: string;
      ms: number;
      /** Raw tool input from the model — drives opencode-style diff previews. */
      input?: unknown;
      /** Raw ok-result data — drives created/line-count badges. */
      data?: unknown;
    }
  | { kind: "error"; id: number; message: string; hint?: string }
  | { kind: "compaction"; id: number; before: number; after: number }
  | { kind: "info"; id: number; text: string }
  | { kind: "summary"; id: number; text: string };

export interface LiveState {
  /** Streaming text not yet flushed to the transcript (partial line only). */
  text: string;
  /** Accumulated reasoning deltas not yet flushed as a Thought block. */
  thinking: string;
  /** Wall-clock ms when the current thought started (for the · Xms label). */
  thinkingStartedAt?: number | undefined;
  /** Tool currently executing — drives the spinner label. */
  toolName: string | undefined;
}

export interface TuiState {
  items: TranscriptItem[];
  live: LiveState;
  busy: boolean;
}

export function initialTuiState(): TuiState {
  return { items: [], live: { text: "", thinking: "", toolName: undefined }, busy: false };
}

let nextId = 1;
function freshId(): number {
  const id = nextId;
  nextId += 1;
  return id;
}

/** Append an item without mutating the input state. */
function withItem(state: TuiState, item: TranscriptItem): TuiState {
  return { ...state, items: [...state.items, item] };
}

/** Move complete streaming lines into the transcript; keep the partial tail. */
export function flushLiveLines(state: TuiState): TuiState {
  const text = state.live.text;
  if (text.length === 0) {
    return state;
  }
  const newlineAt = text.lastIndexOf("\n");
  if (newlineAt < 0) {
    return state;
  }
  const complete = text.slice(0, newlineAt);
  const rest = text.slice(newlineAt + 1);
  return {
    ...state,
    items: [...state.items, { kind: "assistant", id: freshId(), text: complete }],
    live: { ...state.live, text: rest },
  };
}

/** Flush any residual streaming text (partial line included) as an assistant chunk. */
export function flushAllLiveText(state: TuiState): TuiState {
  if (state.live.text.length === 0) {
    return state;
  }
  return {
    ...state,
    items: [...state.items, { kind: "assistant", id: freshId(), text: state.live.text }],
    live: { ...state.live, text: "" },
  };
}

/** Flush accumulated reasoning as a Thought block (opencode-style). */
export function flushThinking(state: TuiState): TuiState {
  if (state.live.thinking.length === 0) {
    return state;
  }
  const startedAt = state.live.thinkingStartedAt;
  const ms = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined;
  return {
    ...state,
    items: [
      ...state.items,
      {
        kind: "thought",
        id: freshId(),
        text: state.live.thinking,
        ...(ms !== undefined ? { ms } : {}),
      },
    ],
    live: { ...state.live, thinking: "", thinkingStartedAt: undefined },
  };
}

/** Flush thought first, then residual text — the standard turn boundary. */
function flushPending(state: TuiState): TuiState {
  return flushAllLiveText(flushThinking(state));
}

/**
 * One event → next state. Events the TUI does not display (usage, step, run
 * bookkeeping) return the state untouched.
 */
export function reduceEvent(state: TuiState, event: HarnessEvent): TuiState {
  switch (event.type) {
    case "run:start": {
      return {
        ...state,
        busy: true,
        live: { ...state.live, thinking: "", thinkingStartedAt: undefined, toolName: undefined },
      };
    }
    case "step:start":
    case "usage": {
      return state;
    }
    case "thinking:delta": {
      if (event.text.length === 0) {
        return state;
      }
      return {
        ...state,
        live: {
          ...state.live,
          thinking: state.live.thinking + event.text,
          thinkingStartedAt: state.live.thinkingStartedAt ?? Date.now(),
        },
      };
    }
    case "text:delta": {
      // A Thought block always precedes its narration (opencode order).
      const afterThought = flushThinking(state);
      const withDelta: TuiState = {
        ...afterThought,
        live: { ...afterThought.live, text: afterThought.live.text + event.text },
      };
      return flushLiveLines(withDelta);
    }
    case "tool:call": {
      // Any pending thought + streamed sentence becomes transcript chunks
      // before the tool header so narration never merges into tool output.
      const flushed = flushPending(state);
      return withItem(
        { ...flushed, live: { ...flushed.live, toolName: event.name } },
        {
          kind: "tool",
          id: freshId(),
          ...(event.id !== undefined ? { callId: event.id } : {}),
          name: event.name,
          display: describeToolCall(event.name, event.input),
          ok: undefined,
          summary: "",
          ms: 0,
          input: event.input,
        },
      );
    }
    case "tool:result": {
      const data = event.result.ok ? event.result.data : undefined;
      // Pair with the pending tool item matching this tool call ID or name (FIFO scan).
      const items = [...state.items];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item !== undefined && item.kind === "tool" && item.ok === undefined) {
          const matchesId = event.id !== undefined && item.callId === event.id;
          const matchesName = event.id === undefined && item.name === event.name;
          if (matchesId || matchesName) {
            items[i] = {
              ...item,
              ok: event.result.ok,
              summary: event.result.ok
                ? describeToolResult(event.name, event.result.data)
                : clip(event.result.error, 200),
              ms: event.ms,
              ...(data !== undefined ? { data } : {}),
            };
            return {
              ...state,
              items,
              live: { ...state.live, toolName: undefined },
            };
          }
        }
      }
      // Fallback: any pending tool item if tool name didn't match directly.
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item !== undefined && item.kind === "tool" && item.ok === undefined) {
          items[i] = {
            ...item,
            ok: event.result.ok,
            summary: event.result.ok
              ? describeToolResult(event.name, event.result.data)
              : clip(event.result.error, 200),
            ms: event.ms,
            ...(data !== undefined ? { data } : {}),
          };
          return {
            ...state,
            items,
            live: { ...state.live, toolName: undefined },
          };
        }
      }
      // Result without a visible call (e.g. flushed between renders):
      // synthesize the pair so nothing is silently dropped.
      return withItem(
        { ...state, live: { ...state.live, toolName: undefined } },
        {
          kind: "tool",
          id: freshId(),
          name: event.name,
          display: describeToolCall(event.name, undefined),
          ok: event.result.ok,
          summary: event.result.ok
            ? describeToolResult(event.name, event.result.data)
            : clip(event.result.error, 200),
          ms: event.ms,
          ...(data !== undefined ? { data } : {}),
        },
      );
    }
    case "compaction": {
      const flushed = flushPending(state);
      return withItem(flushed, {
        kind: "compaction",
        id: freshId(),
        before: event.before,
        after: event.after,
      });
    }
    case "error": {
      const flushed = flushPending(state);
      return withItem(flushed, {
        kind: "error",
        id: freshId(),
        message: clip(event.message, 300),
        ...(event.hint !== undefined ? { hint: event.hint } : {}),
      });
    }
    case "done": {
      const flushed = flushPending(state);
      return { ...flushed, busy: false, live: { ...flushed.live, toolName: undefined } };
    }
    case "reflection": {
      const flushed = flushPending(state);
      return withItem(flushed, {
        kind: "info",
        id: freshId(),
        text: `⚡ ${clip(event.message, 300)}`,
      });
    }
    case "progress": {
      const flushed = flushPending(state);
      return withItem(flushed, {
        kind: "info",
        id: freshId(),
        text: `⏳ ${clip(event.message, 300)}`,
      });
    }
    default: {
      return state;
    }
  }
}

/** Push a user prompt into the transcript (rendered as the input echo). */
export function pushUser(state: TuiState, text: string): TuiState {
  return withItem(flushPending(state), { kind: "user", id: freshId(), text });
}

/** Push an informational line (model switches, warnings, help). */
export function pushInfo(state: TuiState, text: string): TuiState {
  return withItem(flushPending(state), { kind: "info", id: freshId(), text });
}

/** Push the per-run totals line ("4 steps · 12k in / 1.2k out · ..."). */
export function pushSummary(state: TuiState, text: string): TuiState {
  return withItem(flushPending(state), { kind: "summary", id: freshId(), text });
}

/**
 * UI mode selection. "auto" prefers the Ink TUI on interactive terminals and
 * falls back to the plain renderer everywhere else (pipes, CI, dumb terms).
 */
export function selectUiMode(
  requested: "auto" | "tui" | "plain",
  stdout: { isTTY?: boolean } | undefined,
  env: Record<string, string | undefined>,
): "tui" | "plain" {
  if (requested === "plain") {
    return "plain";
  }
  const interactive = stdout?.isTTY === true && env["TERM"] !== "dumb";
  return interactive ? "tui" : "plain";
}
