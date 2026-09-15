import { describe, expect, it } from "vitest";
import {
  flushAllLiveText,
  flushLiveLines,
  initialTuiState,
  pushInfo,
  pushSummary,
  pushUser,
  reduceEvent,
  selectUiMode,
} from "../src/tui/transcript.ts";
import { navigateHistory } from "../src/tui/App.tsx";
import type { TuiState } from "../src/tui/transcript.ts";

/**
 * Pure TUI state tests — no React mounting. The reducer is the contract
 * between the engine's event stream and everything the user sees.
 */

const okResult = (data: unknown) => ({ ok: true as const, data });
const errResult = (error: string) => ({ ok: false as const, error });

describe("tui transcript reducer", () => {
  it("starts idle and empty", () => {
    const state = initialTuiState();
    expect(state.items).toEqual([]);
    expect(state.live).toEqual({ text: "", thinking: "", toolName: undefined });
    expect(state.busy).toBe(false);
  });

  it("accumulates text deltas and flushes complete lines into the transcript", () => {
    let state = initialTuiState();
    state = reduceEvent(state, { type: "run:start", model: "m", cwd: "/tmp" });
    expect(state.busy).toBe(true);

    state = reduceEvent(state, { type: "text:delta", text: "Hello" });
    expect(state.live.text).toBe("Hello");
    expect(state.items).toHaveLength(0);

    state = reduceEvent(state, { type: "text:delta", text: " world\n" });
    // Complete line moved out; only the (empty) partial tail stays live.
    expect(state.live.text).toBe("");
    expect(state.items).toHaveLength(1);
    const chunk = state.items[0];
    expect(chunk?.kind).toBe("assistant");
    if (chunk?.kind === "assistant") {
      expect(chunk.text).toBe("Hello world");
    }
  });

  it("flushes narration before a tool call and pairs the result into the tool item", () => {
    let state = initialTuiState();
    state = reduceEvent(state, { type: "text:delta", text: "Checking files" });
    state = reduceEvent(state, {
      type: "tool:call",
      name: "bash",
      input: { command: "ls -la" },
    });

    expect(state.items).toHaveLength(2);
    expect(state.items[0]?.kind).toBe("assistant");
    expect(state.live.toolName).toBe("bash");
    const call = state.items[1];
    expect(call?.kind).toBe("tool");
    if (call?.kind === "tool") {
      expect(call.display).toBe("Bash(ls -la)");
      expect(call.ok).toBeUndefined();
    }

    state = reduceEvent(state, {
      type: "tool:result",
      name: "bash",
      result: okResult("file1\nfile2\nfile3"),
      ms: 12,
    });
    expect(state.live.toolName).toBeUndefined();
    const paired = state.items[1];
    if (paired?.kind === "tool") {
      expect(paired.ok).toBe(true);
      expect(paired.summary).toBe("3 lines");
      expect(paired.ms).toBe(12);
    } else {
      expect.unreachable("tool item missing");
    }
  });

  it("marks failing tool results and surfaces the error text", () => {
    let state = initialTuiState();
    state = reduceEvent(state, {
      type: "tool:call",
      name: "read_file",
      input: { path: "missing.txt" },
    });
    state = reduceEvent(state, {
      type: "tool:result",
      name: "read_file",
      result: errResult("ENOENT: no such file"),
      ms: 1,
    });
    const item = state.items[0];
    if (item?.kind === "tool") {
      expect(item.ok).toBe(false);
      expect(item.display).toBe("Read(missing.txt)");
      expect(item.summary).toContain("ENOENT");
    } else {
      expect.unreachable("tool item missing");
    }
  });

  it("synthesizes a tool item when a result arrives without a visible call", () => {
    const state = reduceEvent(initialTuiState(), {
      type: "tool:result",
      name: "grep",
      result: okResult("match"),
      ms: 3,
    });
    expect(state.items).toHaveLength(1);
    const item = state.items[0];
    expect(item?.kind).toBe("tool");
    if (item?.kind === "tool") {
      expect(item.display).toBe("Grep(…)");
      expect(item.ok).toBe(true);
    }
  });

  it("renders compaction, error and done events; done clears busy state", () => {
    let state = initialTuiState();
    state = reduceEvent(state, { type: "run:start", model: "m", cwd: "/tmp" });
    state = reduceEvent(state, { type: "compaction", before: 200_000, after: 80_000 });
    state = reduceEvent(state, {
      type: "error",
      message: "context window exceeded",
      hint: "history compacted",
    });
    state = reduceEvent(state, { type: "text:delta", text: "partial" });
    state = reduceEvent(state, { type: "done", stopReason: "stop" });

    const kinds = state.items.map((item) => item.kind);
    expect(kinds).toEqual(["compaction", "error", "assistant"]);
    const errorItem = state.items[1];
    if (errorItem?.kind === "error") {
      expect(errorItem.message).toBe("context window exceeded");
      expect(errorItem.hint).toBe("history compacted");
    } else {
      expect.unreachable("error item missing");
    }
    expect(state.items[2]?.kind === "assistant" && state.items[2].text).toBe("partial");
    expect(state.busy).toBe(false);
    expect(state.live.text).toBe("");
  });

  it("ignores usage and step events without changing identity", () => {
    const state = initialTuiState();
    expect(reduceEvent(state, { type: "usage", inputTokens: 1, outputTokens: 2 })).toBe(state);
    expect(reduceEvent(state, { type: "step:start", step: 1 })).toBe(state);
  });

  it("push helpers append user, info and summary items", () => {
    let state = initialTuiState();
    state = pushUser(state, "fix the bug");
    state = pushInfo(state, "model switched");
    state = pushSummary(state, "1 step · 1k in / 10 out · stop");
    expect(state.items.map((item) => item.kind)).toEqual(["user", "info", "summary"]);
  });

  it("flushAllLiveText keeps the partial line as the final assistant chunk", () => {
    const state: TuiState = {
      ...initialTuiState(),
      live: { text: "tail", thinking: "", toolName: undefined },
    };
    const flushed = flushAllLiveText(state);
    expect(flushed.live.text).toBe("");
    expect(flushed.items).toHaveLength(1);
    expect(flushed.items[0]?.kind === "assistant" && flushed.items[0]?.text).toBe("tail");
    // No newline in the buffer: flushLiveLines is a no-op returning the same state.
    const unchanged = flushLiveLines({
      ...initialTuiState(),
      live: { text: "tail", thinking: "", toolName: undefined },
    });
    expect(unchanged.items).toHaveLength(0);
    expect(unchanged.live.text).toBe("tail");
  });

  it("accumulates thinking deltas and flushes a Thought block before narration", () => {
    let state = initialTuiState();
    state = reduceEvent(state, { type: "thinking:delta", text: "checking " });
    state = reduceEvent(state, { type: "thinking:delta", text: "auth flow" });
    expect(state.live.thinking).toBe("checking auth flow");
    expect(state.items).toHaveLength(0);
    state = reduceEvent(state, { type: "text:delta", text: "Hello" });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.kind).toBe("thought");
    if (state.items[0]?.kind === "thought") {
      expect(state.items[0].text).toBe("checking auth flow");
    }
    expect(state.live.text).toBe("Hello");
  });

  it("stores tool input and result data for rich diff rendering", () => {
    let state = initialTuiState();
    const input = { path: "src/a.ts", old_string: "a\n", new_string: "b\n" };
    state = reduceEvent(state, { type: "tool:call", name: "edit_file", input });
    const call = state.items[0];
    expect(call?.kind).toBe("tool");
    if (call?.kind === "tool") {
      expect(call.input).toEqual(input);
    }
    state = reduceEvent(state, {
      type: "tool:result",
      name: "edit_file",
      result: { ok: true, data: { path: "src/a.ts", replacements: 1 } },
      ms: 5,
    });
    const paired = state.items[0];
    if (paired?.kind === "tool") {
      expect(paired.ok).toBe(true);
      expect(paired.data).toEqual({ path: "src/a.ts", replacements: 1 });
      expect(paired.summary).toContain("src/a.ts");
    } else {
      expect.unreachable("tool item missing");
    }
  });
});

