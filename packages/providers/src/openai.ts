import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * OpenAI direct adapter (chat completions API — the most tool-compatible
 * surface across model generations). Endpoint override via OPENAI_BASE_URL.
 */
export function createOpenAIModel(options: {
  apiKey: string;
  modelId: string;
  baseURL?: string;
}): LanguageModel {
  const openai = createOpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
  });
  return openai.chat(options.modelId);
}
