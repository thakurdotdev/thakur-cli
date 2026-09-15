import { readdirSync, readlinkSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { resolveWithinRoot } from "./internal/paths.ts";

/**
 * list_dir tool — single-level directory listing.
 *
 * Directories sort before files (both alphabetically) and are suffixed with
 * `/`, symlinks with `@` plus their target. Bounded to MAX_ENTRIES so huge
 * directories cannot flood the context; recursive discovery belongs to glob.
 */

const MAX_ENTRIES = 500;
const MAX_LINK_TARGET_CHARS = 100;

interface DirEntryView {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink";
}

function formatEntry(entry: DirEntryView, baseDir: string): string {
  if (entry.kind === "directory") {
    return `${entry.name}/`;
  }
  if (entry.kind === "symlink") {
    let target: string | null = null;
    try {
      target = readlinkSync(join(baseDir, entry.name));
    } catch {
      target = null;
    }
    if (target !== null && target.length > 0) {
      const trimmed =
        target.length > MAX_LINK_TARGET_CHARS
          ? `${target.slice(0, MAX_LINK_TARGET_CHARS - 3)}...`
          : target;
      return `${entry.name}@ -> ${trimmed}`;
    }
    return `${entry.name}@`;
  }
  return entry.name;
}

export const list_dir = defineTool({
  name: "list_dir",
  description:
    "List the immediate contents of a directory. Shows directories first (with trailing /), " +
    "then files, both sorted alphabetically. Symlinks are marked with @.\n\n" +
    "WHEN TO USE: Understanding project structure, seeing what files exist in a specific " +
    "directory, orienting yourself before diving deeper.\n" +
    "FOR RECURSIVE SEARCH: Use glob instead — list_dir only shows one level.\n" +
    "FOR CONTENT SEARCH: Use grep — list_dir only shows names, not contents.",
  risk: "read",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Directory to list, relative to the project root (default: root)."),
  }),
  async execute(input, context): Promise<ToolResult<string>> {
    const contained = resolveWithinRoot(context.cwd, input.path ?? ".");
    if (!contained.ok) {
      return contained;
    }

    let entries: DirEntryView[];
    try {
      const stat = statSync(contained.path);
      if (!stat.isDirectory()) {
        return {
          ok: false,
          error: `Not a directory: ${input.path ?? "."}`,
          hint: "list_dir lists directories — use read_file for files or glob for discovery.",
        };
      }
      entries = readdirSync(contained.path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? ("symlink" as const)
          : entry.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
      }));
    } catch (error) {
      return {
        ok: false,
        error: `Could not list directory: ${input.path ?? "."}`,
        hint: error instanceof Error ? error.message : "Check the path and try again.",
      };
    }

    entries.sort((a, b) => {
      const aDir = a.kind === "directory" ? 0 : 1;
      const bDir = b.kind === "directory" ? 0 : 1;
      if (aDir !== bDir) {
        return aDir - bDir;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    const relPath = relative(context.cwd, contained.path) || ".";
    if (entries.length === 0) {
      return { ok: true, data: `${relPath} — empty directory` };
    }

    const shown = entries.slice(0, MAX_ENTRIES);
    const body = shown.map((entry) => formatEntry(entry, contained.path)).join("\n");
    const suffix =
      entries.length > shown.length
        ? `\n(${entries.length - shown.length} more entries not shown — use glob to search instead)`
        : "";

    return {
      ok: true,
      data: context.truncator.truncate(
        `${relPath} — ${entries.length} entries\n${body}${suffix}`,
        relPath,
      ),
    };
  },
});
