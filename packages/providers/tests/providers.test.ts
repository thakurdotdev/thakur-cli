import { describe, expect, it } from "vitest";
import {
  parseModelRef,
  formatModelRef,
  resolveModel,
  parseHarnessEnv,
  MODEL_CATALOG,
  lookupModelMetadata,
  estimateCostUsd,
  formatCostUsd,
  PROVIDERS,
  availableProviders,
  lookupProvider,
  toAnthropicModelId,
} from "@harness/providers";
import { HarnessError } from "@harness/core";
import type { LanguageModel } from "ai";

describe("parseModelRef", () => {
  it("defaults to the openrouter provider when no colon is present", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4.5")).toEqual({
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.5",
    });
  });

  it("splits on the first colon only", () => {
    expect(parseModelRef("openrouter:anthropic/claude-sonnet-4.5")).toEqual({
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.5",
    });
    expect(parseModelRef("weird:model:id:with:colons")).toEqual({
      provider: "weird",
      id: "model:id:with:colons",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelRef("  openrouter:openai/gpt-4.1-mini  ")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-4.1-mini",
    });
  });

  it("rejects empty input and malformed refs", () => {
    expect(() => parseModelRef("")).toThrow(HarnessError);
    expect(() => parseModelRef(":model")).toThrow(HarnessError);
    expect(() => parseModelRef("provider:")).toThrow(HarnessError);
  });
});

describe("formatModelRef", () => {
  it("round-trips a ref", () => {
    const ref = parseModelRef("openrouter:anthropic/claude-sonnet-4.5");
    expect(formatModelRef(ref)).toBe("openrouter:anthropic/claude-sonnet-4.5");
  });
});

