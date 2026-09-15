import { statSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { formatNumberedLines, resolveWithinRoot } from "./internal/paths.ts";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LIMIT = 2000;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const read_file = defineTool({
  name: "read_file",
  description:
    "Read a text file from the project. Returns numbered lines (1-indexed); supports " +
    "reading a slice with offset/limit for large files.\n\n" +
    "WHEN TO USE: Before editing or overwriting any file. For understanding code, finding " +
    "definitions, checking current content.\n" +
    "KEY BEHAVIOR: Files must be read before they can be edited or overwritten (tracked). " +
    "If the file changed on disk since your last read, the edit will be rejected — re-read first.\n" +
    "PREFER OVER bash cat/head/tail — this tool tracks reads for safe editing.",
  risk: "read",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("File path, relative to the project root (or absolute inside it)."),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based line number to start reading from."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINE_LIMIT)
      .optional()
      .describe(`Maximum lines to return (default ${DEFAULT_LINE_LIMIT}).`),
  }),
  async execute(input, context): Promise<ToolResult<string>> {
    const contained = resolveWithinRoot(context.cwd, input.path);
    if (!contained.ok) {
      return contained;
    }

    let content: string;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(contained.path);
      if (stat.isDirectory()) {
        return {
          ok: false,
          error: `Not a file: ${input.path}`,
          hint: "Use list_dir to explore directories, then read individual files.",
        };
      }
      content = readFileSync(contained.path, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: `Could not read file: ${input.path}`,
        hint: `Check the path and try again (${error instanceof Error ? error.message : "unknown error"}).`,
      };
    }

    const allLines = content.split("\n");
    // A trailing newline produces a final empty element — drop it for display.
    const displayLines =
      allLines.length > 0 && allLines[allLines.length - 1] === ""
        ? allLines.slice(0, -1)
        : allLines;

    const start = (input.offset ?? 1) - 1;
    const boundedStart = Math.min(Math.max(start, 0), Math.max(displayLines.length - 1, 0));
    const limit = input.limit ?? DEFAULT_LINE_LIMIT;
    const slice = displayLines.slice(boundedStart, boundedStart + limit);
    const numbered = formatNumberedLines(slice, boundedStart + 1);
    const relPath = (relative(context.cwd, contained.path) || input.path).replaceAll("\\", "/");
    const meta = `(${formatFileSize(stat.size)})`;
    const header =
      slice.length === 0
        ? `(empty file or out-of-range slice: ${relPath} ${meta})`
        : `${relPath} — lines ${boundedStart + 1}-${boundedStart + slice.length} of ${displayLines.length} ${meta}`;

    context.readTracker.markRead(contained.path, { mtimeMs: stat.mtimeMs, size: stat.size });

    const body = context.truncator.truncate(numbered, relPath);
    return { ok: true, data: `${header}\n${body}` };
  },
});
