import type { ToolResult } from "./result.ts";

/**
 * Read-before-edit tracking.
 *
 * Files must be observed before they can be mutated: `edit_file` and
 * `write_file` (over an existing file) refuse to act until the current
 * contents were read in this session, and re-refuse if the file changed on
 * disk after being read (stale view protection).
 */

export interface FileStatSnapshot {
  mtimeMs: number;
  size: number;
}

export class ReadTracker {
  private readonly entries = new Map<string, FileStatSnapshot>();

  /** Record that a file was observed at a specific state. */
  markRead(path: string, stat: FileStatSnapshot): void {
    this.entries.set(path, stat);
  }

  /** Record that the harness itself mutated the file (new state is trusted). */
  markMutated(path: string, stat: FileStatSnapshot): void {
    this.entries.set(path, stat);
  }

  wasRead(path: string): boolean {
    return this.entries.has(path);
  }

  /** Verify the file may be mutated now. Returns errors-as-data, never throws. */
  check(path: string, current: FileStatSnapshot): ToolResult<null> {
    const known = this.entries.get(path);
    if (known === undefined) {
      return {
        ok: false,
        error: `File has not been read yet: ${path}`,
        hint: "Read the file with read_file before editing or overwriting it.",
      };
    }
    if (known.mtimeMs !== current.mtimeMs || known.size !== current.size) {
      return {
        ok: false,
        error: `File changed since it was last read: ${path}`,
        hint: "Read the file again to refresh your view, then retry the edit.",
      };
    }
    return { ok: true, data: null };
  }
}
