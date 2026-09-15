import { Box, Static, Text } from "ink";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PermissionRequest } from "@harness/core";
import { formatTokens } from "@harness/core";
import { PROVIDERS } from "@harness/providers";
import type { SlashCommand } from "../commands/slash-commands.ts";
import type { TranscriptItem } from "./transcript.ts";
import {
  activeThinkingLine,
  buildEditDiff,
  clip,
  countLines,
  displayToolName,
  editDiffInput,
  editReplacementBadge,
  formatDuration,
  lineNoGutter,
  numberedPreviewLines,
  writePreviewInput,
} from "../renderers/format.ts";
import { flattenPickerRows, selectableIndices, visibleWindow } from "./picker.ts";
import type { PickerFlatRow, PickerProviderGroup } from "./picker.ts";

/**
 * Presentational Ink components for the harness TUI — the opencode/
 * claude-code look: a welcome hero, a bordered input box with placeholder,
 * per-tool accent colors, one-line tool results, and modal overlays for the
 * model picker and provider connect flow. Everything here is a pure function
 * of its props — no input hooks, no timers except the spinner — so frames
 * can be captured in tests with a fake stdout stream.
 */

/** The three answers a permission dialog offers, in display order. */
export function askChoices(tool: string): Array<{ label: string; decision: DialogDecision }> {
  return [
    { label: "Allow once", decision: { action: "allow" } },
    {
      label: `Always allow ${tool} in this session`,
      decision: { action: "always" },
    },
    { label: "Deny", decision: { action: "deny", reason: "declined by user" } },
  ];
}

export type DialogDecision =
  | { action: "allow" }
  | { action: "always" }
  | { action: "deny"; reason?: string };

/** Wrap an index by ±1 within [0, length) — the dialog's arrow-key model. */
export function rotate(index: number, delta: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return (((index + delta) % length) + length) % length;
}

/** Per-tool accent — read/search tools cool, mutations warm, shell loud. */
function toolAccent(name: string): string {
  if (name.startsWith("mcp__")) {
    return "green";
  }
  switch (name) {
    case "read_file":
    case "list_dir":
      return "cyan";
    case "grep":
    case "glob":
      return "blue";
    case "bash":
      return "magenta";
    case "write_file":
    case "edit_file":
      return "yellow";
    default:
      return "cyan";
  }
}

function ResultLine({
  ok,
  summary,
  ms,
}: {
  ok: boolean | undefined;
  summary: string;
  ms: number;
}): React.JSX.Element | null {
  if (ok === undefined) {
    return <Text dimColor> ⎿ …</Text>;
  }
  if (!ok) {
    return <Text color="red"> ⎿ ✗ {summary}</Text>;
  }
  return (
    <Text dimColor>
      {"  ⎿ "}
      {summary}
      {ms > 0 ? ` (${formatDuration(ms)})` : ""}
    </Text>
  );
}

const DIFF_PREVIEW_MAX = 10;
const FILE_PREVIEW_MAX = 8;

function DiffPreview({
  oldText,
  newText,
}: {
  oldText: string;
  newText: string;
}): React.JSX.Element | null {
  const diff = buildEditDiff(oldText, newText, DIFF_PREVIEW_MAX);
  if (diff.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {diff.map((line, index) => {
        switch (line.kind) {
          case "ctx": {
            const gutter = lineNoGutter(line.lineNo);
            return (
              <Text key={index} dimColor>
                {gutter}│ {clip(line.text, 96)}
              </Text>
            );
          }
          case "del": {
            const gutter = lineNoGutter(line.lineNo);
            return (
              <Text key={index} color="red">
                {gutter}│- {clip(line.text, 96)}
              </Text>
            );
          }
          case "add": {
            const gutter = lineNoGutter(line.lineNo);
            return (
              <Text key={index} color="green">
                {gutter}│+ {clip(line.text, 96)}
              </Text>
            );
          }
          case "sep": {
            return (
              <Text key={index} dimColor>
                {"  ───"}
              </Text>
            );
          }
          case "elided": {
            return (
              <Text key={index} dimColor>
                {"     "}… {line.count} more lines
              </Text>
            );
          }
        }
      })}
    </Box>
  );
}

