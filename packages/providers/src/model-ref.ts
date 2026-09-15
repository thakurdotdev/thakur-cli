import { HarnessError } from "@harness/core";

/**
 * Robust `--model` parsing: split on the FIRST colon only, so provider ids
 * like `openrouter:anthropic/claude-sonnet-4.5` parse cleanly and model ids
 * containing colons survive intact.
 */

export const DEFAULT_PROVIDER_ID = "openrouter";

export interface ModelRef {
  provider: string;
  id: string;
}

export function parseModelRef(raw: string): ModelRef {
  const input = raw.trim();
  if (input.length === 0) {
    throw new HarnessError(
      "Model id must not be empty",
      'Pass a model id like "openrouter:anthropic/claude-sonnet-4.5".',
    );
  }

  const separator = input.indexOf(":");
  if (separator === -1) {
    return { provider: DEFAULT_PROVIDER_ID, id: input };
  }

  const provider = input.slice(0, separator);
  const id = input.slice(separator + 1);
  if (provider.length === 0 || id.length === 0) {
    throw new HarnessError(
      `Invalid model id: "${raw}"`,
      'Use "provider:model" form, e.g. "openrouter:anthropic/claude-sonnet-4.5".',
    );
  }
  return { provider, id };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.id}`;
}