describe("resolveModel", () => {
  it("throws with an actionable hint when OPENROUTER_API_KEY is missing", () => {
    expect(() => resolveModel("openrouter:anthropic/claude-sonnet-4.5", { env: {} })).toThrowError(
      expect.objectContaining({
        name: "HarnessError",
        message: expect.stringContaining("OPENROUTER_API_KEY"),
      }),
    );
  });

  it("returns a model object when a key is present (no network at construction)", () => {
    const model = resolveModel("openrouter:openai/gpt-4.1-mini", {
      env: parseHarnessEnv({ OPENROUTER_API_KEY: "sk-test" }),
    });
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("rejects unknown providers with the supported list", () => {
    expect(() =>
      resolveModel("azure:gpt-x", {
        env: parseHarnessEnv({ OPENROUTER_API_KEY: "sk-test" }),
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("Unknown provider"),
        hint: expect.stringContaining("openrouter"),
      }),
    );
  });

  it("rejects empty model ids", () => {
    expect(() => resolveModel("openrouter:", { env: parseHarnessEnv({}) })).toThrow(HarnessError);
  });
});

describe("parseHarnessEnv", () => {
  it("keeps known keys and drops everything else", () => {
    const env = parseHarnessEnv({
      OPENROUTER_API_KEY: "sk",
      HARNESS_MODEL: "openrouter:x/y",
      UNRELATED_SECRET: "never-propagates",
    });
    expect(env).toEqual({ OPENROUTER_API_KEY: "sk", HARNESS_MODEL: "openrouter:x/y" });
  });

  it("tolerates an empty environment", () => {
    expect(parseHarnessEnv({})).toEqual({});
  });

  it("accepts direct provider credentials and endpoint overrides", () => {
    const env = parseHarnessEnv({
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      GOOGLE_API_KEY: "g-key",
      OPENAI_BASE_URL: "https://proxy.example.com/v1",
      UNRELATED: "dropped",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.GOOGLE_API_KEY).toBe("g-key");
    expect(env.OPENAI_BASE_URL).toBe("https://proxy.example.com/v1");
  });
});

describe("direct provider adapters", () => {
  type V4Spec = Extract<LanguageModel, { specificationVersion: "v4" }>;

  it("resolves openai models through OPENAI_API_KEY (no network at construction)", () => {
    const model = resolveModel("openai:gpt-4.1", {
      env: parseHarnessEnv({ OPENAI_API_KEY: "sk-test" }),
    }) as V4Spec;
    expect(model.modelId).toBe("gpt-4.1");
    expect(model.provider).toBe("openai.chat");
    expect(model.specificationVersion).toBe("v4");
  });

  it("resolves anthropic models and normalizes catalog ids to API ids", () => {
    const dotted = resolveModel("anthropic:claude-sonnet-4.5", {
      env: parseHarnessEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
    }) as V4Spec;
    expect(dotted.modelId).toBe("claude-sonnet-4-5");
    expect(dotted.provider).toBe("anthropic.messages");

    const hyphenated = resolveModel("anthropic:claude-sonnet-4-5", {
      env: parseHarnessEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
    }) as V4Spec;
    expect(hyphenated.modelId).toBe("claude-sonnet-4-5");

    const prefixed = resolveModel("anthropic:anthropic/claude-haiku-4.5", {
      env: parseHarnessEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
    }) as V4Spec;
    expect(prefixed.modelId).toBe("claude-haiku-4-5");
  });

  it("passes unknown anthropic ids through untouched", () => {
    const model = resolveModel("anthropic:claude-future-9", {
      env: parseHarnessEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
    }) as V4Spec;
    expect(model.modelId).toBe("claude-future-9");
  });

  it("resolves google models through either key spelling", () => {
    const canonical = resolveModel("google:gemini-2.5-pro", {
      env: parseHarnessEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "g-key" }),
    }) as V4Spec;
    expect(canonical.modelId).toBe("gemini-2.5-pro");
    expect(canonical.provider).toBe("google.generative-ai");

    const alias = resolveModel("google:gemini-2.5-flash", {
      env: parseHarnessEnv({ GOOGLE_API_KEY: "g-key" }),
    }) as V4Spec;
    expect(alias.modelId).toBe("gemini-2.5-flash");
  });

  it("fails with actionable hints when a direct provider key is missing", () => {
    expect(() => resolveModel("openai:gpt-4.1", { env: parseHarnessEnv({}) })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("OPENAI_API_KEY"),
        hint: expect.stringContaining("platform.openai.com"),
      }),
    );
    expect(() =>
      resolveModel("anthropic:claude-sonnet-4-5", { env: parseHarnessEnv({}) }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("ANTHROPIC_API_KEY"),
        hint: expect.stringContaining("console.anthropic.com"),
      }),
    );
    expect(() => resolveModel("google:gemini-2.5-pro", { env: parseHarnessEnv({}) })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("GOOGLE_GENERATIVE_AI_API_KEY"),
        hint: expect.stringContaining("aistudio.google.com"),
      }),
    );
  });

  it("maps OpenRouter-style ids to Anthropic API ids", () => {
    expect(toAnthropicModelId("claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(toAnthropicModelId("claude-opus-4.1")).toBe("claude-opus-4-1");
    expect(toAnthropicModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(toAnthropicModelId("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(toAnthropicModelId("claude-future-9")).toBe("claude-future-9");
  });
});

describe("provider registry", () => {
  it("looks providers up case-insensitively", () => {
    expect(lookupProvider("OpenAI")?.id).toBe("openai");
    expect(lookupProvider("google")?.apiKeyEnv).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(lookupProvider("gemini")?.id).toBe("google");
    expect(lookupProvider("azure")).toBeUndefined();
  });

  it("reports which providers are configured", () => {
    const env = parseHarnessEnv({ OPENAI_API_KEY: "sk", GOOGLE_API_KEY: "g" });
    const ids = availableProviders(env).map((provider) => provider.id);
    expect(ids).toEqual(["openai", "google"]);
  });

  it("every cataloged provider has an adapter route in resolveModel", () => {
    // A provider in the registry without a resolveModel case would only
    // fail at user runtime — assert the registry stays in sync. Missing-key
    // errors are fine; "Unknown provider" means a broken route.
    for (const provider of PROVIDERS) {
      try {
        resolveModel(`${provider.id}:whatever-model`, { env: parseHarnessEnv({}) });
      } catch (error) {
        expect((error as Error).message).not.toContain("Unknown provider");
      }
    }
  });
});

describe("model metadata", () => {
  it("catalog entries are complete and uniquely keyed (case-insensitively)", () => {
    const seen = new Set<string>();
    for (const entry of MODEL_CATALOG) {
      const key = entry.id.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.contextLength).toBeGreaterThan(0);
      expect(entry.inputPricePerMillion).toBeGreaterThanOrEqual(0);
      expect(entry.outputPricePerMillion).toBeGreaterThanOrEqual(0);
    }
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it("resolves exact ids case-insensitively", () => {
    const meta = lookupModelMetadata("ANTHROPIC/CLAUDE-SONNET-4.5");
    expect(meta?.id).toBe("anthropic/claude-sonnet-4.5");
    expect(meta?.contextLength).toBe(200_000);
  });

  it("resolves vendor-less ids to a deterministic vendor match", () => {
    expect(lookupModelMetadata("claude-sonnet-4.5")?.id).toBe("anthropic/claude-sonnet-4.5");
    expect(lookupModelMetadata("gpt-4.1-mini")?.id).toBe("openai/gpt-4.1-mini");
  });

  it("returns undefined for unknown or empty ids instead of guessing", () => {
    expect(lookupModelMetadata("totally-made-up/model-x")).toBeUndefined();
    expect(lookupModelMetadata("   ")).toBeUndefined();
  });

  it("estimates cost from advertised per-million prices", () => {
    const meta = lookupModelMetadata("openai/gpt-4.1-mini");
    expect(meta).toBeDefined();
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000 }, meta);
    expect(cost).toBeCloseTo(0.4 + 0.8, 10);
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0 }, meta)).toBe(0);
  });

  it("never fabricates costs for unknown models", () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, undefined)).toBeUndefined();
    expect(formatCostUsd(undefined)).toBeUndefined();
  });

  it("formats cost labels for one-line summaries", () => {
    expect(formatCostUsd(0)).toBe("$0.0000");
    expect(formatCostUsd(0.0000042)).toBe("<$0.0001");
    expect(formatCostUsd(1.23456)).toBe("$1.2346");
  });
});
