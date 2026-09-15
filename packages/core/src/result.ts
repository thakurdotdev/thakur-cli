/**
 * Errors as data.
 *
 * Tool results are discriminated unions so the model receives actionable
 * feedback and TypeScript forces explicit failure handling. Tools must never
 * throw for expected failure modes; unexpected exceptions are caught at the
 * agent-loop boundary and converted into error results.
 */

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string; hint?: string };

/** Error thrown for user-facing configuration / setup problems. Carries an actionable hint. */
export class HarnessError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "HarnessError";
    this.hint = hint;
  }
}

/** Best-effort human-readable description of an unknown error value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export function isAbortError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  if (typeof error === "object") {
    if ("name" in error && (error as { name: unknown }).name === "AbortError") {
      return true;
    }
    if ("code" in error && (error as { code: unknown }).code === "ABORT_ERR") {
      return true;
    }
    if ("cause" in error && isAbortError((error as { cause: unknown }).cause)) {
      return true;
    }
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("interrupted")) {
      return true;
    }
  }
  return false;
}
