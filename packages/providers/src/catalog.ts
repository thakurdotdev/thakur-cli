import { HarnessError } from "@harness/core";

/**
 * Live model catalog — what the user asked for, OpenCode-style:
 * pick a provider, hit its public models endpoint, show what's actually
 * available today (including which models are free), instead of guessing
 * from a code-versioned table.
 *
 * Every adapter normalizes to one shape; free detection is OpenRouter's
 * `:free` suffix or a zero price for both directions. Failures are
 * actionable HarnessErrors, never raw fetch dumps.
 */

export interface ProviderModelInfo {
  /** Provider-native model id, e.g. "anthropic/claude-sonnet-4.5". */
  readonly id: string;
  /** Human name when the API provides one, else the id. */
  readonly name: string;
  /** Advertised context window in tokens, when the API exposes it. */
  readonly contextLength: number | undefined;
  /** USD per million input tokens, when known. */
  readonly inputPricePerMillion: number | undefined;
  /** USD per million output tokens, when known. */
  readonly outputPricePerMillion: number | undefined;
  /** Zero-cost model (OpenRouter `:free` endpoints, zero listed pricing). */
  readonly free: boolean;
}

export interface FetchProviderModelsOptions {
  readonly providerId: string;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 12_000;

function asFetch(options: FetchProviderModelsOptions): typeof fetch {
  return options.fetchImpl ?? fetch;
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  providerId: string,
  what: string,
  options: FetchProviderModelsOptions,
): Promise<unknown> {
  const doFetch = asFetch(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new HarnessError(
      `Could not reach ${providerId} model list (${what})`,
      `${detail} — check your connection${options.apiKey === undefined ? "" : " and API key"}.`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const snippet = body.length > 0 ? ` — ${body.slice(0, 200)}` : "";
    throw new HarnessError(
      `${providerId} model list failed: HTTP ${response.status} (${what})${snippet}`,
      response.status === 401 || response.status === 403
        ? "The API key was rejected — re-check it with /connect or `harness auth`."
        : undefined,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new HarnessError(
      `${providerId} model list returned malformed JSON (${what})`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function perMillion(perToken: number | undefined): number | undefined {
  return perToken === undefined ? undefined : perToken * 1_000_000;
}

// --- OpenRouter -------------------------------------------------------------

interface OpenRouterModelShape {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly context_length?: unknown;
  readonly pricing?: {
    readonly prompt?: unknown;
    readonly completion?: unknown;
  };
}

function normalizeOpenRouter(payload: unknown): ProviderModelInfo[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) {
    return [];
  }
  const models: ProviderModelInfo[] = [];
  for (const row of rows as OpenRouterModelShape[]) {
    if (typeof row.id !== "string" || row.id.length === 0) {
      continue;
    }
    const promptPerToken = toNumber(row.pricing?.prompt);
    const completionPerToken = toNumber(row.pricing?.completion);
    const inputPerM = perMillion(promptPerToken);
    const outputPerM = perMillion(completionPerToken);
    const free =
      row.id.endsWith(":free") ||
      (promptPerToken === 0 && completionPerToken === 0) ||
      (inputPerM === 0 && outputPerM === 0);
    models.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
      contextLength: toNumber(row.context_length),
      inputPricePerMillion: free ? 0 : inputPerM,
      outputPricePerMillion: free ? 0 : outputPerM,
      free,
    });
  }
  return models;
}

// --- OpenAI -----------------------------------------------------------------

interface OpenAiModelShape {
  readonly id?: unknown;
}

function normalizeOpenAi(payload: unknown): ProviderModelInfo[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) {
    return [];
  }
  const models: ProviderModelInfo[] = [];
  for (const row of rows as OpenAiModelShape[]) {
    if (typeof row.id !== "string" || row.id.length === 0) {
      continue;
    }
    models.push({
      id: row.id,
      name: row.id,
      contextLength: undefined,
      inputPricePerMillion: undefined,
      outputPricePerMillion: undefined,
      free: false,
    });
  }
  return models;
}

// --- Anthropic --------------------------------------------------------------

interface AnthropicModelShape {
  readonly id?: unknown;
  readonly display_name?: unknown;
}

function normalizeAnthropic(payload: unknown): ProviderModelInfo[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) {
    return [];
  }
  const models: ProviderModelInfo[] = [];
  for (const row of rows as AnthropicModelShape[]) {
    if (typeof row.id !== "string" || row.id.length === 0) {
      continue;
    }
    models.push({
      id: row.id,
      name:
        typeof row.display_name === "string" && row.display_name.length > 0
          ? row.display_name
          : row.id,
      contextLength: undefined,
      inputPricePerMillion: undefined,
      outputPricePerMillion: undefined,
      free: false,
    });
  }
  return models;
}

// --- Google -----------------------------------------------------------------

interface GoogleModelShape {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly description?: unknown;
  readonly inputTokenLimit?: unknown;
  readonly supportedGenerationMethods?: unknown;
}

function normalizeGoogle(payload: unknown): ProviderModelInfo[] {
  const rows = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) {
    return [];
  }
  const models: ProviderModelInfo[] = [];
  for (const row of rows as GoogleModelShape[]) {
    const rawName = typeof row.name === "string" ? row.name : "";
    // "models/gemini-2.5-pro" -> "gemini-2.5-pro"; skip non-generation rows.
    const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
    if (id.length === 0) {
      continue;
    }
    const description = typeof row.description === "string" ? row.description : "";
    const methods = Array.isArray(row.supportedGenerationMethods)
      ? row.supportedGenerationMethods.filter((m): m is string => typeof m === "string")
      : [];
    const isGeneration =
      methods.some((m) => m.toLowerCase().includes("generatecontent")) ||
      description.toLowerCase().includes("generatecontent") ||
      id.startsWith("gemini");
    const isEmbedding =
      id.includes("embedding") ||
      (methods.length > 0 && methods.every((m) => m.toLowerCase().includes("embed")));
    if (!isGeneration || isEmbedding) {
      continue;
    }
    models.push({
      id,
      name:
        typeof row.displayName === "string" && row.displayName.length > 0 ? row.displayName : id,
      contextLength: toNumber(row.inputTokenLimit),
      inputPricePerMillion: undefined,
      outputPricePerMillion: undefined,
      free: false,
    });
  }
  return models;
}

