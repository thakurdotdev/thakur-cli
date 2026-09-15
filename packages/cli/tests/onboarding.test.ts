import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialSetupInstructions,
  hasAnyProviderKey,
  providerChoices,
  runConnectFlow,
} from "../src/onboarding.ts";
import type { ConnectPrompts } from "../src/onboarding.ts";
import { loadAuthStore } from "../src/config/auth.ts";

/** First-boot credential onboarding, exercised with stubbed prompts. */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "harness-onboarding-"));
}

function stubPrompts(
  providerValue: string | symbol,
  keyValue: string | symbol,
  calls: { cancelled: number },
): ConnectPrompts {
  return {
    pickProvider: async () => providerValue,
    askKey: async () => keyValue,
    cancelled: () => {
      calls.cancelled += 1;
    },
  };
}

describe("hasAnyProviderKey", () => {
  it("false with no keys, true with any provider credential", () => {
    expect(hasAnyProviderKey({})).toBe(false);
    expect(hasAnyProviderKey({ OPENROUTER_API_KEY: "sk-x" })).toBe(true);
    expect(hasAnyProviderKey({ GOOGLE_API_KEY: "g" })).toBe(true);
  });
});

describe("providerChoices", () => {
  it("covers every registry provider with key URLs as hints", () => {
    const choices = providerChoices();
    expect(choices.map((choice) => choice.value)).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "google",
    ]);
    for (const choice of choices) {
      expect(choice.hint).toMatch(/^https:\/\//);
    }
  });
});

describe("runConnectFlow", () => {
  it("saves the key to the auth store and returns the provider id", async () => {
    const home = tempHome();
    try {
      const calls = { cancelled: 0 };
      const providerId = await runConnectFlow({
        homeDir: home,
        prompts: stubPrompts("openrouter", "  sk-or-key  ", calls),
      });
      expect(providerId).toBe("openrouter");
      expect(loadAuthStore(home).keys["openrouter"]).toBe("sk-or-key");
      expect(calls.cancelled).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("routes through onSave when provided (no disk write)", async () => {
    const home = tempHome();
    try {
      const saved: Array<[string, string]> = [];
      const providerId = await runConnectFlow({
        homeDir: home,
        onSave: (id, key) => saved.push([id, key]),
        prompts: stubPrompts("openai", "sk-oai", { cancelled: 0 }),
      });
      expect(providerId).toBe("openai");
      expect(saved).toEqual([["openai", "sk-oai"]]);
      expect(loadAuthStore(home).keys).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("cancelled provider select returns undefined without saving", async () => {
    const home = tempHome();
    try {
      const calls = { cancelled: 0 };
      const providerId = await runConnectFlow({
        homeDir: home,
        prompts: stubPrompts(Symbol("cancel"), "sk-x", calls),
      });
      expect(providerId).toBeUndefined();
      expect(calls.cancelled).toBe(1);
      expect(loadAuthStore(home).keys).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("empty key cancels the flow", async () => {
    const home = tempHome();
    try {
      const calls = { cancelled: 0 };
      const providerId = await runConnectFlow({
        homeDir: home,
        prompts: stubPrompts("openrouter", "   ", calls),
      });
      expect(providerId).toBeUndefined();
      expect(calls.cancelled).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("credentialSetupInstructions", () => {
  it("names the auth command, the env var and the key URL", () => {
    const text = credentialSetupInstructions();
    expect(text).toContain("harness auth openrouter");
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(text).toContain("https://openrouter.ai/keys");
  });
});