function AddedFilePreview({ content }: { content: string }): React.JSX.Element | null {
  const lines = numberedPreviewLines(content, FILE_PREVIEW_MAX);
  if (lines.length === 0) {
    return null;
  }
  const total = countLines(content);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((entry, index) => {
        const gutter = lineNoGutter(entry.lineNo);
        return (
          <Text key={index} color="green">
            {gutter}│+ {clip(entry.text, 96)}
          </Text>
        );
      })}
      {total > lines.length ? (
        <Text dimColor>
          {"     "}… {total - lines.length} more lines
        </Text>
      ) : null}
    </Box>
  );
}

function toolPath(input: unknown): string | undefined {
  if (
    input !== null &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>)["path"] === "string"
  ) {
    return (input as Record<string, unknown>)["path"] as string;
  }
  return undefined;
}

function isNewFile(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === "object" &&
    (data as Record<string, unknown>)["created"] === true
  );
}

function ToolItem({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
}): React.JSX.Element {
  const accent = toolAccent(item.name) as "cyan" | "blue" | "magenta" | "yellow" | "green";
  // Opencode-style file mutation cards: header + inline diff, then result row.
  if (item.name === "edit_file") {
    const diff = editDiffInput(item.input);
    const badge = editReplacementBadge(item.input, item.data);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={accent}>
          ● <Text bold>{item.display}</Text>
          {badge !== undefined ? <Text color="yellow"> {badge}</Text> : null}
        </Text>
        {diff !== undefined ? <DiffPreview oldText={diff.oldText} newText={diff.newText} /> : null}
        <ResultLine ok={item.ok} summary={item.summary} ms={item.ms} />
      </Box>
    );
  }
  if (item.name === "write_file") {
    const preview = writePreviewInput(item.input);
    const path = toolPath(item.input) ?? toolPath(item.data);
    const created = isNewFile(item.data);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={accent}>
          ● <Text bold>{path !== undefined ? `Write(${path})` : item.display}</Text>
          {created ? <Text color="green"> +new</Text> : null}
        </Text>
        {preview !== undefined && item.ok !== false ? (
          <AddedFilePreview content={preview.content} />
        ) : null}
        <ResultLine ok={item.ok} summary={item.summary} ms={item.ms} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={accent}>
        ● <Text bold>{item.display}</Text>
      </Text>
      <ResultLine ok={item.ok} summary={item.summary} ms={item.ms} />
    </Box>
  );
}

export function ThoughtView({
  text,
  ms,
}: {
  text: string;
  ms?: number | undefined;
}): React.JSX.Element {
  const duration = ms !== undefined && ms > 0 ? ` · ${formatDuration(ms)}` : "";
  const cleanLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const preview = cleanLines.slice(0, 2);
  const hasMore = cleanLines.length > 2;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        <Text color="yellow">Thought</Text>
        {duration}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {preview.map((line, index) => (
          <Text key={index} dimColor>
            {clip(line, 120)}
          </Text>
        ))}
        {hasMore ? <Text dimColor>…</Text> : null}
      </Box>
    </Box>
  );
}

// --- Rich markdown for assistant text (opencode/claude-code style) ---------

const INLINE_RE =
  /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|~~[^~]+~~|\[([^\]]+)\]\(([^)]+)\)|\*[^*]+\*|(?<!\w)_[^_]+_(?!\w))/g;

