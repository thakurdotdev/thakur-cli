import { createInterface } from "node:readline";
import * as prompts from "@clack/prompts";
import { formatTokens } from "@harness/core";
import { describeApiError } from "@harness/core";
import { lookupProvider } from "@harness/providers";
import { envWithAuthKeys } from "../config/auth.ts";
import { loadConfig } from "../config/loader.ts";
import { loadRecentModels } from "../config/recents.ts";
import { createPlainRenderer } from "../renderers/plain.ts";
import { clackAsk } from "../permissions/interactive.ts";
import { credentialSetupInstructions, hasAnyProviderKey, runConnectFlow } from "../onboarding.ts";
import { filterSlashCommands, slashCommandFill } from "./slash-commands.ts";
import { ChatCore } from "./chat-core.ts";
import type { ChatCoreOptions } from "./chat-core.ts";
import { selectUiMode } from "../tui/transcript.ts";
import { runTuiChat } from "../tui/run-tui.tsx";

/**
 * Interactive chat REPL — the Phase 1 front door, now with two frontends:
 *
 *   tui (default on interactive terminals) — full-screen Ink app
 *   plain                                  — readline loop, works everywhere
 *
 * Both share ChatCore; they differ only in presentation. `harness run`
 * (headless) and the SDK bypass this module entirely.
 *
 * Setup happens INSIDE the frontend, never before it — the claude-code /
 * opencode convention: the TUI boots straight into its connect dialog and
 * then the model picker; the plain REPL opens and points at /connect. Only
 * a non-interactive boot (piped stdin) can't onboard interactively, so it
 * prints instructions instead of starting a REPL nobody can type into.
 */

export type ChatUiMode = "auto" | "tui" | "plain";

