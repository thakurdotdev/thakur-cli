import { APICallError } from "ai";
import { describeError } from "../result.ts";

/**
 * Provider error intelligence.
 *
 * Real runs fail in provider-specific envelopes. OpenRouter in particular
 * nests the upstream provider's error as a JSON string (data.error.metadata.raw)
 * and prefixes its own tag to the message, so `error.message` alone is either
 * noisy or wrapped. This module does two jobs:
 *
 *   1. detectContextOverflow — recognize "request exceeded the model's context
 *      window" errors and parse the reported usage + real limit out of the
 *      message. Those numbers drive in-run recovery (emergency compaction and
 *      retry) and teach the harness the true window of unknown models.
 *   2. describeApiError — extract the one meaningful human sentence from an
 *      API error so renderers never dump request bodies, cookies or stacks.
 */

export interface ContextOverflow {
  /** Tokens the provider says the rejected request contained, when reported. */
  used: number | undefined;
  /** The model's real context window, parsed from the provider message. */
  limit: number;
}

/** "The request is 265113 tokens long and exceeds this model's context length of 262144 tokens." */
const OVERFLOW_USED_AND_LIMIT =
  /(\d[\d,]*)\s+tokens?\s+long[\s\S]*?context (?:length|window) (?:of|is)\s+(\d[\d,]*)/i;

/** "...maximum context length is 131072 tokens" (used size not always reported). */
const OVERFLOW_LIMIT_ONLY = /context (?:length|window) (?:of|is)\s+(\d[\d,]*)/i;

const MAX_MESSAGE_CHARS = 400;

function parseNumber(raw: string): number {
  return Number.parseInt(raw.replace(/,/g, ""), 10);
}

/**
 * Collect every plausible carrier of the provider's own message: the error
 * message itself, the parsed metadata.raw JSON string, the parsed response
 * body, and nested data.error fields.
 */
function candidateTexts(error: unknown): string[] {
  const texts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      texts.push(value);
    }
  };

  push(error instanceof Error ? error.message : undefined);

  if (APICallError.isInstance(error)) {
    const data: unknown = error.data;
    if (data !== undefined && data !== null && typeof data === "object") {
      const maybeError = (data as { error?: unknown })["error"];
      if (maybeError !== undefined && maybeError !== null && typeof maybeError === "object") {
        const metadata = (maybeError as { metadata?: unknown })["metadata"];
        if (metadata !== undefined && metadata !== null && typeof metadata === "object") {
          push((metadata as { raw?: unknown })["raw"]);
        }
        push((maybeError as { message?: unknown })["message"]);
      }
    }
    push(error.responseBody);
  }

  // JSON strings nested one level deep (metadata.raw is a JSON-encoded string).
  const nested: string[] = [];
  for (const text of texts) {
    if (text.trimStart().startsWith("{") === false) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
        const inner = (parsed as { error?: unknown })["error"];
        if (inner !== undefined && inner !== null && typeof inner === "object") {
          nested.push(String((inner as { message?: unknown })["message"] ?? ""));
          const metadata = (inner as { metadata?: unknown })["metadata"];
          if (metadata !== undefined && metadata !== null && typeof metadata === "object") {
            nested.push(String((metadata as { raw?: unknown })["raw"] ?? ""));
          }
        }
      }
    } catch {
      // Not JSON after all — the original text is already collected.
    }
  }
  return [...texts, ...nested];
}

/**
 * Detect a context-window overflow and parse the real numbers out of the
 * provider error. Returns undefined for every other failure mode — only
 * errors carrying an explicit token limit are recoverable by compaction
 * (the recovery needs the number to size the truncated history); everything
 * else must fail loudly.
 */
export function detectContextOverflow(error: unknown): ContextOverflow | undefined {
  const texts = candidateTexts(error);
  if (texts.length === 0) {
    return undefined;
  }

  let limit: number | undefined;
  let used: number | undefined;

  for (const text of texts) {
    const both = OVERFLOW_USED_AND_LIMIT.exec(text);
    if (both !== null && both[1] !== undefined && both[2] !== undefined) {
      used = parseNumber(both[1]);
      limit = parseNumber(both[2]);
      break;
    }
    if (limit === undefined) {
      const limitOnly = OVERFLOW_LIMIT_ONLY.exec(text);
      if (limitOnly !== null && limitOnly[1] !== undefined) {
        limit = parseNumber(limitOnly[1]);
      }
    }
  }

  if (limit === undefined) {
    // Some providers only send the code — no numbers to size a recovery from.
    return undefined;
  }
  if (used !== undefined && used <= limit) {
    // Message mentions a limit but the request is within it — not overflow.
    return undefined;
  }
  return { used, limit };
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > MAX_MESSAGE_CHARS ? `${line.slice(0, MAX_MESSAGE_CHARS - 3)}...` : line;
}

/**
 * One clean, human-readable sentence for any API error. Prefers the nested
 * provider message (raw JSON envelope) over the SDK wrapper text; never
 * includes stack traces, headers or request bodies.
 */
export function describeApiError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    for (const text of candidateTexts(error)) {
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.startsWith("{")) {
        continue; // wrapper text or raw JSON — skip to the meaningful layer
      }
      // Skip OpenRouter's generic wrapper sentence; the nested message is better.
      if (/^provider returned error$/i.test(trimmed)) {
        continue;
      }
      return firstLine(trimmed);
    }
  }
  if (error instanceof Error) {
    return firstLine(describeError(error));
  }
  if (typeof error === "string") {
    return firstLine(error);
  }
  return firstLine(describeError(error));
}

/** Compact human format for token counts: 999 -> "999", 265113 -> "265.1k". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) {
    return "0";
  }
  if (tokens < 10_000) {
    return `${Math.round(tokens)}`;
  }
  const k = tokens / 1000;
  const rounded = Math.round(k * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`;
  return text;
}
