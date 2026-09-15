import { MODEL_CATALOG, PROVIDERS, availableProviders } from "@harness/providers";
import type { HarnessEnv } from "@harness/providers";
import { formatTokens } from "@harness/core";

/**
 * `harness models` — what can this harness run on, and what is configured?
 *
 * Pure formatter (string in, string out) so the listing is testable without
 * a terminal; the command just prints it.
 */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatModelsOutput(env: HarnessEnv): string {
  const lines: string[] = [];

  // --- Providers ----------------------------------------------------------
  lines.push("Providers");
  const configured = new Set(availableProviders(env).map((provider) => provider.id));
  for (const provider of PROVIDERS) {
    const status = configured.has(provider.id) ? "configured" : "not configured";
    lines.push(`  ${pad(provider.id, 12)}${pad(provider.apiKeyEnv, 32)}${status}`);
  }

  // --- Direct provider ids ------------------------------------------------
  lines.push("");
  lines.push("Direct provider ids (your own key, no middleman):");
  for (const provider of PROVIDERS) {
    if (provider.id === "openrouter") {
      continue; // catalog below already shows OpenRouter refs
    }
    lines.push(`  ${provider.id}: ${provider.exampleModels.join(", ")}`);
  }

  // --- Catalog ------------------------------------------------------------
  lines.push("");
  lines.push("Model catalog (OpenRouter refs; advertised list prices, USD per million tokens):");
  lines.push(
    `  ${pad("model", 46)}${pad("name", 22)}${pad("context", 12)}${pad("in $/M", 8)}out $/M`,
  );
  for (const entry of MODEL_CATALOG) {
    lines.push(
      `  ${pad(`openrouter:${entry.id}`, 46)}${pad(entry.name, 22)}${pad(formatTokens(entry.contextLength), 12)}${pad(entry.inputPricePerMillion.toFixed(2), 8)}${entry.outputPricePerMillion.toFixed(2)}`,
    );
  }
  lines.push("");
  lines.push('Run with: bun run dev -- --model "openrouter:nex-agi/nex-n2.5-pro:free"');

  return lines.join("\n");
}