function InlineSegments({ text }: { text: string }): React.JSX.Element {
  const parts: ReactNode[] = [];
  const pattern = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push(<Text key={key++}>{text.slice(last, index)}</Text>);
    }
    const token = match[0] ?? "";
    if (token.startsWith("***") && token.endsWith("***")) {
      parts.push(
        <Text key={key++} bold italic>
          {token.slice(3, -3)}
        </Text>,
      );
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      parts.push(
        <Text key={key++} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <Text key={key++} color="cyan">
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      parts.push(
        <Text key={key++} strikethrough>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      parts.push(
        <Text key={key++} color="cyan" underline>
          {linkMatch ? linkMatch[1] : token}
        </Text>,
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      parts.push(
        <Text key={key++} italic>
          {token.slice(1, -1)}
        </Text>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) {
    parts.push(<Text key={key++}>{text.slice(last)}</Text>);
  }
  if (parts.length === 0) {
    return <Text>{text}</Text>;
  }
  return <Text>{parts}</Text>;
}

interface CodeBlock {
  kind: "code";
  lang?: string | undefined;
  lines: string[];
}

interface HeadingBlock {
  kind: "heading";
  level: number;
  text: string;
}

interface HrBlock {
  kind: "hr";
}

interface QuoteBlock {
  kind: "quote";
  text: string;
}

interface ListBlock {
  kind: "list";
  indent: string;
  prefix: string;
  text: string;
  checked?: boolean | undefined;
}

interface TableBlock {
  kind: "table";
  headers: string[];
  widths: number[];
  rows: string[][];
}

interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}

interface BlankBlock {
  kind: "blank";
}

type MarkdownBlock =
  | CodeBlock
  | HeadingBlock
  | HrBlock
  | QuoteBlock
  | ListBlock
  | TableBlock
  | ParagraphBlock
  | BlankBlock;

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const rawLines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let currentCode: { lang?: string | undefined; lines: string[] } | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    const trimmedStart = line.trimStart();

    // Check code fences
    if (trimmedStart.startsWith("```")) {
      if (currentCode !== null) {
        blocks.push({ kind: "code", lang: currentCode.lang, lines: currentCode.lines });
        currentCode = null;
      } else {
        const fenceRest = trimmedStart.slice(3).trim();
        const lang = fenceRest.length > 0 ? fenceRest.split(/\s+/)[0] : undefined;
        currentCode = { lang, lines: [] };
      }
      continue;
    }

    if (currentCode !== null) {
      currentCode.lines.push(line);
      continue;
    }

    // Horizontal rule: ---, ***, ___ (at least 3 characters)
    if (/^(?:[-*_]\s*){3,}$/.test(line.trim())) {
      blocks.push({ kind: "hr" });
      continue;
    }

    // Markdown Table check
    if (
      line.trim().startsWith("|") &&
      line.trim().endsWith("|") &&
      i + 1 < rawLines.length &&
      /^\|(\s*[-:]+[-|\s:]*)\|$/.test(rawLines[i + 1]!.trim())
    ) {
      const parseRow = (l: string): string[] =>
        l
          .trim()
          .slice(1, -1)
          .split("|")
          .map((s) => s.trim());
      const headers = parseRow(line);
      i += 1; // skip separator row
      const rows: string[][] = [];
      while (
        i + 1 < rawLines.length &&
        rawLines[i + 1]!.trim().startsWith("|") &&
        rawLines[i + 1]!.trim().endsWith("|")
      ) {
        i += 1;
        rows.push(parseRow(rawLines[i]!));
      }
      const widths = headers.map((h, colIdx) =>
        Math.max(h.length, ...rows.map((r) => (r[colIdx] ?? "").length)),
      );
      blocks.push({ kind: "table", headers, widths, rows });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2] ?? "",
      });
      continue;
    }

    // Blockquote
    const quoteMatch = line.match(/^(\s*)>\s?(.*)$/);
    if (quoteMatch) {
      blocks.push({
        kind: "quote",
        text: quoteMatch[2] ?? "",
      });
      continue;
    }

    // Task list checkbox: - [ ] or - [x]
    const taskMatch = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1] ?? "";
      const isChecked = taskMatch[3]!.toLowerCase() === "x";
      blocks.push({
        kind: "list",
        indent,
        prefix: isChecked ? "☑ " : "☐ ",
        checked: isChecked,
        text: taskMatch[4] ?? "",
      });
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numMatch) {
      const indent = numMatch[1] ?? "";
      const num = numMatch[2]!;
      blocks.push({
        kind: "list",
        indent,
        prefix: `${num}. `,
        text: numMatch[3] ?? "",
      });
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1] ?? "";
      blocks.push({
        kind: "list",
        indent,
        prefix: "• ",
        text: bulletMatch[3] ?? "",
      });
      continue;
    }

    // Blank line
    if (line.trim().length === 0) {
      blocks.push({ kind: "blank" });
      continue;
    }

    // Normal paragraph line
    blocks.push({ kind: "paragraph", text: line });
  }

  // If text ended while inside an unclosed fence (e.g. streaming in progress)
  if (currentCode !== null) {
    blocks.push({ kind: "code", lang: currentCode.lang, lines: currentCode.lines });
  }

  return blocks;
}

