import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * OpenRouter adapter — primary model access for Phase 1.
 *
 * One API key, broad model catalog. The engine depends on the AI SDK
 * `LanguageModel` abstraction, never on OpenRouter directly, so direct
 * provider adapters (Phase 5) drop in as replacements.
 */
export function createOpenRouterModel(options: { apiKey: string; modelId: string }): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey: options.apiKey,
    compatibility: "strict",
  });
  return openrouter.chat(options.modelId);
}
