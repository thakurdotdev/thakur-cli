#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { Command } from "commander";
import * as prompts from "@clack/prompts";
import { describeApiError, HarnessError, isAbortError } from "@harness/core";
import { availableProviders, PROVIDERS, parseHarnessEnv, providerApiKey } from "@harness/providers";
import {
  clearProviderKey,
  envWithAuthKeys,
  loadAuthStore,
  saveProviderKey,
} from "./config/auth.ts";
import { runChat } from "./commands/chat.ts";
import { formatModelsOutput } from "./commands/models.ts";
import { runHeadless } from "./commands/run.ts";
import type { RunFormat } from "./commands/run.ts";

const program = new Command();

/**
 * Crash safety net. Nothing in a good CLI prints a raw stack trace by
 * default: unhandled rejections from provider SDK internals surface here as
 * one clean red line. Full dumps require --debug (or HARNESS_DEBUG=1).
 */
function installGlobalErrorHandlers(debug: boolean): void {
  const show = (error: unknown): void => {
    prompts.log.error(`unexpected error: ${describeApiError(error)}`);
    if (debug) {
      console.error(error);
    } else {
      prompts.log.info("run with --debug (or HARNESS_DEBUG=1) for full details");
    }
  };
  process.on("unhandledRejection", (reason) => {
    if (isAbortError(reason)) {
      return;
    }
    show(reason);
  });
  process.on("uncaughtException", (error) => {
    if (isAbortError(error)) {
      return;
    }
    show(error);
    process.exit(1);
  });
}

/**
 * Double-clicked exes close their console the instant the process exits,
 * which reads as "the exe doesn't open". After a fatal error on a bare
 * launch (no arguments) from a real console, wait for Enter so the message
 * stays readable.
 */
async function pauseIfBareLaunch(): Promise<void> {
  if (process.stdin.isTTY !== true || process.argv.length > 2) {
    return;
  }
  await new Promise<void>((resolve) => {
    process.stdout.write("\nPress Enter to close…");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      resolve();
    });
    rl.on("close", () => resolve());
  });
}

/** Shared by the implicit default (bare `harness`) and `harness chat`. */
async function startChat(): Promise<void> {
  const opts = program.opts() as Record<string, unknown>;
  const modelFlag = opts["model"];
  const debug = opts["debug"] === true || process.env["HARNESS_DEBUG"] === "1";
  installGlobalErrorHandlers(debug);
  const ui = opts["ui"];
  await runChat({
    modelFlag: typeof modelFlag === "string" && modelFlag.length > 0 ? modelFlag : undefined,
    yolo: opts["yolo"] === true,
    continueFlag: opts["continue"] === true,
    ...(ui === "tui" || ui === "plain" ? { uiFlag: ui as "tui" | "plain" } : {}),
  });
}

program
  .name("thakurcode")
  .description("thakurcode — a multi-model AI coding agent for your terminal")
  .version("0.1.0")
  .option(
    "-m, --model <model-id>",
    'Model id in "provider:model" form, e.g. "openrouter:nex-agi/nex-n2.5-pro:free" — providers: openrouter, openai, anthropic, google',
  )
  .option(
    "--yolo",
    "Skip every permission prompt (deny rules from config still apply) — for sandboxed/throwaway environments only",
    false,
  )
  .option(
    "-c, --continue",
    "Continue the most recent session in this directory (new turns append to its transcript)",
    false,
  )
  .option(
    "--ui <mode>",
    'Chat frontend: "tui" (Ink full-screen app), "plain" (readline) or "auto" (tui on interactive terminals, plain otherwise)',
    "auto",
  )
  .option("--debug", "Show full error details (stack traces, provider payloads)", false);

// Default command: no subcommand = chat REPL.
program.action(startChat);

program
  .command("chat")
  .description("Start the interactive chat REPL (the default when no command is given)")
  .action(startChat);

program
  .command("models")
  .description("List supported providers, credential status, and the model catalog")
  .action(async () => {
    const env = parseHarnessEnv(envWithAuthKeys(process.env));
    console.log(formatModelsOutput(env));
  });

program
  .command("auth")
  .description(
    "Manage stored provider API keys (~/.harness/auth.json) — keys stored here survive double-clicks and fresh terminals, no shell env needed.",
  )
  .argument("[provider]", "provider id: openrouter, openai, anthropic, google")
  .argument("[key]", "the API key to store")
  .option("--unset <provider>", "remove the stored key for a provider")
  .action(
    async (
      providerArg: string | undefined,
      keyArg: string | undefined,
      cmdOpts: Record<string, unknown>,
    ) => {
      const unset = cmdOpts["unset"];
      if (typeof unset === "string" && unset.length > 0) {
        clearProviderKey(unset);
        prompts.log.success(`removed stored key for ${unset}`);
        return;
      }
      if (providerArg === undefined) {
        const env = parseHarnessEnv(envWithAuthKeys(process.env));
        const store = loadAuthStore();
        const configured = new Set(availableProviders(env).map((entry) => entry.id));
        console.log("Provider credentials (env vars win over ~/.harness/auth.json):");
        for (const provider of PROVIDERS) {
          const source =
            process.env[provider.apiKeyEnv] !== undefined
              ? "env"
              : store.keys[provider.id] !== undefined
                ? "stored"
                : "missing";
          const key = providerApiKey(provider, env);
          const masked =
            key === undefined
              ? "-"
              : key.length <= 12
                ? `${key.slice(0, 3)}…`
                : `${key.slice(0, 8)}…${key.slice(-4)}`;
          console.log(
            `  ${provider.id.padEnd(12)}${provider.apiKeyEnv.padEnd(34)}${configured.has(provider.id) ? "configured" : "missing".padEnd(10)}  (${source}: ${masked})`,
          );
        }
        console.log("\nStore a key:  harness auth openrouter <your-key>");
        return;
      }
      if (keyArg === undefined) {
        throw new HarnessError(
          `Missing API key argument`,
          `Usage: harness auth ${providerArg} <key>  (or "harness auth" for status)`,
        );
      }
      saveProviderKey(providerArg, keyArg);
      prompts.log.success(
        `stored ${providerArg} key in ~/.harness/auth.json — it now works from any terminal or double-click`,
      );
    },
  );

program
  .command("run")
  .description(
    "Run one prompt headless (non-interactive) and exit — for scripts and CI. Tool calls not covered by config allow rules are denied unless --yolo.",
  )
  .argument(
    "[prompt]",
    'The task prompt (read from piped stdin when omitted, e.g. echo "task" | harness run)',
  )
  .option(
    "-f, --format <format>",
    'Output format: "text" (streamed) or "json" (single JSON result)',
    "text",
  )
  .action(async (prompt: string | undefined, cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as Record<string, unknown>;
    const debug = opts["debug"] === true || process.env["HARNESS_DEBUG"] === "1";
    installGlobalErrorHandlers(debug);
    const format = cmdOpts["format"];
    if (format !== "text" && format !== "json") {
      throw new HarnessError(
        `Invalid --format value: "${String(format)}"`,
        'Supported formats: "text" and "json".',
      );
    }
    await runHeadless({
      ...(prompt !== undefined ? { promptArg: prompt } : {}),
      format: format as RunFormat,
      modelFlag:
        typeof opts["model"] === "string" && opts["model"].length > 0 ? opts["model"] : undefined,
      yolo: opts["yolo"] === true,
      continueFlag: opts["continue"] === true,
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof HarnessError) {
    prompts.log.error(error.message);
    if (error.hint !== undefined) {
      prompts.log.info(error.hint);
    }
  } else {
    prompts.log.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
  await pauseIfBareLaunch();
}