/** Curated fallback models when live endpoint is unreachable or returns empty. */
export function fallbackModelsForProvider(providerId: string): ProviderModelInfo[] {
  const defaults = {
    inputPricePerMillion: undefined,
    outputPricePerMillion: undefined,
    free: false,
  };
  switch (providerId) {
    case "google": {
      return [
        { ...defaults, id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1_048_576 },
        { ...defaults, id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextLength: 1_048_576 },
        { ...defaults, id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextLength: 2_097_152 },
        { ...defaults, id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextLength: 1_048_576 },
      ];
    }
    case "openai": {
      return [
        { ...defaults, id: "gpt-5", name: "GPT-5", contextLength: 400_000 },
        { ...defaults, id: "gpt-4.1", name: "GPT-4.1", contextLength: 1_000_000 },
        { ...defaults, id: "gpt-4.1-mini", name: "GPT-4.1 mini", contextLength: 1_000_000 },
        { ...defaults, id: "gpt-4o", name: "GPT-4o", contextLength: 128_000 },
      ];
    }
    case "anthropic": {
      return [
        { ...defaults, id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextLength: 200_000 },
        { ...defaults, id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextLength: 200_000 },
        { ...defaults, id: "claude-opus-4-1", name: "Claude Opus 4.1", contextLength: 200_000 },
      ];
    }
    case "openrouter": {
      return [
        {
          ...defaults,
          id: "nex-agi/nex-n2.5-pro:free",
          name: "Nex-N2.5-Pro (free)",
          contextLength: 262_144,
          free: true,
          inputPricePerMillion: 0,
          outputPricePerMillion: 0,
        },
        {
          ...defaults,
          id: "anthropic/claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          contextLength: 200_000,
        },
        { ...defaults, id: "openai/gpt-4o", name: "GPT-4o", contextLength: 128_000 },
        {
          ...defaults,
          id: "google/gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          contextLength: 1_048_576,
        },
      ];
    }
    default: {
      return [];
    }
  }
}

