import { describe, expect, it } from "vitest";
import { fetchProviderModels, sortModelsForDisplay } from "@harness/providers";
import type { ProviderModelInfo } from "@harness/providers";
import { HarnessError } from "@harness/core";

/** Live provider catalogs, normalized + free-badged — all via a fake fetch. */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(responses: Map<string, Response>, capture?: Map<string, Request>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    capture?.set(url, new Request(url, init));
    const response = responses.get(url);
    if (response === undefined) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return response;
  }) as unknown as typeof fetch;
}

describe("fetchProviderModels — openrouter", () => {
  it("normalizes pricing to per-million and badges free models", async () => {
    const responses = new Map<string, Response>([
      [
        "https://openrouter.ai/api/v1/models",
        jsonResponse({
          data: [
            {
              id: "z-ai/glm-4.5-air:free",
              name: "GLM 4.5 Air",
              context_length: 131_072,
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "anthropic/claude-sonnet-4.5",
              name: "Claude Sonnet 4.5",
              context_length: 200_000,
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            { id: "broken", name: "No Pricing", pricing: {} },
          ],
        }),
      ],
    ]);
    const models = await fetchProviderModels({
      providerId: "openrouter",
      fetchImpl: fakeFetch(responses),
    });
    expect(models).toHaveLength(3); // rows without ids dropped; unpriced rows kept
    const free = models.find((model) => model.id === "z-ai/glm-4.5-air:free");
    expect(free?.free).toBe(true);
    expect(free?.inputPricePerMillion).toBe(0);
    expect(free?.contextLength).toBe(131_072);
    const paid = models.find((model) => model.id === "anthropic/claude-sonnet-4.5");
    expect(paid?.free).toBe(false);
    expect(paid?.inputPricePerMillion).toBeCloseTo(3);
    expect(paid?.outputPricePerMillion).toBeCloseTo(15);
    const unpriced = models.find((model) => model.id === "broken");
    expect(unpriced?.free).toBe(false);
    expect(unpriced?.inputPricePerMillion).toBeUndefined();
  });

  it("zero numeric pricing counts as free; :free suffix too — free sorts first", async () => {
    const responses = new Map<string, Response>([
      [
        "https://openrouter.ai/api/v1/models",
        jsonResponse({
          data: [
            {
              id: "vendor/paid-model",
              name: "Paid",
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "vendor/another:free",
              name: "Another",
              pricing: { prompt: "0.5", completion: "1" },
            },
          ],
        }),
      ],
    ]);
    const models = await fetchProviderModels({
      providerId: "openrouter",
      fetchImpl: fakeFetch(responses),
    });
    // Both detected free; sorted by id inside the free tier.
    expect(models[0]?.id).toBe("vendor/another:free");
    expect(models[0]?.free).toBe(true);
    expect(models[1]?.id).toBe("vendor/paid-model");
    expect(models[1]?.free).toBe(true);
  });

  it("sends the Authorization header when a key is given", async () => {
    const capture = new Map<string, Request>();
    const responses = new Map<string, Response>([
      ["https://openrouter.ai/api/v1/models", jsonResponse({ data: [] })],
    ]);
    await fetchProviderModels({
      providerId: "openrouter",
      apiKey: "sk-or-test",
      fetchImpl: fakeFetch(responses, capture),
    });
    const request = capture.get("https://openrouter.ai/api/v1/models");
    expect(request?.headers.get("authorization")).toBe("Bearer sk-or-test");
  });

  it("works without a key (public endpoint)", async () => {
    const capture = new Map<string, Request>();
    const responses = new Map<string, Response>([
      ["https://openrouter.ai/api/v1/models", jsonResponse({ data: [] })],
    ]);
    const models = await fetchProviderModels({
      providerId: "openrouter",
      fetchImpl: fakeFetch(responses, capture),
    });
    expect(models).toEqual([]);
    const request = capture.get("https://openrouter.ai/api/v1/models");
    expect(request?.headers.get("authorization")).toBeNull();
  });
});

describe("fetchProviderModels — direct providers", () => {
  it("openai: bearer auth, passthrough ids", async () => {
    const capture = new Map<string, Request>();
    const responses = new Map<string, Response>([
      [
        "https://api.openai.com/v1/models",
        jsonResponse({ data: [{ id: "gpt-5" }, { id: "gpt-4.1-mini" }] }),
      ],
    ]);
    const models = await fetchProviderModels({
      providerId: "openai",
      apiKey: "sk-oai",
      fetchImpl: fakeFetch(responses, capture),
    });
    expect(capture.get("https://api.openai.com/v1/models")?.headers.get("authorization")).toBe(
      "Bearer sk-oai",
    );
    expect(models.map((model) => model.id)).toEqual(["gpt-4.1-mini", "gpt-5"]); // sorted by id
    expect(models[0]?.free).toBe(false);
  });

  it("anthropic: x-api-key + version headers, display names", async () => {
    const capture = new Map<string, Request>();
    const responses = new Map<string, Response>([
      [
        "https://api.anthropic.com/v1/models",
        jsonResponse({
          data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }],
        }),
      ],
    ]);
    const models = await fetchProviderModels({
      providerId: "anthropic",
      apiKey: "sk-ant",
      fetchImpl: fakeFetch(responses, capture),
    });
    const request = capture.get("https://api.anthropic.com/v1/models");
    expect(request?.headers.get("x-api-key")).toBe("sk-ant");
    expect(request?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(models[0]?.name).toBe("Claude Sonnet 4.5");
  });

  it("google: key query param, models/ prefix stripped, non-generation rows skipped", async () => {
    const capture = new Map<string, Request>();
    const url = "https://generativelanguage.googleapis.com/v1beta/models?key=g-key";
    const responses = new Map<string, Response>([
      [
        url,
        jsonResponse({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              inputTokenLimit: 1_048_576,
              description: "Fast multimodal model",
              supportedGenerationMethods: ["generateContent", "countTokens"],
            },
            {
              name: "models/gemini-1.5-flash",
              displayName: "Gemini 1.5 Flash",
              inputTokenLimit: 1_048_576,
              description: "General multipurpose model",
            },
            {
              name: "models/text-embedding-004",
              description: "Embeddings",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
      ],
    ]);
    const models = await fetchProviderModels({
      providerId: "google",
      apiKey: "g-key",
      fetchImpl: fakeFetch(responses, capture),
    });
    expect(capture.get(url)?.url).toBe(url);
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("gemini-1.5-flash");
    expect(models[1]?.id).toBe("gemini-2.5-pro");
    expect(models[1]?.contextLength).toBe(1_048_576);
  });

  it("missing keys fail with an actionable error", async () => {
    await expect(
      fetchProviderModels({ providerId: "openai", fetchImpl: fakeFetch(new Map()) }),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/);
    await expect(
      fetchProviderModels({ providerId: "google", fetchImpl: fakeFetch(new Map()) }),
    ).rejects.toThrow(/GOOGLE_GENERATIVE_AI_API_KEY is not set/);
  });

  it("unknown provider fails fast", async () => {
    await expect(
      fetchProviderModels({ providerId: "nope", fetchImpl: fakeFetch(new Map()) }),
    ).rejects.toThrow(/Unknown provider/);
  });
});

describe("fetchProviderModels — failure modes", () => {
  it("HTTP errors become HarnessErrors with the status", async () => {
    const responses = new Map<string, Response>([
      ["https://api.openai.com/v1/models", jsonResponse({ error: "bad key" }, 401)],
    ]);
    const promise = fetchProviderModels({
      providerId: "openai",
      apiKey: "sk-bad",
      fetchImpl: fakeFetch(responses),
    });
    await expect(promise).rejects.toBeInstanceOf(HarnessError);
    await expect(
      fetchProviderModels({
        providerId: "openai",
        apiKey: "sk-bad",
        fetchImpl: fakeFetch(responses),
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("network failures keep the message readable", async () => {
    const failing = (async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const error = await fetchProviderModels({
      providerId: "openrouter",
      fetchImpl: failing,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as Error).message).toContain("Could not reach openrouter model list");
    expect((error as HarnessError).hint).toContain("ECONNREFUSED");
  });

  it("timeouts are named, not silent", async () => {
    const slow = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      })) as unknown as typeof fetch;
    const error = await fetchProviderModels({
      providerId: "openrouter",
      timeoutMs: 20,
      fetchImpl: slow,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).hint).toContain("timed out after 0s");
  });
});

describe("sortModelsForDisplay", () => {
  it("free first, then cheapest input, then id", () => {
    const models: ProviderModelInfo[] = [
      {
        id: "c/paid",
        name: "c",
        contextLength: undefined,
        inputPricePerMillion: 3,
        outputPricePerMillion: 15,
        free: false,
      },
      {
        id: "b/paid",
        name: "b",
        contextLength: undefined,
        inputPricePerMillion: 1,
        outputPricePerMillion: 5,
        free: false,
      },
      {
        id: "z/free",
        name: "z",
        contextLength: undefined,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        free: true,
      },
      {
        id: "a/unknown",
        name: "a",
        contextLength: undefined,
        inputPricePerMillion: undefined,
        outputPricePerMillion: undefined,
        free: false,
      },
    ];
    const sorted = sortModelsForDisplay(models);
    expect(sorted.map((model) => model.id)).toEqual(["z/free", "b/paid", "c/paid", "a/unknown"]);
  });
});
