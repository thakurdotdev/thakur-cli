import { EventBus } from "@harness/core";
import type { HarnessEvent } from "@harness/core";
import { assertNeverEvent } from "@harness/core";
import {
  buildEditDiff,
  clip,
  countLines,
  describeToolCall,
  describeToolResult,
  editDiffInput,
  formatDuration,
  lineNoGutter,
  numberedPreviewLines,
  oneLine,
  writePreviewInput,
} from "./format.ts";
import type { DiffLine } from "./format.ts";

export { displayToolName } from "./format.ts";

/**
 * Terminal renderer — opencode / claude-code style.
 *
 *   Thought · 276ms
 *     checking the auth flow…
 *   ● Edit(src/auth.ts)
 *     - old line
 *     + new line
 *     ⎿ src/auth.ts · 1 replacement (12ms)
 *   ● Write(src/new.ts) +new
 *     + first line…
 *     ⎿ src/new.ts · created 42b (8ms)
 *   ✗ context window exceeded — …
 *   ▪ done (stop)
 *
 * Design rules: one header per tool call, inline diff for mutations, one dim
 * result line; no step noise; no per-step token spam (totals live in the run
 * summary); errors are a single red sentence. A spinner covers model thinking
 * gaps when stdout is an interactive TTY.
 */

export interface WriteTarget {
  write(text: string): void;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
} as const;

const ERASE_LINE = "\r\x1b[2K";

/** Per-tool ANSI accent — matches the Ink TUI's toolAccent(). */
function toolColor(name: string): string {
  if (name.startsWith("mcp__")) {
    return ANSI.green;
  }
  switch (name) {
    case "read_file":
    case "list_dir":
      return ANSI.cyan;
    case "grep":
    case "glob":
      return ANSI.blue;
    case "bash":
      return ANSI.magenta;
    case "write_file":
    case "edit_file":
      return ANSI.yellow;
    default:
      return ANSI.cyan;
  }
}

