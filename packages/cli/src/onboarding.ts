import * as p from "@clack/prompts";
import { PROVIDERS, availableProviders, parseHarnessEnv } from "@harness/providers";
import type { ProviderInfo } from "@harness/providers";
import { saveProviderKey } from "./config/auth.ts";

/**
 * First-boot credential onboarding.
 *
 * A launcher-launched binary has no shell environment, so `OPENROUTER_API_KEY`
 * is missing and the old behavior was a flash-close nobody could read. Now:
 * zero configured keys + interactive terminal -> one provider select, one key
 * prompt, persisted to ~/.harness/auth.json. Non-interactive boots print
 * setup instructions instead of failing.
 */

export interface OnboardingOptions {
  homeDir?: string | undefined;
  /** Test seam — every prompt is stubbed. */
  prompts?: ConnectPrompts | undefined;
  /** Test seam — intercept the save (still returns the provider id). */
  onSave?: ((providerId: string, apiKey: string) => void) | undefined;
}

/**
 * The interactive surface used here, with concrete types (clack's conditional
 * Option<Value> type is hostile to generic wrappers). A `symbol` return means
 * the user cancelled — clack's convention.
 */
export interface ConnectPrompts {
  pickProvider(
    choices: ReadonlyArray<{ value: string; label: string; hint: string }>,
  ): Promise<string | symbol>;
  askKey(message: string): Promise<string | symbol>;
  cancelled(): void;
}

function defaultPrompts(): ConnectPrompts {
  return {
    pickProvider: (choices) =>
      p.select({
        message: "Connect a provider — which one?",
        options: choices.map((choice) => ({ ...choice })),
      }),
    askKey: (message) => p.password({ message }),
    cancelled: () => {
      p.cancel("setup cancelled");
    },
  };
}

export function hasAnyProviderKey(env: Record<string, string | undefined>): boolean {
  return availableProviders(parseHarnessEnv(env)).length > 0;
}

/** Provider choices the user can connect, with the key URL as the hint. */
export function providerChoices(): Array<{ value: string; label: string; hint: string }> {
  return PROVIDERS.map((provider: ProviderInfo) => ({
    value: provider.id,
    label: provider.name,
    hint: provider.keyUrl,
  }));
}

/**
 * Interactive connect flow. Returns the provider id a key was stored for, or
 * undefined when the user bailed (cancelled, empty input).
 */
export async function runConnectFlow(options: OnboardingOptions = {}): Promise<string | undefined> {
  const ui = options.prompts ?? defaultPrompts();
  const providerId = await ui.pickProvider(providerChoices());
  if (typeof providerId !== "string") {
    ui.cancelled();
    return undefined;
  }
  const provider = PROVIDERS.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    return undefined;
  }
  const apiKey = await ui.askKey(`Paste your ${provider.name} API key (${provider.apiKeyEnv})`);
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    ui.cancelled();
    return undefined;
  }
  if (options.onSave !== undefined) {
    options.onSave(providerId, apiKey);
  } else {
    saveProviderKey(providerId, apiKey, options.homeDir);
  }
  return providerId;
}

/** Friendly, actionable instructions for non-interactive boots. */
export function credentialSetupInstructions(): string {
  return [
    "No provider API key found.",
    "Fix it either way:",
    "  1. harness auth openrouter <your-key>    # stored once, works everywhere (recommended)",
    "  2. set OPENROUTER_API_KEY in your shell or system environment",
    "Keys are stored in ~/.harness/auth.json. Get a key at https://openrouter.ai/keys",
  ].join("\n");
}
