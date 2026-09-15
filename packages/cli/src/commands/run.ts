import * as prompts from "@clack/prompts";
import { formatTokens, HarnessError } from "@harness/core";
import { createHarness, formatContextUsage } from "@harness/sdk";
import type { Harness } from "@harness/sdk";
import {
  estimateCostUsd,
  formatCostUsd,
  lookupModelMetadata,
  parseModelRef,
} from "@harness/providers";
import { createPlainRenderer } from "../renderers/plain.ts";
import { loadConfig } from "../config/loader.ts";

/**
 * Headless run — one prompt, one exit code. The CI/scripting front door.
 *
 * Unlike the REPL there is no human to approve tool calls mid-run: calls not
 * covered by config allow rules are DENIED by default, and --yolo is the
 * explicit escape hatch for sandboxed environments. This mirrors claude
 * code's `-p` mode philosophy.
 */

export type RunFormat = "text" | "json";

/** The final structured result for --format json. */
export interface RunJsonOutput {
  ok: boolean;
  model: string;
  stopReason: string;
  error?: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  contextTokens: number;
  contextWindow: number;
  costUsd?: number;
  text: string;
  sessionPath?: string;
  mcpErrors: Array<{ server: string; message: string; hint?: string }>;
}

export function buildRunJson(input: {
  harness: Harness;
  result: {
    stopReason: string;
    error?: string;
    steps: number;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    lastInputTokens?: number;
    text: string;
  };
  modelRef: string;
}): RunJsonOutput {
  const { harness, result, modelRef } = input;
  const cost = estimateCostUsd(result.usage, lookupModelMetadata(parseModelRef(modelRef).id));
  const contextTokens = Math.max(result.lastInputTokens ?? 0, 0);
  return {
    ok: result.stopReason !== "error",
    model: modelRef,
    stopReason: result.stopReason,
    ...(result.error !== undefined ? { error: result.error } : {}),
    steps: result.steps,
    usage: result.usage,
    contextTokens,
    contextWindow: harness.contextWindow,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    text: result.text,
    ...(harness.sessionPath !== undefined ? { sessionPath: harness.sessionPath } : {}),
    mcpErrors: [...harness.mcpErrors],
  };
}

/** Exit code mapping: 0 success · 1 run error · 130 aborted. */
export function runExitCode(stopReason: string): number {
  if (stopReason === "aborted") {
    return 130;
  }
  return stopReason === "error" ? 1 : 0;
}

/** Read a piped prompt from stdin. Returns "" for interactive TTYs. */
export async function readStdinPrompt(inputStream: {
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
  isTTY?: boolean;
}): Promise<string> {
  if (inputStream.isTTY === true) {
    return "";
  }
  const chunks: string[] = [];
  for await (const chunk of inputStream) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("").trim();
}

export async function runHeadless(options: {
  promptArg?: string | undefined;
  format: RunFormat;
  modelFlag?: string | undefined;
  yolo: boolean;
  continueFlag: boolean;
}): Promise<void> {
  const config = loadConfig({
    flags: options.modelFlag !== undefined ? { model: options.modelFlag } : {},
  });

  const prompt = options.promptArg?.trim() || (await readStdinPrompt(process.stdin));
  if (prompt.length === 0) {
    throw new HarnessError(
      "No prompt provided",
      'Pass the task as an argument: harness run "fix the failing test" — or pipe it: echo "task" | harness run.',
    );
  }

  const harness = await createHarness({
    modelRef: config.model,
    cwd: process.cwd(),
    yolo: options.yolo,
    permissionRules: { allow: config.permissions.allow, deny: config.permissions.deny },
    maxSteps: config.maxSteps,
    ...(config.maxTotalTokens !== undefined ? { maxTotalTokens: config.maxTotalTokens } : {}),
    maxRetries: config.retries.maxAttempts,
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
    compaction: config.compaction,
    truncation: { toolOutputMaxChars: config.truncation.toolOutputMaxChars },
    mcpServers: config.mcpServers,
    session: options.continueFlag ? "continue" : true,
  });

  try {
    for (const error of harness.mcpErrors) {
      prompts.log.warning(`MCP server "${error.server}" unavailable: ${error.message}`);
    }

    if (options.format === "text") {
      const detach = createPlainRenderer({ events: harness.events });
      let result;
      try {
        result = await harness.run(prompt);
      } finally {
        detach();
      }
      const costLabel = formatCostUsd(
        estimateCostUsd(result.usage, lookupModelMetadata(parseModelRef(harness.modelRef).id)),
      );
      console.log(
        [
          `${result.steps} ${result.steps === 1 ? "step" : "steps"}`,
          `${formatTokens(result.usage.inputTokens)} in / ${formatTokens(result.usage.outputTokens)} out`,
          formatContextUsage(harness, result),
          ...(costLabel !== undefined ? [`~${costLabel}`] : []),
          result.stopReason,
        ].join(" · "),
      );
      process.exitCode = runExitCode(result.stopReason);
    } else {
      const result = await harness.run(prompt);
      const json = buildRunJson({ harness, result, modelRef: harness.modelRef });
      console.log(JSON.stringify(json, null, 2));
      process.exitCode = runExitCode(result.stopReason);
    }
  } finally {
    await harness.close();
  }
}