function colorize(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

/** Activity spinner for interactive TTYs; inert everywhere else. */
class Spinner {
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
  private readonly out: WriteTarget;
  private readonly enabled: boolean;
  private readonly color: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private label = "thinking…";

  constructor(out: WriteTarget, enabled: boolean, color = true) {
    this.out = out;
    this.enabled = enabled;
    this.color = color;
  }

  start(label = "thinking…"): void {
    this.label = label;
    if (!this.enabled) {
      return;
    }
    if (this.timer !== undefined) {
      // Already running — just update the label, next tick picks it up.
      return;
    }
    const paint = (): void => {
      const frame = Spinner.FRAMES[this.frame % Spinner.FRAMES.length] ?? "⠋";
      this.frame += 1;
      this.out.write(`${ERASE_LINE}  ${colorize(this.color, ANSI.cyan, frame)} ${this.label}`);
    };
    paint();
    this.timer = setInterval(paint, 80);
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.out.write(ERASE_LINE);
  }
}

export function createPlainRenderer(options: {
  events: EventBus<HarnessEvent>;
  out?: WriteTarget;
  color?: boolean;
}): () => void {
  const { events } = options;
  const out = options.out ?? process.stdout;
  const color = options.color ?? process.env["NO_COLOR"] === undefined;
  const interactive = color && (out as { isTTY?: boolean }).isTTY === true;
  const spinner = new Spinner(out, interactive, color);

  let thinking = "";
  let thinkingStartedAt = 0;

  const flushThinking = (): void => {
    const trimmed = thinking.trim();
    thinking = "";
    if (trimmed.length === 0) {
      return;
    }
    const ms = thinkingStartedAt > 0 ? Date.now() - thinkingStartedAt : 0;
    thinkingStartedAt = 0;
    spinner.stop();
    out.write(
      `\n${colorize(color, ANSI.yellow, `Thought${ms > 0 ? ` · ${formatDuration(ms)}` : ""}`)}\n`,
    );
    out.write(`  ${colorize(color, ANSI.dim, oneLine(trimmed, 180))}\n`);
  };

  const renderDiffLines = (diff: DiffLine[]): void => {
    for (const line of diff) {
      switch (line.kind) {
        case "ctx": {
          const gutter = lineNoGutter(line.lineNo);
          out.write(`    ${colorize(color, ANSI.dim, `${gutter}│  ${clip(line.text, 96)}`)}\n`);
          break;
        }
        case "del": {
          const gutter = lineNoGutter(line.lineNo);
          out.write(`    ${colorize(color, ANSI.red, `${gutter}│- ${clip(line.text, 96)}`)}\n`);
          break;
        }
        case "add": {
          const gutter = lineNoGutter(line.lineNo);
          out.write(`    ${colorize(color, ANSI.green, `${gutter}│+ ${clip(line.text, 96)}`)}\n`);
          break;
        }
        case "sep": {
          out.write(`    ${colorize(color, ANSI.dim, "  ───")}\n`);
          break;
        }
        case "elided": {
          out.write(`    ${colorize(color, ANSI.dim, `     … ${line.count} more lines`)}\n`);
          break;
        }
      }
    }
  };

  const renderDiff = (oldText: string, newText: string): void => {
    const diff = buildEditDiff(oldText, newText);
    renderDiffLines(diff);
  };

  const renderAddedFile = (content: string): void => {
    const lines = numberedPreviewLines(content, 8);
    for (const entry of lines) {
      const gutter = lineNoGutter(entry.lineNo);
      out.write(`    ${colorize(color, ANSI.green, `${gutter}│+ ${clip(entry.text, 96)}`)}\n`);
    }
    const total = countLines(content);
    if (total > lines.length) {
      out.write(`    ${colorize(color, ANSI.dim, `     … ${total - lines.length} more lines`)}\n`);
    }
  };

  const unsubscribe = events.onAny((event) => {
    switch (event.type) {
      // run:start and step:start are noise — the model/session lines printed
      // by the REPL cover startup, and steps are invisible in claude-code.
      case "run:start":
      case "step:start": {
        break;
      }
      case "thinking:delta": {
        if (thinking.length === 0) {
          thinkingStartedAt = Date.now();
        }
        thinking += event.text;
        break;
      }
      case "text:delta": {
        flushThinking();
        spinner.stop();
        out.write(event.text);
        break;
      }
      case "tool:call": {
        flushThinking();
        spinner.stop();
        const header = describeToolCall(event.name, event.input);
        out.write(
          `\n${colorize(color, toolColor(event.name), `● ${colorize(color, ANSI.bold, header)}`)}`,
        );
        if (event.name === "write_file") {
          const preview = writePreviewInput(event.input);
          if (preview !== undefined) {
            out.write(colorize(color, ANSI.green, " +new"));
          }
          out.write("\n");
          if (preview !== undefined) {
            renderAddedFile(preview.content);
          }
        } else {
          if (event.name === "edit_file") {
            const diff = editDiffInput(event.input);
            if (diff?.replaceAll === true) {
              out.write(colorize(color, ANSI.yellow, " ×all"));
            }
          }
          out.write("\n");
          if (event.name === "edit_file") {
            const diff = editDiffInput(event.input);
            if (diff !== undefined) {
              renderDiff(diff.oldText, diff.newText);
            }
          }
        }
        // Show activity while tool runs.
        spinner.start(`running ${event.name}…`);
        break;
      }
      case "tool:result": {
        flushThinking();
        spinner.stop();
        if (event.result.ok) {
          const summary = describeToolResult(event.name, event.result.data);
          const ms =
            event.ms > 0 ? colorize(color, ANSI.dim, ` (${formatDuration(event.ms)})`) : "";
          out.write(`  ${colorize(color, ANSI.dim, "⎿")} ${summary}${ms}\n`);
        } else {
          const hint = event.result.hint === undefined ? "" : ` — ${event.result.hint}`;
          out.write(
            `  ${colorize(color, ANSI.red, `⎿ ✗ ${clip(event.result.error, 200)}${hint}`)}\n`,
          );
        }
        break;
      }
      // Per-step token counts are accounting noise in the transcript; totals
      // belong to the run summary printed by the REPL.
      case "usage": {
        break;
      }
      case "compaction": {
        flushThinking();
        spinner.stop();
        out.write(
          `${colorize(color, ANSI.yellow, `⟳ compacted context: ${event.before} → ${event.after} tokens`)}\n`,
        );
        break;
      }
      case "error": {
        flushThinking();
        spinner.stop();
        out.write(`\n${colorize(color, ANSI.red, `✗ ${clip(event.message, 300)}`)}\n`);
        if (event.hint !== undefined) {
          out.write(`${colorize(color, ANSI.dim, `  ${event.hint}`)}\n`);
        }
        break;
      }
      case "done": {
        flushThinking();
        spinner.stop();
        out.write(`\n${colorize(color, ANSI.dim, `▪ done (${event.stopReason})`)}\n`);
        break;
      }
      case "reflection": {
        flushThinking();
        spinner.stop();
        out.write(`\n${colorize(color, ANSI.yellow, `⚡ ${clip(event.message, 300)}`)}\n`);
        break;
      }
      case "progress": {
        flushThinking();
        spinner.stop();
        out.write(`\n${colorize(color, ANSI.dim, `⏳ ${clip(event.message, 300)}`)}\n`);
        break;
      }
      default: {
        assertNeverEvent(event);
      }
    }
  });

  return () => {
    flushThinking();
    spinner.stop();
    unsubscribe();
  };
}
