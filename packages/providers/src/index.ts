import type { LanguageModel } from "ai";
import { HarnessError } from "@harness/core";
import { createOpenRouterModel } from "./openrouter.ts";
import { createOpenAIModel } from "./openai.ts";
import { createAnthropicModel } from "./anthropic.ts";
import { createGoogleModel } from "./google.ts";
import { parseModelRef } from "./model-ref.ts";
import type { HarnessEnv } from "./env.ts";

/**
 * Provider registry + model resolution.
 *
 * `provider:model` -> concrete AI SDK LanguageModel. Every provider failure
 * mode is an actionable HarnessError: which env var, where to get a key.
 */

export interface ResolveModelOptions {
  env: HarnessEnv;
}

function missingKeyError(providerId: string, apiKeyEnv: string, keyUrl: string): HarnessError {
  return new HarnessError(
    `${apiKeyEnv} is not set (provider "${providerId}")`,
    `Create a key at ${keyUrl} and export ${apiKeyEnv} — or pick a model on a provider you have configured, e.g. --model "openrouter:nex-agi/nex-n2.5-pro:free". Run "harness models" to see what's available.`,
  );
}

export function resolveModel(rawModelId: string, options: ResolveModelOptions): LanguageModel {
  const ref = parseModelRef(rawModelId);

  switch (ref.provider) {
    case "openrouter": {
      const apiKey = options.env.OPENROUTER_API_KEY;
      if (apiKey === undefined) {
        throw missingKeyError(ref.provider, "OPENROUTER_API_KEY", "https://openrouter.ai/keys");
      }
      return createOpenRouterModel({ apiKey, modelId: ref.id });
    }
    case "openai": {
      const apiKey = options.env.OPENAI_API_KEY;
      if (apiKey === undefined) {
        throw missingKeyError(
          ref.provider,
          "OPENAI_API_KEY",
          "https://platform.openai.com/api-keys",
        );
      }
      return createOpenAIModel({
        apiKey,
        modelId: ref.id,
        ...(options.env.OPENAI_BASE_URL !== undefined
          ? { baseURL: options.env.OPENAI_BASE_URL }
          : {}),
      });
    }
    case "anthropic": {
      const apiKey = options.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined) {
        throw missingKeyError(
          ref.provider,
          "ANTHROPIC_API_KEY",
          "https://console.anthropic.com/settings/keys",
        );
      }
      return createAnthropicModel({
        apiKey,
        modelId: ref.id,
        ...(options.env.ANTHROPIC_BASE_URL !== undefined
          ? { baseURL: options.env.ANTHROPIC_BASE_URL }
          : {}),
      });
    }
    case "google": {
      const apiKey = options.env.GOOGLE_GENERATIVE_AI_API_KEY ?? options.env.GOOGLE_API_KEY;
      if (apiKey === undefined) {
        throw missingKeyError(
          ref.provider,
          "GOOGLE_GENERATIVE_AI_API_KEY",
          "https://aistudio.google.com/app/apikey",
        );
      }
      return createGoogleModel({
        apiKey,
        modelId: ref.id,
        ...(options.env.GOOGLE_BASE_URL !== undefined
          ? { baseURL: options.env.GOOGLE_BASE_URL }
          : {}),
      });
    }
    default: {
      const supported = ["openrouter", "openai", "anthropic", "google"];
      throw new HarnessError(
        `Unknown provider: "${ref.provider}"`,
        `Supported providers: ${supported.map((id) => `"${id}:"`).join(", ")}. Run "harness models" for the catalog and credential status.`,
      );
    }
  }
}

export { parseModelRef, formatModelRef } from "./model-ref.ts";
export type { ModelRef } from "./model-ref.ts";
export { DEFAULT_PROVIDER_ID } from "./model-ref.ts";
export { createOpenRouterModel } from "./openrouter.ts";
export { createOpenAIModel } from "./openai.ts";
export { createAnthropicModel, toAnthropicModelId } from "./anthropic.ts";
export { createGoogleModel } from "./google.ts";
export { parseHarnessEnv, HarnessEnvSchema, googleApiKey } from "./env.ts";
export type { HarnessEnv } from "./env.ts";
export { PROVIDERS, availableProviders, lookupProvider, providerApiKey } from "./registry.ts";
export type { ProviderInfo } from "./registry.ts";
export { MODEL_CATALOG, lookupModelMetadata, estimateCostUsd, formatCostUsd } from "./metadata.ts";
export type { ModelMetadata, UsageTotals } from "./metadata.ts";
export {
  fetchProviderModels,
  fallbackModelsForProvider,
  sortModelsForDisplay,
  PROVIDER_MODELS_ENDPOINTS,
} from "./catalog.ts";
export type { ProviderModelInfo, FetchProviderModelsOptions } from "./catalog.ts";