function headingColor(level: number): "cyan" | "white" | "yellow" | undefined {
  switch (level) {
    case 1:
      return "cyan";
    case 2:
      return "white";
    case 3:
      return "yellow";
    default:
      return undefined;
  }
}

export function MarkdownText({ text }: { text: string }): React.JSX.Element {
  const blocks = parseMarkdownBlocks(text);
  const elements: ReactNode[] = [];
  let key = 0;
  let lastWasBlank = false;

  for (const block of blocks) {
    if (block.kind === "blank") {
      if (!lastWasBlank) {
        elements.push(<Text key={key++}> </Text>);
        lastWasBlank = true;
      }
      continue;
    }
    lastWasBlank = false;

    switch (block.kind) {
      case "hr": {
        elements.push(
          <Box key={key++} marginY={0}>
            <Text dimColor>{"─".repeat(48)}</Text>
          </Box>,
        );
        break;
      }
      case "code": {
        const codeLines = block.lines.map((l, i) => (
          <Text key={i} color="green">
            {l.length > 0 ? l : " "}
          </Text>
        ));
        const children: ReactNode[] = [];
        if (block.lang !== undefined) {
          children.push(
            <Text key="lang" dimColor bold>
              {block.lang}
            </Text>,
          );
        }
        children.push(...codeLines);
        elements.push(
          <Box
            key={key++}
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            marginY={0}
          >
            {children}
          </Box>,
        );
        break;
      }
      case "heading": {
        const color = headingColor(block.level);
        elements.push(
          <Box key={key++} marginTop={block.level <= 2 ? 1 : 0}>
            {color !== undefined ? (
              <Text bold color={color}>
                <InlineSegments text={block.text} />
              </Text>
            ) : (
              <Text bold dimColor>
                <InlineSegments text={block.text} />
              </Text>
            )}
          </Box>,
        );
        break;
      }
      case "quote": {
        elements.push(
          <Box key={key++} flexDirection="row" paddingLeft={1}>
            <Text color="gray">│ </Text>
            <Text dimColor>
              <InlineSegments text={block.text} />
            </Text>
          </Box>,
        );
        break;
      }
      case "list": {
        elements.push(
          <Text key={key++}>
            <Text color={block.checked ? "green" : "cyan"}>{`${block.indent}${block.prefix}`}</Text>
            <InlineSegments text={block.text} />
          </Text>,
        );
        break;
      }
      case "table": {
        const tableChildren: ReactNode[] = [];
        tableChildren.push(
          <Text key="hdr" bold color="cyan">
            {block.headers
              .map((h, colIdx) => h.padEnd((block.widths[colIdx] ?? h.length) + 2))
              .join("│ ")}
          </Text>,
        );
        tableChildren.push(
          <Text key="div" dimColor>
            {block.widths.map((w) => "─".repeat(w + 2)).join("┼─")}
          </Text>,
        );
        for (let rIdx = 0; rIdx < block.rows.length; rIdx++) {
          const row = block.rows[rIdx]!;
          tableChildren.push(
            <Text key={`r-${rIdx}`}>
              {row.map((cell, colIdx) => cell.padEnd((block.widths[colIdx] ?? 0) + 2)).join("│ ")}
            </Text>,
          );
        }
        elements.push(
          <Box key={key++} flexDirection="column" paddingLeft={1} marginY={0}>
            {tableChildren}
          </Box>,
        );
        break;
      }
      case "paragraph": {
        elements.push(
          <Text key={key++}>
            <InlineSegments text={block.text} />
          </Text>,
        );
        break;
      }
    }
  }

  return <Box flexDirection="column">{elements}</Box>;
}

