import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { countOccurrences, resolveWithinRoot } from "./internal/paths.ts";

export interface EditFileOutput {
  path: string;
  replacements: number;
}

export const edit_file = defineTool({
  name: "edit_file",
  description:
    "Replace exact text in a file. The file MUST have been read with read_file first.\n\n" +
    "WHEN TO USE: Making targeted changes to existing files — bug fixes, refactors, additions, " +
    "deletions. This is the primary editing tool.\n" +
    "RULES:\n" +
    "- old_string must match the current file content EXACTLY, including whitespace and indentation.\n" +
    "- Include enough surrounding context lines in old_string to make the match unique.\n" +
    "- If old_string is not found, your cached view is likely stale — re-read the file first.\n" +
    "- If old_string appears multiple times and you want to change all, set replace_all=true.\n" +
    "- new_string may be empty to delete text.",
  risk: "write",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("File path, relative to the project root (or absolute inside it)."),
    old_string: z.string().min(1).describe("Exact text to replace."),
    new_string: z.string().describe("Replacement text (may be empty to delete)."),
    replace_all: z
      .boolean()
      .default(false)
      .describe("Replace every occurrence instead of requiring uniqueness."),
  }),
  async execute(input, context): Promise<ToolResult<EditFileOutput>> {
    const contained = resolveWithinRoot(context.cwd, input.path);
    if (!contained.ok) {
      return contained;
    }
    if (!existsSync(contained.path)) {
      return {
        ok: false,
        error: `File does not exist: ${input.path}`,
        hint: "Use write_file to create new files.",
      };
    }

    const stat = statSync(contained.path);
    const freshness = context.readTracker.check(contained.path, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    if (!freshness.ok) {
      return freshness;
    }

    let content: string;
    try {
      content = readFileSync(contained.path, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: `Could not read file: ${input.path}`,
        hint: error instanceof Error ? error.message : "unknown error",
      };
    }

    const occurrences = countOccurrences(content, input.old_string);
    if (occurrences === 0) {
      return {
        ok: false,
        error: `old_string not found in ${input.path}`,
        hint: "Read the file again and copy old_string exactly, including indentation and line breaks.",
      };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        ok: false,
        error: `old_string appears ${occurrences} times in ${input.path}`,
        hint: "Include more surrounding context in old_string to make it unique, or set replace_all=true.",
      };
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    try {
      writeFileSync(contained.path, updated, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: `Could not write file: ${input.path}`,
        hint: error instanceof Error ? error.message : "unknown error",
      };
    }

    const newStat = statSync(contained.path);
    context.readTracker.markMutated(contained.path, {
      mtimeMs: newStat.mtimeMs,
      size: newStat.size,
    });

    return {
      ok: true,
      data: {
        path: relative(context.cwd, contained.path) || input.path,
        replacements: input.replace_all ? occurrences : 1,
      },
    };
  },
});