describe("selectUiMode", () => {
  it("forces plain when explicitly requested", () => {
    expect(selectUiMode("plain", { isTTY: true }, {})).toBe("plain");
  });

  it("prefers tui on interactive terminals", () => {
    expect(selectUiMode("auto", { isTTY: true }, { TERM: "xterm-256color" })).toBe("tui");
    expect(selectUiMode("tui", { isTTY: true }, { TERM: "xterm-256color" })).toBe("tui");
  });

  it("falls back to plain for pipes, CI and dumb terminals", () => {
    expect(selectUiMode("auto", { isTTY: false }, {})).toBe("plain");
    expect(selectUiMode("auto", undefined, {})).toBe("plain");
    expect(selectUiMode("tui", { isTTY: false }, {})).toBe("plain");
    expect(selectUiMode("tui", { isTTY: true }, { TERM: "dumb" })).toBe("plain");
  });
});

describe("navigateHistory", () => {
  const history = ["first", "second"];

  it("keeps the current value when history is empty", () => {
    const next = navigateHistory([], { index: undefined, draft: "" }, "typing", "up");
    expect(next).toEqual({ value: "typing", cursor: { index: undefined, draft: "" } });
  });

  it("saves the typed draft on the first up-press and walks back", () => {
    const up1 = navigateHistory(history, { index: undefined, draft: "" }, "typing", "up");
    expect(up1).toEqual({ value: "second", cursor: { index: 1, draft: "typing" } });
    const up2 = navigateHistory(history, up1.cursor, up1.value, "up");
    expect(up2).toEqual({ value: "first", cursor: { index: 0, draft: "typing" } });
    const up3 = navigateHistory(history, up2.cursor, up2.value, "up");
    expect(up3.value).toBe("first");
    expect(up3.cursor.index).toBe(0);
  });

  it("restores the draft after walking back down from the newest entry", () => {
    const up1 = navigateHistory(history, { index: undefined, draft: "" }, "typing", "up");
    expect(up1.value).toBe("second");
    // One down-press from the newest entry returns straight to the draft.
    const down1 = navigateHistory(history, up1.cursor, up1.value, "down");
    expect(down1).toEqual({ value: "typing", cursor: { index: undefined, draft: "typing" } });
  });

  it("walks back through older entries before restoring the draft", () => {
    const up1 = navigateHistory(history, { index: undefined, draft: "" }, "typing", "up");
    const up2 = navigateHistory(history, up1.cursor, up1.value, "up");
    expect(up2.value).toBe("first");
    const down1 = navigateHistory(history, up2.cursor, up2.value, "down");
    expect(down1).toEqual({ value: "second", cursor: { index: 1, draft: "typing" } });
    const down2 = navigateHistory(history, down1.cursor, down1.value, "down");
    expect(down2).toEqual({ value: "typing", cursor: { index: undefined, draft: "typing" } });
  });

  it("ignores down-presses while not browsing history", () => {
    const next = navigateHistory(history, { index: undefined, draft: "" }, "typing", "down");
    expect(next).toEqual({ value: "typing", cursor: { index: undefined, draft: "" } });
  });
});