export async function runChat(
  options: ChatCoreOptions & { uiFlag?: ChatUiMode | undefined } = {},
): Promise<void> {
  const config = loadConfig({
    flags: options.modelFlag !== undefined ? { model: options.modelFlag } : {},
  });
  const requested = options.uiFlag ?? config.ui ?? "auto";
  const mode = selectUiMode(requested, process.stdout, process.env);

  // Interactive boots always reach a frontend; credentials are added inside
  // it (TUI connect dialog / plain /connect). A piped boot cannot onboard.
  if (
    !hasAnyProviderKey(envWithAuthKeys(process.env, options.homeDir)) &&
    (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
  ) {
    console.error(credentialSetupInstructions());
    process.exitCode = 1;
    return;
  }

  if (requested === "tui" && mode === "plain") {
    // Explicitly requested TUI on a non-interactive stdout — say why.
    console.error("harness: --ui tui needs an interactive terminal — using the plain renderer");
  }
  if (mode === "tui") {
    try {
      await runTuiChat(options);
      return;
    } catch (error) {
      // The TUI must never be a single point of failure: if Ink fails to
      // start on an exotic terminal, degrade to the plain renderer.
      console.error(
        `harness: TUI failed to start (${describeApiError(error)}) — falling back to the plain renderer`,
      );
    }
  }
  await runPlainChat(options);
}

async function runPlainChat(
  options: ChatCoreOptions & { uiFlag?: ChatUiMode | undefined },
): Promise<void> {
  const { uiFlag: _uiFlag, ...coreOptions } = options;
  void _uiFlag;
  const core = await ChatCore.create({ ...coreOptions, onAsk: clackAsk });
  const boot = core.boot();

  prompts.intro("harness — AI coding agent");
  prompts.log.info(
    `model: ${boot.model} · window ~${formatTokens(boot.contextWindow)}${boot.windowAssumed ? " (assumed — set contextWindow in config if you know better)" : ""}`,
  );
  prompts.log.info(`session: ${boot.sessionPath}`);
  if (boot.continued) {
    if (boot.replayedMessages > 0) {
      prompts.log.info(
        `continuing previous session — ${boot.replayedMessages} messages replayed (incomplete tail dropped)`,
      );
    } else {
      prompts.log.warning(
        "--continue: no resumable session found for this directory — starting a fresh one",
      );
    }
  }
  if (boot.yolo) {
    prompts.log.warning(
      "YOLO MODE — every tool call runs without permission prompts (config deny rules still apply). Use only in sandboxed or throwaway environments.",
    );
  }
  prompts.log.message("Type a task and press Enter. /models picks a model. /exit quits.");
  if (!hasAnyProviderKey(envWithAuthKeys(process.env, options.homeDir))) {
    prompts.log.warning(
      "no provider API key yet — run /connect to store one (~/.harness/auth.json), then /models to pick a model",
    );
  }
  for (const mcp of boot.mcp) {
    prompts.log.info(
      `mcp: ${mcp.server} — ${mcp.toolCount} tool(s)${mcp.serverName !== undefined ? ` (${mcp.serverName})` : ""}`,
    );
  }
  for (const error of boot.mcpErrors) {
    prompts.log.warning(`MCP server "${error.server}" unavailable: ${error.message}`);
    if (error.hint !== undefined) {
      prompts.log.info(error.hint);
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "❯ ",
    // Tab completes slash commands — the plain frontend's cousin of the
    // TUI's `/` menu (same registry, same order).
    completer: (line: string) => {
      const token = line.trim();
      if (!token.startsWith("/")) {
        return [[], line];
      }
      const hits = filterSlashCommands(token, "all").map((command) => slashCommandFill(command));
      return [hits, line];
    },
  });

  const detachRenderer = createPlainRenderer({ events: core.events });
  let running = false;
  // EOF on stdin (piped input, Ctrl+D) must end the loop — readline's
  // question callback never fires on close, so an unresolved promise would
  // hang the REPL forever.
  let eof = false;
  let questionResolve: ((line: string) => void) | undefined;
  rl.on("close", () => {
    eof = true;
    questionResolve?.("");
  });

  rl.on("SIGINT", () => {
    if (running) {
      core.abort();
      return;
    }
    rl.close();
    process.exit(0);
  });

  /** Live model listing + clack select — the plain frontend's /models. */
  const pickModelInteractive = async (targetProvider?: string): Promise<void> => {
    const resolvedProvider =
      targetProvider !== undefined
        ? (lookupProvider(targetProvider)?.id ?? targetProvider)
        : undefined;
    const allProviders = core.configuredProviders();
    const providers =
      resolvedProvider !== undefined
        ? allProviders.filter((p) => p.id === resolvedProvider)
        : allProviders;
    if (providers.length === 0) {
      prompts.log.warning(
        resolvedProvider !== undefined
          ? `no key configured for ${resolvedProvider} — run /connect first`
          : "no provider keys configured — run /connect first",
      );
      return;
    }
    const spinner = prompts.spinner();
    spinner.start("fetching model catalogs…");
    const groups = [];
    for (const provider of providers) {
      groups.push(await core.providerModels(provider));
    }
    spinner.stop(
      `fetched ${groups.reduce((sum, group) => sum + group.models.length, 0)} models from ${groups.length} provider(s)`,
    );
    type PickerOption = { value: string; label: string; hint?: string };
    const options: PickerOption[] = [];
    const allRecents = loadRecentModels();
    const recents =
      resolvedProvider !== undefined
        ? allRecents.filter((ref) => ref.startsWith(`${resolvedProvider}:`))
        : allRecents;
    for (const ref of recents.slice(0, 5)) {
      options.push({ value: ref, label: `(recent) ${ref}` });
    }
    for (const group of groups) {
      if (group.error !== undefined) {
        options.push({
          value: `__error:${group.provider.id}`,
          label: `⚠ ${group.provider.name}: ${group.error}`,
        });
        continue;
      }
      for (const model of group.models) {
        const ref = `${group.provider.id}:${model.id}`;
        if (recents.includes(ref)) {
          continue;
        }
        options.push({
          value: ref,
          label: `${model.name}${model.free ? "  ✦ free" : ""}${ref === core.modelRef ? "  (current)" : ""}`,
          hint: [
            group.provider.id,
            model.contextLength !== undefined
              ? `~${formatTokens(model.contextLength)} ctx`
              : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(" · "),
        });
      }
    }
    if (options.length === 0) {
      prompts.log.warning("no models available");
      return;
    }
    const picked = await prompts.select({
      message: "Select model",
      options: options.slice(0, 400),
      maxItems: 15,
    });
    if (prompts.isCancel(picked)) {
      prompts.log.message("cancelled");
      return;
    }
    if (typeof picked !== "string" || picked.startsWith("__error:")) {
      return;
    }
    const outcome = core.switchModelTo(picked);
    if (outcome.kind === "modelSwitched") {
      prompts.log.success(outcome.info ?? "model switched");
    } else if (outcome.kind === "handled" && outcome.info !== undefined) {
      prompts.log.warning(outcome.info);
    }
  };

  try {
    for (;;) {
      if (eof) {
        break;
      }
      const answer: string = await new Promise((resolveQuestion) => {
        questionResolve = (line: string) => {
          questionResolve = undefined;
          resolveQuestion(line);
        };
        rl.question("❯ ", (line) => questionResolve?.(line));
      });
      if (eof) {
        break;
      }
      const input = answer.trim();
      if (input.length === 0) {
        continue;
      }

      if (input === "/models" || input.startsWith("/models ")) {
        const target = input.startsWith("/models ")
          ? input.slice("/models ".length).trim()
          : undefined;
        try {
          await pickModelInteractive(
            target !== undefined && target.length > 0 ? target : undefined,
          );
        } catch (error) {
          prompts.log.error(`model list failed: ${describeApiError(error)}`);
        }
        continue;
      }
      if (input === "/connect") {
        const providerId = await runConnectFlow(
          options.homeDir !== undefined ? { homeDir: options.homeDir } : {},
        );
        if (providerId !== undefined) {
          core.refreshEnv();
          prompts.log.success(`connected ${providerId} — key stored in ~/.harness/auth.json`);
          await pickModelInteractive(providerId);
        }
        continue;
      }

      running = true;
      let quit = false;
      try {
        const outcome = await core.handleInput(input);
        switch (outcome.kind) {
          case "quit": {
            quit = true;
            break;
          }
          case "handled": {
            if (outcome.info !== undefined) {
              prompts.log.message(outcome.info);
            }
            break;
          }
          case "modelSwitched": {
            prompts.log.success(outcome.info ?? "model switched");
            break;
          }
          case "turn": {
            // The renderer already printed the ✗ line for failed runs.
            for (const notice of outcome.result.notices) {
              prompts.log.warning(notice);
            }
            if (!outcome.result.error && outcome.result.summary !== undefined) {
              prompts.log.info(outcome.result.summary);
            }
            break;
          }
        }
      } finally {
        running = false;
      }
      if (quit) {
        break;
      }
    }
  } finally {
    rl.close();
    detachRenderer();
    await core.close();
    prompts.outro(`session saved: ${boot.sessionPath}`);
  }
}
