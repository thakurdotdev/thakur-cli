/**
 * Pure display formatting shared by every renderer surface (plain stdout
 * renderer, Ink TUI, tests). No ANSI codes, no React — just strings.
 */

export function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

/** Most informative arguments per tool, in display order. */
const ARG_KEYS: Record<string, string[]> = {
  bash: ["command"],
  read_file: ["path", "offset", "limit"],
  write_file: ["path"],
  edit_file: ["path"],
  grep: ["pattern", "path", "include", "ignore_case"],
  glob: ["pattern", "path"],
  list_dir: ["path"],
};

/**
 * `mcp__fs__read_file` -> `fs/read_file`. MCP tool names are namespaced for
 * the model; the terminal display prefers the shorter, human form.
 */
export function displayToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const separator = rest.indexOf("__");
    if (separator > 0) {
      return `${rest.slice(0, separator)}/${rest.slice(separator + 2)}`;
    }
    return rest;
  }
  return name;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 0 ? JSON.stringify(value) : '""';
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "…";
  } catch {
    return "…";
  }
}

/** `grep(pattern: ".*", path: "packages")` — named args, not a JSON dump. */
export function formatToolArgs(name: string, input: unknown, maxChars = 120): string {
  if (input === null || input === undefined || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  const preferred = ARG_KEYS[name] ?? [];
  const keys = [
    ...preferred.filter((key) => record[key] !== undefined),
    ...Object.keys(record).filter((key) => !preferred.includes(key) && record[key] !== undefined),
  ];
  const parts: string[] = [];
  let total = 0;
  for (const key of keys) {
    const value = record[key];
    // Skip noise: empty strings and explicit false flags add nothing.
    if (value === null || value === "" || value === false) {
      continue;
    }
    const part = `${key}: ${formatValue(value)}`;
    if (total + part.length > maxChars && parts.length > 0) {
      parts.push("…");
      break;
    }
    total += part.length + 2;
    parts.push(part);
  }
  return parts.join(", ");
}

/** Short human verb per builtin tool — the claude-code header style. */
const TOOL_VERBS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  list_dir: "List",
};

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

/**
 * `Read(src/index.ts)` — the most informative argument up front, like
 * claude-code. Builtin tools get curated headers; anything else (MCP) falls
 * back to the named-args form.
 */
export function describeToolCall(name: string, input: unknown, maxChars = 140): string {
  const verb = TOOL_VERBS[name] ?? displayToolName(name);
  const record =
    input !== null && input !== undefined && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  switch (name) {
    case "bash": {
      return `${verb}(${clip(firstString(record, ["command"]) ?? "", maxChars)})`;
    }
    case "read_file":
    case "write_file":
    case "edit_file": {
      return `${verb}(${firstString(record, ["path"]) ?? ""})`;
    }
    case "grep": {
      const pattern = firstString(record, ["pattern"]) ?? "…";
      const path = firstString(record, ["path"]);
      const flags = record["ignore_case"] === true ? ", -i" : "";
      return `${verb}(${clip(pattern, 60)}${path !== undefined ? `, ${path}` : ""}${flags})`;
    }
    case "glob": {
      const pattern = firstString(record, ["pattern"]) ?? "…";
      const path = firstString(record, ["path"]);
      return `${verb}(${pattern}${path !== undefined ? `, ${path}` : ""})`;
    }
    case "list_dir": {
      return `${verb}(${firstString(record, ["path"]) ?? "."})`;
    }
    default: {
      const args = formatToolArgs(name, input, 100);
      return `${verb}(${args})`;
    }
  }
}

/** Short honest summary of an ok tool result: "24 lines", "3 entries", or a preview. */
export function describeResultData(data: unknown): string {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      return "ok";
    }
    const lines = trimmed.split("\n");
    if (lines.length > 1) {
      return `${lines.length} lines`;
    }
    return clip(lines[0] ?? "ok", 80);
  }
  if (Array.isArray(data)) {
    return `${data.length} entries`;
  }
  if (data !== null && data !== undefined && typeof data === "object") {
    const record = data as Record<string, unknown>;
    // Rich one-liners for file mutations (opencode-style result rows).
    if (typeof record["path"] === "string") {
      const path = record["path"] as string;
      if (typeof record["replacements"] === "number") {
        const n = record["replacements"] as number;
        return `${path} · ${n} replacement${n === 1 ? "" : "s"}`;
      }
      if (typeof record["bytes"] === "number") {
        const created = record["created"] === true ? "created" : "wrote";
        return `${path} · ${created} ${record["bytes"]}b`;
      }
    }
    try {
      return clip(JSON.stringify(data) ?? "ok", 80);
    } catch {
      return "ok";
    }
  }
  return "ok";
}

