import type { ModelMessage } from "ai";

/**
 * Token estimation.
 *
 * A real tokenizer would pull in model-specific vocabulary; the engine only
 * needs a fast, conservative estimate for two jobs: deciding when to compact
 * context and showing "context usage" in summaries. The heuristic below is
 * deliberately cheap (single pass, no allocations) and biased upward for the
 * scripts this harness deals with most.
 *
 * Heuristic: CJK/Hangul code points cost roughly one token each; everything
 * else averages about four characters per token. Estimates are never used for
 * billing — cost estimates come from the model metadata catalog instead.
 */

const CHARS_PER_TOKEN = 4;

function isWideCodePoint(code: number): boolean {
  // CJK radicals/punctuation/kana/unified ideographs, Hangul, compatibility
  // ideographs — these tokenize close to one token per character.
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** Estimate the token count of a text string. Never returns less than 1. */
export function estimateTokens(text: string): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    units += isWideCodePoint(code) ? 1 : 1 / CHARS_PER_TOKEN;
  }
  return Math.max(1, Math.ceil(units));
}

/** Per-message overhead (role framing and message boundaries). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimate the token count of a message list, including per-message framing
 * overhead. This mirrors what the provider re-sends on every step, so it is
 * the right input for context-window decisions.
 */
export function estimateMessagesTokens(messages: ReadonlyArray<ModelMessage>): number {
  let total = 0;
  for (const message of messages) {
    let serialized: string;
    try {
      serialized = JSON.stringify(message) ?? "";
    } catch {
      serialized = "";
    }
    total += estimateTokens(serialized) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}
