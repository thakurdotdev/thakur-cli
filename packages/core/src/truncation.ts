/**
 * Bounded tool output.
 *
 * Every tool result that flows back to the model passes through a truncator so
 * a single huge file or command output cannot blow up the context window.
 * Truncation keeps both ends (head + tail) because interesting content is
 * frequently at either end.
 */

export interface Truncator {
  /** Truncate `text` to the configured budget, inserting an explicit marker. */
  truncate(text: string, label?: string): string;
}

const MARKER_BUDGET_CHARS = 220;

export function createTruncator(options: { maxChars: number }): Truncator {
  const maxChars = Math.max(1_000, Math.floor(options.maxChars));

  return {
    truncate(text: string, label?: string): string {
      if (text.length <= maxChars) {
        return text;
      }
      const headChars = Math.floor(maxChars * 0.6);
      const tailChars = Math.max(0, maxChars - headChars - MARKER_BUDGET_CHARS);
      const head = text.slice(0, headChars);
      const tail = tailChars > 0 ? text.slice(-tailChars) : "";
      const omitted = text.length - head.length - tail.length;
      const where = label === undefined ? "" : ` in ${label}`;
      return `${head}\n\n[output truncated${where}: showing first ${head.length} and last ${tail.length} of ${text.length} characters — ${omitted} omitted]\n\n${tail}`;
    },
  };
}
