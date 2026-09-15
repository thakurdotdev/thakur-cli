import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { resolveWithinRoot } from "./internal/paths.ts";

export interface WriteFileOutput {
  path: string;
  bytes: number;
  created: boolean;
}

export const write_file = defineTool({
  name: "write_file",
  description:
    "Create a new file or overwrite an existing file inside the project. Parent " +
    "directories are created automatically.\n\n" +
    "WHEN TO USE: Creating new files. Overwriting an existing file when the change is so " +
    "extensive that edit_file would be unwieldy.\n" +
    "PREFER edit_file for targeted changes to existing files — it preserves unmodified content " +
    "and produces clearer diffs.\n" +
    "KEY BEHAVIOR: Overwriting an existing file requires reading it with read_file first " +
    "(stale-view protection). New files can be written directly.",
  risk: "write",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("File path, relative to the project root (or absolute inside it)."),
    content: z.string().describe("Full file content to write."),
  }),
  async execute(input, context): Promise<ToolResult<WriteFileOutput>> {
    const contained = resolveWithinRoot(context.cwd, input.path);
    if (!contained.ok) {
      return contained;
    }

    const existed = existsSync(contained.path);
    if (existed) {
      const stat = statSync(contained.path);
      const check = context.readTracker.check(contained.path, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
      if (!check.ok) {
        return check;
      }
    }

    try {
      mkdirSync(dirname(contained.path), { recursive: true });
      writeFileSync(contained.path, input.content, "utf8");
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
        bytes: Buffer.byteLength(input.content, "utf8"),
        created: !existed,
      },
    };
  },
});