/**
 * Opencode-style durations: 276ms, 7.1s, 2m3s — never raw 4-5 digit ms.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest}s`;
}

/** Collapse any blob to one readable line (opencode Thought previews). */
export function oneLine(text: string, maxChars = 160): string {
  return clip(text.replace(/\s+/g, " ").trim(), maxChars);
}

/**
 * Per-tool result summaries that reuse each tool's own header line:
 * reads report file lines, listings report entries, globs report files,
 * greps report matches — instead of a generic "N lines".
 */
export function describeToolResult(name: string, data: unknown): string {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      return "ok";
    }
    const lines = trimmed.split("\n");
    const head = lines[0] ?? "";
    switch (name) {
      case "read_file": {
        const total = head.match(/— lines \d+-\d+ of (\d+)/);
        if (total?.[1] !== undefined) {
          return `${total[1]} lines`;
        }
        break;
      }
      case "list_dir": {
        const entries = head.match(/— (\d+) entr/);
        if (entries?.[1] !== undefined) {
          return `${entries[1]} entries`;
        }
        if (/empty directory/.test(head)) {
          return "empty";
        }
        break;
      }
      case "glob": {
        if (head.startsWith("No files match")) {
          return "no files";
        }
        if (lines.length > 1 || (lines.length === 1 && !head.startsWith("("))) {
          return `${lines.length} file${lines.length === 1 ? "" : "s"}`;
        }
        break;
      }
      case "grep": {
        if (head.startsWith("No matches")) {
          return "no matches";
        }
        const matches = lines.filter((line) => /:\d+:/.test(line)).length;
        if (matches > 0) {
          return `${matches} match${matches === 1 ? "" : "es"}`;
        }
        break;
      }
      case "bash": {
        // Structured BashOutput — extract clean summary instead of JSON.stringify.
        if (typeof data === "string") {
          if (lines.length === 1) {
            return clip(head, 80);
          }
          return `${lines.length} lines`;
        }
        break;
      }
      default: {
        break;
      }
    }
    if (lines.length > 1) {
      return `${lines.length} lines`;
    }
    return clip(head, 80);
  }
  // Structured tool results (e.g. BashOutput object).
  if (name === "bash" && data !== null && data !== undefined && typeof data === "object") {
    const output = data as { exitCode?: number; stdout?: string };
    const code = output.exitCode ?? 0;
    const stdout = (output.stdout ?? "").trim();
    if (code !== 0) {
      return `exit ${code}`;
    }
    if (stdout.length === 0) {
      return "ok";
    }
    const stdoutLines = stdout.split("\n");
    if (stdoutLines.length === 1) {
      return clip(stdoutLines[0] ?? "ok", 80);
    }
    return `${stdoutLines.length} lines`;
  }
  return describeResultData(data);
}

export type DiffLine =
  | { kind: "del"; lineNo: number; text: string }
  | { kind: "add"; lineNo: number; text: string }
  | { kind: "ctx"; lineNo: number; text: string }
  | { kind: "sep" }
  | { kind: "elided"; count: number };

/** @deprecated Compat alias — old callers that only checked `.side`. */
export type LegacyDiffLine = { side: "del" | "add"; text: string };

/**
 * Line-level diff preview for edit_file old_string → new_string.
 *
 * claude-code / opencode style: interleaved del/add pairs per change region,
 * 1 context line before/after each hunk, line numbers in a gutter, dim
 * separators between non-adjacent hunks, and smart truncation.
 *
 * `startLineNo` is the 1-based line number of the first line of `oldText`
 * within the full file (used for accurate gutter numbers). Defaults to 1.
 */
