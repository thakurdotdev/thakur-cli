import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { resolveWithinRoot } from "./internal/paths.ts";

/**
 * glob tool — file discovery by glob pattern.
 *
 * A bounded, symlink-safe directory walker: `.git` and `node_modules` are
 * skipped, directory symlinks are never followed (containment), and scan
 * depth/entry budgets keep pathological trees from consuming the run.
 * Patterns without a slash are matched anywhere in the tree (a bare "*.ts"
 * behaves like a recursive "**" + "/*.ts" match), mirroring what agents
 * intuitively expect.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_DEPTH = 32;
const MAX_SCANNED_ENTRIES = 50_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const withFileTypes = { withFileTypes: true } as const;

function walkMatches(
  baseDir: string,
  pathPrefix: string,
  matcher: (path: string) => boolean,
): string[] {
  const matches: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }];
  let scanned = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    const entries = readdirSync(
      current.dir === "" ? baseDir : join(baseDir, current.dir),
      withFileTypes,
    );
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) {
        return matches;
      }
      if (entry.isSymbolicLink()) {
        // Never follow symlinked entries: containment and no duplicate visits.
        continue;
      }
      const relFromBase = current.dir === "" ? entry.name : `${current.dir}/${entry.name}`;
      // Paths are reported (and matched) relative to the project root so a
      // pattern like "src/**/*.ts" works whether or not `path` scopes the walk.
      const fullPath = pathPrefix === "" ? relFromBase : `${pathPrefix}/${relFromBase}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || current.depth + 1 > MAX_DEPTH) {
          continue;
        }
        stack.push({ dir: relFromBase, depth: current.depth + 1 });
        continue;
      }
      if (matcher(fullPath)) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

export const glob = defineTool({
  name: "glob",
  description:
    "Find files by glob pattern. Returns matching file paths sorted alphabetically.\n\n" +
    "WHEN TO USE: Locating files before reading them — finding all test files, config files, " +
    "files with a specific extension, or files in a specific directory.\n" +
    "PREFER OVER bash find — this tool ignores .git and node_modules, never follows " +
    "symlinks, and is bounded to prevent runaway scans.\n" +
    "TIPS:\n" +
    '- Patterns without a slash match at any depth: "*.ts" works like "**/*.ts".\n' +
    '- Use "src/**/*.test.ts" for precise subdirectory matching.\n' +
    "- Use `path` to scope the search to a subdirectory for faster results.",
  risk: "read",
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe(
        'Glob pattern with / separators. Without a slash it matches at any depth ("*.ts" ≈ "**/*.ts").',
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Directory to search in, relative to the project root (default: root)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Maximum file paths to return (default ${DEFAULT_LIMIT}).`),
  }),
  async execute(input, context): Promise<ToolResult<string>> {
    const contained = resolveWithinRoot(context.cwd, input.path ?? ".");
    if (!contained.ok) {
      return contained;
    }

    let isDirectory = false;
    try {
      isDirectory = statSync(contained.path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return {
        ok: false,
        error: `Not a directory: ${input.path ?? "."}`,
        hint: "Pass an existing directory, or use read_file for a single file.",
      };
    }

    const pattern = input.pattern.includes("/") ? input.pattern : `**/${input.pattern}`;
    const matcher = picomatch(pattern, { dot: false });
    const relBase = relative(context.cwd, contained.path).split(sep).join("/");
    const pathPrefix = relBase === "" || relBase === "." ? "" : relBase;
    const matched = walkMatches(contained.path, pathPrefix, matcher).sort((a, b) =>
      a < b ? -1 : 1,
    );

    if (matched.length === 0) {
      return { ok: true, data: `No files match ${pattern} under ${relBase || "."}` };
    }

    const limit = input.limit ?? DEFAULT_LIMIT;
    const shown = matched.slice(0, limit);
    const body =
      matched.length > shown.length
        ? `${shown.join("\n")}\n(showing ${shown.length} of ${matched.length} files — raise limit or narrow the pattern)`
        : shown.join("\n");

    return {
      ok: true,
      data: context.truncator.truncate(body, `glob ${pattern} under ${relBase || "."}`),
    };
  },
});
