/**
 * Model metadata catalog.
 *
 * A curated, code-versioned table of widely used models: context window,
 * output ceiling, and advertised pricing. It exists so the harness can (a)
 * size token budgets against the real window and (b) show a credible cost
 * estimate per run without a network round-trip.
 *
 * Prices are **approximate, advertised list prices in USD per million tokens**
 * and may drift from what OpenRouter actually charges for a given endpoint.
 * Unknown models resolve to `undefined` — the harness then simply omits cost
 * estimates instead of guessing. Review this table when bumping pins.
 */

export interface ModelMetadata {
  /** Canonical OpenRouter-style model id, e.g. "anthropic/claude-sonnet-4.5". */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Total context window in tokens (input + output share it). */
  readonly contextLength: number;
  /** Largest single completion, when documented. */
  readonly maxOutputTokens: number | undefined;
  /** Advertised USD per million input tokens. */
  readonly inputPricePerMillion: number;
  /** Advertised USD per million output tokens. */
  readonly outputPricePerMillion: number;
}

function model(metadata: ModelMetadata): ModelMetadata {
  return metadata;
}

export const MODEL_CATALOG: readonly ModelMetadata[] = [
  model({
    id: "nex-agi/nex-n2.5-pro:free",
    name: "Nex-N2.5-Pro (free)",
    contextLength: 262_144,
    maxOutputTokens: 65_536,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
  }),
  model({
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
  }),
  model({
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
  }),
  model({
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    inputPricePerMillion: 15,
    outputPricePerMillion: 75,
  }),
  model({
    id: "openai/gpt-5",
    name: "GPT-5",
    contextLength: 400_000,
    maxOutputTokens: 128_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
  }),
  model({
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    contextLength: 1_000_000,
    maxOutputTokens: 32_768,
    inputPricePerMillion: 2,
    outputPricePerMillion: 8,
  }),
  model({
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 mini",
    contextLength: 1_000_000,
    maxOutputTokens: 32_768,
    inputPricePerMillion: 0.4,
    outputPricePerMillion: 1.6,
  }),
  model({
    id: "openai/gpt-4o",
    name: "GPT-4o",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 10,
  }),
  model({
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
  }),
  model({
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 2.5,
  }),
  model({
    id: "x-ai/grok-4",
    name: "Grok 4",
    contextLength: 256_000,
    maxOutputTokens: 32_768,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
  }),
  model({
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek V3.1",
    contextLength: 163_840,
    maxOutputTokens: 98_304,
    inputPricePerMillion: 0.27,
    outputPricePerMillion: 1.1,
  }),
  model({
    id: "moonshotai/kimi-k2",
    name: "Kimi K2",
    contextLength: 131_072,
    maxOutputTokens: 32_768,
    inputPricePerMillion: 0.6,
    outputPricePerMillion: 2.5,
  }),
  model({
    id: "qwen/qwen3-coder",
    name: "Qwen3 Coder",
    contextLength: 262_144,
    maxOutputTokens: 65_536,
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 1.2,
  }),
  model({
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    contextLength: 131_072,
    maxOutputTokens: 16_384,
    inputPricePerMillion: 0.12,
    outputPricePerMillion: 0.3,
  }),
];

const CATALOG_BY_ID = new Map<string, ModelMetadata>(
  MODEL_CATALOG.map((entry) => [entry.id.toLowerCase(), entry]),
);

/**
 * Look up metadata for a model id. Matching is case-insensitive and tolerant
 * of a missing vendor prefix: "claude-sonnet-4.5" resolves to
 * "anthropic/claude-sonnet-4.5" (first vendor match wins, deterministically).
 */
export function lookupModelMetadata(modelId: string): ModelMetadata | undefined {
  const key = modelId.trim().toLowerCase();
  if (key.length === 0) {
    return undefined;
  }
  const exact = CATALOG_BY_ID.get(key);
  if (exact !== undefined) {
    return exact;
  }
  for (const entry of MODEL_CATALOG) {
    if (entry.id.toLowerCase().endsWith(`/${key}`)) {
      return entry;
    }
  }
  return undefined;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Cost estimate from advertised list prices; `undefined` when the model is
 * unknown (never a fabricated number).
 */
export function estimateCostUsd(
  usage: UsageTotals,
  metadata: ModelMetadata | undefined,
): number | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const inputCost = (usage.inputTokens / 1_000_000) * metadata.inputPricePerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * metadata.outputPricePerMillion;
  return inputCost + outputCost;
}

/** Format a cost for one-line summaries: "$0.0042", "<$0.0001", "$1.2345". */
export function formatCostUsd(cost: number | undefined): string | undefined {
  if (cost === undefined) {
    return undefined;
  }
  if (cost > 0 && cost < 0.0001) {
    return "<$0.0001";
  }
  return `$${cost.toFixed(4)}`;
}
