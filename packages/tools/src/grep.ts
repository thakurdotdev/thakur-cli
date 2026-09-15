import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { resolveWithinRoot } from "./internal/paths.ts";
import { resolveRgBinary } from "./internal/rg.ts";

/**
 * grep tool — fast content search backed by ripgrep.
 *
 * Ripgrep respects .gitignore and skips hidden/binary files by default, which
 * matches what a coding agent wants. Output is JSON-parsed (no ambiguous
 * `path:line:text` splitting) and bounded by max_results plus the global
 * output truncator.
 */

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_RESULTS = 100;
const MAX_MAX_RESULTS = 500;
const RG_TIMEOUT_MS = 30_000;
const RG_MAX_BUFFER_CHARS = 8_000_000;

interface RgMatchLine {
  type: unknown;
  data?: {
    path?: { text?: unknown };
    line_number?: unknown;
    lines?: { text?: unknown };
  };
}

export const grep = defineTool({
  name: "grep",
  description:
    "Search file contents by regular expression or exact string (ripgrep-backed). Returns " +
    "matching lines with file paths and line numbers.\n\n" +
    "WHEN TO USE: Finding code by pattern or literal text — function definitions, import " +
    "statements, error messages, variable usage, TODO comments.\n" +
    "PREFER OVER bash grep/ag/rg — this tool respects .gitignore, skips binary files, " +
    "and returns structured results.\n" +
    "TIPS:\n" +
    "- Uses Rust regex syntax by default. Set fixed_string=true for literal text search.\n" +
    "- Use context_lines to see surrounding code around each match.\n" +
    '- Use `include` to narrow by file type, e.g. "*.ts" for TypeScript files only.\n' +
    "- Searches the project root by default; narrow with `path` for faster results.",
  risk: "read",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("Search pattern (regular expression or literal string)."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Directory or file to search in, relative to the project root (default: root)."),
    include: z
      .string()
      .min(1)
      .optional()
      .describe('Glob filter for files to search, e.g. "*.ts" or "src/**".'),
    ignore_case: z.boolean().optional().describe("Case-insensitive search (default false)."),
    fixed_string: z
      .boolean()
      .optional()
      .describe(
        "Treat pattern as a literal string instead of a regular expression (default false).",
      ),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        "Number of surrounding context lines to show before and after each match (default 0).",
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_MAX_RESULTS)
      .optional()
      .describe(`Maximum matches to return (default ${DEFAULT_MAX_RESULTS}).`),
  }),
  async execute(input, context): Promise<ToolResult<string>> {
    const rgBinary = await resolveRgBinary();
    if (rgBinary === null) {
      return {
        ok: false,
        error: "ripgrep binary is not available",
        hint: "Run `bun install` so @vscode/ripgrep provides its binary, or install ripgrep on PATH.",
      };
    }

    const contained = resolveWithinRoot(context.cwd, input.path ?? ".");
    if (!contained.ok) {
      return contained;
    }
    const searchPath = relative(context.cwd, contained.path) || ".";
    const patternLabel = input.fixed_string === true ? `"${input.pattern}"` : `/${input.pattern}/`;

    const args = [
      "--json",
      "--color",
      "never",
      "--max-columns",
      "400",
      // Consistent defaults with the glob tool: dependency/vcs noise is never
      // interesting to search and floods results in un-gitignored trees.
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.git/**",
      ...(input.ignore_case === true ? ["--ignore-case"] : []),
      ...(input.fixed_string === true ? ["--fixed-strings"] : []),
      ...(input.context_lines !== undefined && input.context_lines > 0
        ? ["-C", String(input.context_lines)]
        : []),
      ...(input.include !== undefined ? ["--glob", input.include] : []),
      "-e",
      input.pattern,
      "--",
      searchPath,
    ];

    let stdout: string;
    try {
      const result = await execFileAsync(rgBinary, args, {
        cwd: context.cwd,
        timeout: RG_TIMEOUT_MS,
        maxBuffer: RG_MAX_BUFFER_CHARS,
        windowsHide: true,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      stdout = result.stdout;
    } catch (error) {
      // execFile rejection: `code` holds the numeric rg exit code at runtime
      // (0=match, 1=no match, 2=error) even though ErrnoException types it string.
      const err = error as {
        code?: number | string | null;
        killed?: boolean;
        signal?: string | null;
        stderr?: string | Buffer;
        message?: string;
      };

      if (context.signal?.aborted === true) {
        return { ok: false, error: "Search aborted" };
      }

      // ripgrep exit code 1 means "no matches" — a successful empty search.
      if (err.code === 1) {
        return { ok: true, data: `No matches for ${patternLabel}` };
      }

      if (err.killed === true) {
        return {
          ok: false,
          error: `Search timed out after ${RG_TIMEOUT_MS / 1000}s`,
          hint: "Narrow the search with path/include or a more specific pattern.",
        };
      }

      const stderr =
        typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? "");
      const firstStderrLine = stderr.split("\n").find((line) => line.trim().length > 0) ?? "";
      if (firstStderrLine.length > 0) {
        return {
          ok: false,
          error: `Search failed: ${firstStderrLine.slice(0, 300)}`,
          hint: "Check the regular expression (Rust regex syntax) and the target path.",
        };
      }
      return {
        ok: false,
        error: `Search failed: ${err.message ?? "unknown error"}`,
        hint: "Narrow the search with path/include or a more specific pattern.",
      };
    }

    const lines = stdout.split("\n");
    const formatted: string[] = [];
    let matchCount = 0;
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      let parsed: RgMatchLine;
      try {
        parsed = JSON.parse(line) as RgMatchLine;
      } catch {
        continue;
      }
      if (parsed.type !== "match" && parsed.type !== "context") {
        continue;
      }
      const pathText = parsed.data?.path?.text;
      const lineNumber = parsed.data?.line_number;
      const text = parsed.data?.lines?.text;
      if (
        typeof pathText !== "string" ||
        typeof lineNumber !== "number" ||
        typeof text !== "string"
      ) {
        continue;
      }
      if (parsed.type === "match") {
        matchCount += 1;
      }
      const sep = parsed.type === "match" ? ":" : "-";
      const normalizedPath = pathText.replace(/^\.[\\/]/, "").replaceAll("\\", "/");
      formatted.push(`${normalizedPath}:${lineNumber}${sep} ${text.trimEnd()}`);
    }

    if (formatted.length === 0) {
      return { ok: true, data: `No matches for ${patternLabel}` };
    }

    const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
    let body: string;
    if (input.context_lines !== undefined && input.context_lines > 0) {
      const maxTotalLines = maxResults * (input.context_lines * 2 + 1);
      const shown = formatted.slice(0, maxTotalLines);
      body =
        formatted.length > shown.length
          ? `${shown.join("\n")}\n(showing matches with context — raise max_results or narrow search to see more)`
          : shown.join("\n");
    } else {
      const shown = formatted.slice(0, maxResults);
      body =
        formatted.length > shown.length
          ? `${shown.join("\n")}\n(showing ${shown.length} of ${formatted.length} matches — raise max_results or narrow the search to see more)`
          : shown.join("\n");
    }

    const searchedIn = searchPath === "." ? "project root" : searchPath;
    return {
      ok: true,
      data: context.truncator.truncate(body, `grep ${patternLabel} in ${searchedIn}`),
    };
  },
});
