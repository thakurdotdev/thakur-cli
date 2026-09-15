import type { HarnessEnv } from "./env.ts";
import { googleApiKey } from "./env.ts";

/**
 * Provider registry — the one table describing every supported provider.
 *
 * `harness models` renders it; resolveModel dispatches on it; README keeps in
 * sync with it. Adding a provider = one adapter module + one entry here +
 * one case in resolveModel.
 */
export interface ProviderInfo {
  /** Ref prefix, e.g. "openai" in "openai:gpt-4.1". */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Environment variable holding the API key. */
  readonly apiKeyEnv: string;
  /** Where to create a key (shown in the missing-key hint). */
  readonly keyUrl: string;
  /** A few well-known model ids for the `models` listing. */
  readonly exampleModels: readonly string[];
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    exampleModels: [
      "nex-agi/nex-n2.5-pro:free",
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat-v3.1",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    exampleModels: ["gpt-5", "gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    exampleModels: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
  },
  {
    id: "google",
    name: "Google Gemini",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    keyUrl: "https://aistudio.google.com/app/apikey",
    exampleModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
];

export function lookupProvider(providerId: string): ProviderInfo | undefined {
  const key = providerId.trim().toLowerCase();
  if (key === "gemini") {
    return PROVIDERS.find((provider) => provider.id === "google");
  }
  return PROVIDERS.find((provider) => provider.id === key);
}

/** The API key a provider needs, resolved through aliases. */
export function providerApiKey(provider: ProviderInfo, env: HarnessEnv): string | undefined {
  if (provider.id === "google") {
    return googleApiKey(env);
  }
  // apiKeyEnv is always one of the schema's declared keys.
  return env[provider.apiKeyEnv as keyof HarnessEnv];
}

/** Providers whose credentials are present in the environment. */
export function availableProviders(env: HarnessEnv): ProviderInfo[] {
  return PROVIDERS.filter((provider) => providerApiKey(provider, env) !== undefined);
}
