import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

/**
 * Anthropic direct adapter (Messages API). Endpoint override via
 * ANTHROPIC_BASE_URL (useful for gateways and Bedrock-style proxies).
 *
 * Model-id ergonomics: the harness catalog uses OpenRouter-style ids
 * ("claude-sonnet-4.5"), while Anthropic's own API ids hyphenate the version
 * ("claude-sonnet-4-5"). Both spellings are accepted, and a stray vendor
 * prefix ("anthropic/claude-sonnet-4.5") is stripped.
 */

const ANTHROPIC_MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["claude-sonnet-4.5", "claude-sonnet-4-5"],
  ["claude-haiku-4.5", "claude-haiku-4-5"],
  ["claude-opus-4.1", "claude-opus-4-1"],
]);

export function toAnthropicModelId(rawId: string): string {
  const lastSegment = rawId.includes("/") ? (rawId.split("/").pop() ?? rawId) : rawId;
  return ANTHROPIC_MODEL_ALIASES.get(lastSegment) ?? lastSegment;
}

export function createAnthropicModel(options: {
  apiKey: string;
  modelId: string;
  baseURL?: string;
}): LanguageModel {
  const anthropic = createAnthropic({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
  });
  return anthropic.languageModel(toAnthropicModelId(options.modelId));
}
