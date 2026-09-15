import { describe, expect, it } from "vitest";
import { parseHarnessEnv } from "@harness/providers";
import { formatModelsOutput } from "../src/commands/models.ts";

/** `harness models` — the provider/catalog listing. */

describe("formatModelsOutput", () => {
  it("lists every supported provider with its credential status", () => {
    const text = formatModelsOutput(parseHarnessEnv({ OPENROUTER_API_KEY: "sk" }));
    expect(text).toContain("openrouter");
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(text).toContain("configured");
    expect(text).toContain("not configured");
    // openrouter is the only configured provider here — its status line
    // differs from the others.
    const orLine = text.split("\n").find((line) => line.includes("openrouter"));
    expect(orLine).toContain("configured");
    expect(orLine).not.toContain("not configured");
  });

  it("shows direct provider model ids", () => {
    const text = formatModelsOutput(parseHarnessEnv({}));
    expect(text).toContain("openai: gpt-5");
    expect(text).toContain("anthropic: claude-sonnet-4-5");
    expect(text).toContain("google: gemini-2.5-pro");
  });

  it("renders the full catalog with refs, windows, and prices", () => {
    const text = formatModelsOutput(parseHarnessEnv({}));
    expect(text).toContain("openrouter:anthropic/claude-sonnet-4.5");
    expect(text).toContain("Claude Sonnet 4.5");
    expect(text).toContain("200k");
    expect(text).toContain("15.00");
    expect(text).toContain("openrouter:openai/gpt-4.1-mini");
    expect(text).toContain("in $/M");
    expect(text).toContain("out $/M");
  });

  it("ends with a runnable hint", () => {
    const text = formatModelsOutput(parseHarnessEnv({}));
    expect(text).toContain('bun run dev -- --model "openrouter:');
  });
});
