import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Path containment helpers.
 *
 * Writes are contained within the project root; path traversal and symlink
 * escapes are checked before any filesystem mutation. Real paths are resolved
 * so a symlink pointing outside the root cannot bypass containment.
 */

/** realpath that tolerates not-yet-existing files: resolves the deepest existing ancestor. */
export function realpathSafe(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) {
      return target;
    }
    return join(realpathSafe(parent), basename(target));
  }
}

export type ContainedPath = { ok: true; path: string } | { ok: false; error: string; hint: string };

/**
 * Resolve `target` (relative or absolute) against `root` and verify the real
 * path stays inside the real root.
 */
export function resolveWithinRoot(root: string, target: string): ContainedPath {
  if (target.trim().length === 0) {
    return {
      ok: false,
      error: "Path must not be empty",
      hint: "Pass a relative path inside the project root.",
    };
  }
  const rootReal = realpathSafe(root);
  const candidate = isAbsolute(target) ? resolve(target) : resolve(rootReal, target);
  const candidateReal = realpathSafe(candidate);
  if (candidateReal === rootReal || candidateReal.startsWith(rootReal + sep)) {
    return { ok: true, path: candidateReal };
  }
  return {
    ok: false,
    error: `Path escapes the project root: ${target}`,
    hint: `Only paths inside ${rootReal} are accessible to file tools.`,
  };
}

/** Format file contents with 1-based line numbers (cat -n style). */
export function formatNumberedLines(lines: string[], firstLine: number): string {
  return lines
    .map((line, index) => `${String(firstLine + index).padStart(6, " ")}\t${line}`)
    .join("\n");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}
