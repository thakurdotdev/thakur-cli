import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/**
 * Google Gemini direct adapter (Generative Language API). Endpoint override
 * via GOOGLE_BASE_URL (Vertex proxies etc.).
 */
export function createGoogleModel(options: {
  apiKey: string;
  modelId: string;
  baseURL?: string;
}): LanguageModel {
  const google = createGoogleGenerativeAI({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
  });
  return google.languageModel(options.modelId);
}