export function buildEditDiff(
  oldText: string,
  newText: string,
  maxLines = 20,
  startLineNo = 1,
): DiffLine[] {
  const oldLines = oldText.replace(/\n$/, "").split("\n");
  const newLines = newText.replace(/\n$/, "").split("\n");

  // Common head/tail trim so the preview focuses on the changed middle.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const out: DiffLine[] = [];
  let emitted = 0;

  const push = (line: DiffLine): boolean => {
    if (emitted >= maxLines) {
      return false;
    }
    out.push(line);
    if (line.kind !== "sep") {
      emitted += 1;
    }
    return true;
  };

  // 1 context line before the change (the last common head line).
  if (head > 0) {
    const ctxLine = oldLines[head - 1] ?? "";
    push({ kind: "ctx", lineNo: startLineNo + head - 1, text: ctxLine });
  }

  // Interleave: emit all old (del) lines then all new (add) lines for the
  // changed middle. For small changes this gives the claude-code look;
  // for large changes the budget truncates naturally.
  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);

  // Interleaved output: walk both sides, pair matching indices.
  const maxHunkLen = Math.max(oldMid.length, newMid.length);
  let truncatedDels = 0;
  let truncatedAdds = 0;
  for (let i = 0; i < maxHunkLen; i += 1) {
    if (i < oldMid.length) {
      if (!push({ kind: "del", lineNo: startLineNo + head + i, text: oldMid[i] ?? "" })) {
        truncatedDels = oldMid.length - i;
        truncatedAdds = Math.max(0, newMid.length - i);
        break;
      }
    }
    if (i < newMid.length) {
      if (!push({ kind: "add", lineNo: startLineNo + head + i, text: newMid[i] ?? "" })) {
        truncatedAdds = newMid.length - i;
        break;
      }
    }
  }

  // Truncation indicator.
  if (truncatedDels + truncatedAdds > 0) {
    out.push({ kind: "elided", count: truncatedDels + truncatedAdds });
  }

  // 1 context line after the change (the first common tail line).
  if (tail > 0 && emitted < maxLines) {
    const tailStart = oldLines.length - tail;
    const ctxLine = oldLines[tailStart] ?? "";
    push({ kind: "ctx", lineNo: startLineNo + tailStart, text: ctxLine });
  }

  return out;
}

/** First N non-empty-trailing lines of a blob, without the trailing newline. */
export function previewLines(text: string, maxLines = 10): string[] {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(0, maxLines);
}

/**
 * Active thought line for live streaming — extracts the most recent non-empty
 * line of thinking (the tail), allowing the user to see thoughts progressing in
 * real time rather than staying frozen on the first line.
 */
export function activeThinkingLine(text: string, maxChars = 100): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line !== undefined && line.length > 0) {
      return clip(line, maxChars);
    }
  }
  return clip(trimmed, maxChars);
}

/** Total line count of a blob (0 for empty string). */
export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.replace(/\n$/, "").split("\n").length;
}

function recordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Extract edit_file fields for diff rendering; undefined when not an edit. */
export function editDiffInput(
  input: unknown,
): { oldText: string; newText: string; replaceAll: boolean } | undefined {
  if (input === null || input === undefined || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const oldText = recordString(record, "old_string");
  const newText = recordString(record, "new_string");
  if (oldText === undefined || newText === undefined) {
    return undefined;
  }
  const replaceAll = record["replace_all"] === true;
  return { oldText, newText, replaceAll };
}

/**
 * Header badge for edit_file: `×N` when replace_all is true and the result
 * reports multiple replacements. Returns undefined for single replacements.
 */
export function editReplacementBadge(input: unknown, resultData: unknown): string | undefined {
  if (input === null || input === undefined || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (record["replace_all"] !== true) {
    return undefined;
  }
  if (
    resultData !== null &&
    resultData !== undefined &&
    typeof resultData === "object" &&
    typeof (resultData as Record<string, unknown>)["replacements"] === "number"
  ) {
    const n = (resultData as Record<string, unknown>)["replacements"] as number;
    if (n > 1) {
      return `×${n}`;
    }
  }
  return "×all";
}

/** Format line number gutter: right-aligned, fixed width. */
export function lineNoGutter(lineNo: number, width = 4): string {
  return String(lineNo).padStart(width, " ");
}

/** First N lines of a blob with 1-based line numbers. */
export function numberedPreviewLines(
  text: string,
  maxLines = 10,
): Array<{ lineNo: number; text: string }> {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(0, maxLines).map((line, i) => ({ lineNo: i + 1, text: line }));
}

/** Extract write_file fields for new-file preview rendering. */
export function writePreviewInput(input: unknown): { content: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const content = recordString(record, "content");
  if (content === undefined) {
    return undefined;
  }
  return { content };
}