export function TranscriptItemView({ item }: { item: TranscriptItem }): React.JSX.Element {
  switch (item.kind) {
    case "user": {
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>
            ❯ {item.text}
          </Text>
        </Box>
      );
    }
    case "assistant": {
      return (
        <Box marginTop={1}>
          <MarkdownText text={item.text} />
        </Box>
      );
    }
    case "thought": {
      return <ThoughtView text={item.text} ms={item.ms} />;
    }
    case "tool": {
      return <ToolItem item={item} />;
    }
    case "error": {
      return (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor="red"
          paddingX={1}
        >
          <Text color="red" bold>
            ✗ {item.message}
          </Text>
          {item.hint !== undefined ? <Text dimColor> {item.hint}</Text> : null}
        </Box>
      );
    }
    case "compaction": {
      const kb = (tokens: number): string =>
        tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);
      return (
        <Box marginTop={1}>
          <Text color="yellow">
            ⟳ compacted context: {kb(item.before)} → {kb(item.after)} tokens
          </Text>
        </Box>
      );
    }
    case "info": {
      return (
        <Text dimColor>
          <Text color="magenta">● </Text>
          {item.text}
        </Text>
      );
    }
    case "summary": {
      return (
        <Box marginTop={1}>
          <Text dimColor>▪ {item.text}</Text>
        </Box>
      );
    }
    default: {
      return <Text>{String(item)}</Text>;
    }
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

export function Spinner({
  label,
  startedAt,
}: {
  label: string;
  startedAt?: number | undefined;
}): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const elapsedText = (() => {
    if (startedAt === undefined || startedAt <= 0) {
      return "";
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (elapsedSec < 1) {
      return "";
    }
    if (elapsedSec < 60) {
      return ` (${elapsedSec}s)`;
    }
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    return ` (${mins}m ${secs}s)`;
  })();

  return (
    <Text color="cyan">
      {SPINNER_FRAMES[frame]}{" "}
      <Text dimColor>
        {label}
        {elapsedText}
      </Text>
    </Text>
  );
}

export function Transcript({ items }: { items: TranscriptItem[] }): React.JSX.Element {
  // Static permanently commits items to terminal scrollback.
  // Partition into completed items (rendered via Static) and pending tool calls (rendered live)
  // so tool calls never get permanently frozen with undefined/pending state.
  const completed = items.filter((item) => item.kind !== "tool" || item.ok !== undefined);
  const pending = items.filter((item) => item.kind === "tool" && item.ok === undefined);
  return (
    <>
      <Static items={completed}>
        {(item) => <TranscriptItemView key={item.id} item={item} />}
      </Static>
      {pending.map((item) => (
        <TranscriptItemView key={item.id} item={item} />
      ))}
    </>
  );
}