/** Default API endpoints, overridable via the *_BASE_URL env variables. */
export const PROVIDER_MODELS_ENDPOINTS: Readonly<Record<string, string>> = {
  openrouter: "https://openrouter.ai/api/v1/models",
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
};

/** Sort: free first, then cheaper input price, then id — stable and readable. */
export function sortModelsForDisplay(models: ProviderModelInfo[]): ProviderModelInfo[] {
  return [...models].sort((a, b) => {
    if (a.free !== b.free) {
      return a.free ? -1 : 1;
    }
    const aIn = a.inputPricePerMillion ?? Number.POSITIVE_INFINITY;
    const bIn = b.inputPricePerMillion ?? Number.POSITIVE_INFINITY;
    if (aIn !== bIn) {
      return aIn - bIn;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Fetch the model list for one provider. OpenRouter's list is public (the
 * key only unlocks your account-specific endpoints); the direct providers
 * require the key.
 */
export async function fetchProviderModels(
  options: FetchProviderModelsOptions,
): Promise<ProviderModelInfo[]> {
  const providerId = options.providerId;
  const endpoint = PROVIDER_MODELS_ENDPOINTS[providerId];
  if (endpoint === undefined) {
    throw new HarnessError(
      `Unknown provider "${providerId}"`,
      "Supported providers: openrouter, openai, anthropic, google.",
    );
  }
  const url = options.baseUrl ?? endpoint;

  switch (providerId) {
    case "openrouter": {
      const headers: Record<string, string> =
        options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {};
      const payload = await requestJson(
        url,
        headers,
        providerId,
        "openrouter.ai/api/v1/models",
        options,
      );
      return sortModelsForDisplay(normalizeOpenRouter(payload));
    }
    case "openai": {
      if (options.apiKey === undefined) {
        throw new HarnessError(
          "OPENAI_API_KEY is not set",
          "Run /connect (or `harness auth openai <key>`) to store a key, then /models again.",
        );
      }
      const payload = await requestJson(
        url,
        { authorization: `Bearer ${options.apiKey}` },
        providerId,
        "api.openai.com/v1/models",
        options,
      );
      return sortModelsForDisplay(normalizeOpenAi(payload));
    }
    case "anthropic": {
      if (options.apiKey === undefined) {
        throw new HarnessError(
          "ANTHROPIC_API_KEY is not set",
          "Run /connect (or `harness auth anthropic <key>`) to store a key, then /models again.",
        );
      }
      const payload = await requestJson(
        url,
        { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
        providerId,
        "api.anthropic.com/v1/models",
        options,
      );
      return sortModelsForDisplay(normalizeAnthropic(payload));
    }
    case "google": {
      if (options.apiKey === undefined) {
        throw new HarnessError(
          "GOOGLE_GENERATIVE_AI_API_KEY is not set",
          "Run /connect (or `harness auth google <key>`) to store a key, then /models again.",
        );
      }
      const separator = url.includes("?") ? "&" : "?";
      const payload = await requestJson(
        `${url}${separator}key=${encodeURIComponent(options.apiKey)}`,
        {},
        providerId,
        "generativelanguage.googleapis.com/v1beta/models",
        options,
      );
      return sortModelsForDisplay(normalizeGoogle(payload));
    }
    default: {
      throw new HarnessError(`Unknown provider "${providerId}"`);
    }
  }
}