export function LiveArea({
  text,
  thinking,
  thinkingStartedAt,
  busy,
  toolName,
}: {
  text: string;
  thinking?: string;
  thinkingStartedAt?: number | undefined;
  busy: boolean;
  toolName: string | undefined;
}): React.JSX.Element | null {
  const activeThought =
    thinking !== undefined && thinking.trim().length > 0 ? activeThinkingLine(thinking, 90) : "";
  if (text.length === 0 && activeThought.length === 0 && !busy) {
    return null;
  }
  const label =
    toolName !== undefined
      ? `running ${displayToolName(toolName)}…`
      : text.length > 0
        ? ""
        : "thinking…";
  return (
    <Box flexDirection="column" marginTop={1}>
      {text.length > 0 ? <MarkdownText text={text} /> : null}
      {busy && label.length > 0 ? (
        <Box flexDirection="column">
          <Spinner
            label={label}
            startedAt={toolName === undefined ? thinkingStartedAt : undefined}
          />
          {activeThought.length > 0 && text.length === 0 && toolName === undefined ? (
            <Box paddingLeft={2}>
              <Text dimColor>
                <Text color="yellow">Thought</Text> · {activeThought}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export function PermissionDialog({
  request,
  selected,
}: {
  request: PermissionRequest;
  selected: number;
}): React.JSX.Element {
  const summary = (() => {
    try {
      const text = JSON.stringify(request.input) ?? "";
      return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    } catch {
      return "";
    }
  })();
  const choices = askChoices(request.tool);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        Permission required — {request.tool} ({request.risk})
      </Text>
      {summary.length > 0 ? <Text dimColor>{summary}</Text> : null}
      {choices.map((choice, index) => (
        <Text key={choice.label} {...(index === selected ? { color: "cyan" as const } : {})}>
          {index === selected ? "❯ " : "  "}
          {choice.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · Enter confirm · Esc deny</Text>
    </Box>
  );
}

// --- Welcome hero -----------------------------------------------------------

const LOGO_PARTS = [
  { t: "   __  __          __         ", c: "                    __   " },
  { t: "  / /_/ /_  ____ _/ /____  ___", c: "____    _________  ____/ /__ " },
  { t: " / __/ __ \\/ __ `/ //_/ / / / ", c: "___/   / ___/ __ \\/ __  / _ \\" },
  { t: "/ /_/ / / / /_/ / ,< / /_/ / /", c: "      / /__/ /_/ / /_/ /  __/" },
  { t: "\\__/_/ /_/\\__,_/_/|_|\\__,_/_/ ", c: "      \\___/\\____/\\__,_/\\___/ " },
] as const;

/** The welcome hero — rendered until the first transcript item exists. */
export function Hero({ modelLabel }: { modelLabel: string | undefined }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        {LOGO_PARTS.map((part, index) => (
          <Box key={index}>
            <Text color="cyan" bold>
              {part.t}
            </Text>
            <Text color="magenta" bold>
              {part.c}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>AI coding agent </Text>
          <Text color="gray">·</Text>
          <Text dimColor> multi-model, tool-using, permission-aware</Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        {modelLabel !== undefined ? (
          <Box>
            <Text color="magenta">● </Text>
            <Text dimColor>model </Text>
            <Text bold color="white">
              {modelLabel}
            </Text>
          </Box>
        ) : null}
        <Box>
          <Text dimColor>
            <Text color="yellow">/models</Text> switch · <Text color="cyan">/connect</Text> add key
            · <Text color="green">/help</Text> commands
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// --- Input box + context row -------------------------------------------------

const CURSOR_BLINK_MS = 530;

export interface InputBoxProps {
  value: string;
  /** Cursor offset into `value`; defaults to the end. 0 = before the first char. */
  cursor?: number;
  disabled: boolean;
  busy: boolean;
}

/**
 * The bordered prompt. The block cursor blinks and sits exactly at the edit
 * position - at the START of the placeholder when empty (not trailing it),
 * mid-text while editing. Blinking pauses visible on every keystroke so the
 * cursor never disappears while the user is typing.
 */
export function InputBox(props: InputBoxProps): React.JSX.Element {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setVisible((current) => !current), CURSOR_BLINK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const cursor = props.cursor ?? props.value.length;
  useEffect(() => {
    setVisible(true);
  }, [props.value, cursor]);

  const cursorBlock = props.disabled ? null : (
    <Text {...(visible ? { inverse: true } : { dimColor: true })}> </Text>
  );

  if (props.value.length === 0) {
    return (
      <Box
        borderStyle="round"
        {...(props.busy ? { borderColor: "gray" as const } : { borderColor: "cyan" as const })}
        paddingX={1}
      >
        <Text color="cyan" bold>
          ❯{" "}
        </Text>
        {cursorBlock}
        <Text dimColor>Ask anything… "fix a TODO in the codebase"</Text>
      </Box>
    );
  }

  const head = props.value.slice(0, cursor);
  const at = props.value[cursor] ?? " ";
  const tail = props.value.slice(cursor + 1);
  return (
    <Box
      borderStyle="round"
      {...(props.busy ? { borderColor: "gray" as const } : { borderColor: "cyan" as const })}
      paddingX={1}
    >
      <Text color="cyan" bold>
        ❯{" "}
      </Text>
      <Text>{head}</Text>
      {props.disabled ? null : (
        <Text {...(visible ? { inverse: true } : { dimColor: true })}>
          {at === "\n" ? " " : at}
        </Text>
      )}
      <Text>{tail}</Text>
    </Box>
  );
}

export interface ContextRowProps {
  model: string | undefined;
  modelFree: boolean;
  contextPct: number | undefined;
  sessionName: string | undefined;
  busy: boolean;
}

/** The rows under the input: model/context line, then right-aligned hints. */
export function ContextRow(props: ContextRowProps): React.JSX.Element {
  const left: string[] = ["Build"];
  if (props.model !== undefined) {
    left.push(props.model + (props.modelFree ? " (free)" : ""));
  }
  if (props.contextPct !== undefined) {
    left.push(`ctx ~${props.contextPct}%`);
  }
  if (props.sessionName !== undefined) {
    left.push(props.sessionName);
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>{left.join(" · ")}</Text>
      <Box justifyContent="flex-end">
        <Text dimColor>
          {props.busy
            ? "esc interrupts · ctrl+c exit"
            : "type / for commands · ↑ history · ctrl+c exit"}
        </Text>
      </Box>
    </Box>
  );
}

// --- Slash-command menu -------------------------------------------------------

const MENU_DESCRIPTION_MAX = 52;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface CommandMenuProps {
  commands: ReadonlyArray<SlashCommand>;
  cursor: number;
}

/**
 * The `/` autocomplete list, rendered above the input while the whole input
 * is a single slash token (claude-code convention): type to filter, ↑/↓ to
 * select, Tab fills args-taking commands, Enter runs argless ones.
 */
export function CommandMenu(props: CommandMenuProps): React.JSX.Element | null {
  if (props.commands.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {props.commands.map((command, index) => {
        const selected = index === props.cursor;
        return (
          <Box key={command.name} justifyContent="space-between">
            <Text
              {...(selected
                ? { color: "black" as const, backgroundColor: "cyan" as const }
                : { color: "cyan" as const })}
            >
              {selected ? "● " : "  "}
              {command.name}
              {command.args !== undefined ? <Text dimColor> {command.args}</Text> : null}
            </Text>
            <Text dimColor>{truncate(command.description, MENU_DESCRIPTION_MAX)}</Text>
          </Box>
        );
      })}
      <Text dimColor>↑/↓ select · tab complete · enter run · esc dismiss</Text>
    </Box>
  );
}

// --- Model picker modal -------------------------------------------------------

export interface ModelPickerProps {
  status: "loading" | "ready";
  groups: PickerProviderGroup[];
  recents: ReadonlyArray<string>;
  currentRef: string;
  query: string;
  cursor: number;
  providerFilter?: string | undefined;
}

const PICKER_MAX_VISIBLE = 14;

/** "gemini 2.5 flash" style rows — opencode-like with Free badges. */
export function ModelPicker(props: ModelPickerProps): React.JSX.Element {
  if (props.status === "loading") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text bold>Select model</Text>
        <Spinner label="fetching model catalogs…" />
        <Text dimColor>esc close</Text>
      </Box>
    );
  }
  const rows: PickerFlatRow[] = flattenPickerRows({
    groups: props.groups,
    recents: props.recents,
    currentRef: props.currentRef,
    query: props.query,
    providerFilter: props.providerFilter,
  });
  const selectable = selectableIndices(rows);
  const cursorSelectable = selectable.includes(props.cursor) ? props.cursor : (selectable[0] ?? 0);
  const flatIndex = rows.findIndex((entry) => entry.selectableIndex === cursorSelectable);
  const window_ = visibleWindow(rows, Math.max(0, flatIndex), PICKER_MAX_VISIBLE);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold>Select model</Text>
        <Text dimColor>esc</Text>
      </Box>
      {props.groups.length > 1 ? (
        <Box marginY={0}>
          <Text dimColor>Provider: </Text>
          <Text
            {...(props.providerFilter === undefined
              ? { color: "cyan" as const, bold: true }
              : { dimColor: true })}
          >
            [All]
          </Text>
          {props.groups.map((group) => {
            const active = props.providerFilter === group.provider.id;
            return (
              <Text
                key={group.provider.id}
                {...(active ? { color: "cyan" as const, bold: true } : { dimColor: true })}
              >
                {" "}
                [{group.provider.name}]
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Text>
        <Text dimColor>Search </Text>
        {props.query.length > 0 ? props.query : <Text dimColor>…</Text>}
        {props.providerFilter !== undefined ? (
          <Text color="cyan">
            {" "}
            (
            {props.groups.find((g) => g.provider.id === props.providerFilter)?.provider.name ??
              props.providerFilter}
            )
          </Text>
        ) : null}
      </Text>
      {window_.length === 0 ? (
        <Text dimColor>no models match — check /connect for a provider key</Text>
      ) : (
        window_.map((entry, index) => {
          if (entry.row.kind === "header") {
            return (
              <Box
                key={`h-${index}-${entry.row.label}`}
                marginTop={entry.row.label === "Recent" ? 0 : 1}
              >
                <Text color="magenta" bold>
                  {entry.row.label}
                </Text>
              </Box>
            );
          }
          const model = entry.row;
          const selected = entry.selectableIndex === cursorSelectable;
          const price = model.free === true ? "Free" : undefined;
          return (
            <Box key={`m-${index}-${model.ref}`} justifyContent="space-between">
              <Text
                {...(selected ? { color: "black" as const, backgroundColor: "cyan" as const } : {})}
              >
                {selected ? "● " : model.current ? "○ " : "  "}
                {model.name}
                {model.current ? " (current)" : ""}
              </Text>
              <Box>
                {model.contextLength !== undefined ? (
                  <Text dimColor>{formatTokens(model.contextLength)} </Text>
                ) : null}
                {price !== undefined ? <Text color="cyan">{price}</Text> : null}
              </Box>
            </Box>
          );
        })
      )}
      <Box justifyContent="space-between" marginTop={1}>
        <Text dimColor>
          type to filter · {props.groups.length > 1 ? "tab cycle provider · " : ""}↑/↓ navigate ·
          enter select
        </Text>
        <Text dimColor>
          {selectable.length} model{selectable.length === 1 ? "" : "s"}
        </Text>
      </Box>
    </Box>
  );
}

// --- Connect dialog -----------------------------------------------------------

export interface ConnectDialogProps {
  stage: "provider" | "key";
  providerIndex: number;
  providerName: string;
  keyValue: string;
}

export function ConnectDialog(props: ConnectDialogProps): React.JSX.Element {
  if (props.stage === "provider") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        marginTop={1}
      >
        <Box justifyContent="space-between">
          <Text bold>Connect provider</Text>
          <Text dimColor>esc</Text>
        </Box>
        {PROVIDERS.map((provider, index) => (
          <Text
            key={provider.id}
            {...(index === props.providerIndex ? { color: "cyan" as const } : {})}
          >
            {index === props.providerIndex ? "❯ " : "  "}
            {provider.name}
            <Text dimColor> — {provider.keyUrl}</Text>
          </Text>
        ))}
        <Text dimColor>↑/↓ select · enter continue</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold>Paste your {props.providerName} API key</Text>
        <Text dimColor>esc</Text>
      </Box>
      <Text>
        <Text dimColor>key </Text>
        {props.keyValue.length > 0 ? "•".repeat(props.keyValue.length) : ""}
        <Text inverse> </Text>
      </Text>
      <Text dimColor>enter save (~/.harness/auth.json) · esc cancel</Text>
    </Box>
  );
}
