import { render } from "ink";
import { describeApiError } from "@harness/core";
import { lookupProvider } from "@harness/providers";
import { authFilePath, saveProviderKey } from "../config/auth.ts";
import { loadRecentModels } from "../config/recents.ts";
import type { ChatCoreOptions } from "../commands/chat-core.ts";
import { ChatCore } from "../commands/chat-core.ts";
import { TuiBridge } from "./bridge.ts";
import { TuiApp } from "./App.tsx";

/**
 * Ink TUI frontend for the chat REPL. Bridges engine events into React
 * state and permission asks into an in-app dialog; everything session- and
 * model-related lives in ChatCore, exactly as in the plain frontend.
 *
 * UI-owned slash commands (/models, /connect) are intercepted here — they
 * render as in-app modals instead of going through the core.
 *
 * First-run setup is in-app: with zero configured providers the connect
 * dialog auto-opens after boot, and a successful connect flows straight
 * into the model picker. The app never exits just because no key exists.
 */
export async function runTuiChat(options: ChatCoreOptions = {}): Promise<void> {
  const bridge = new TuiBridge();
  const core = await ChatCore.create({
    ...options,
    onAsk: (request) => bridge.askPermission(request),
  });

  const boot = core.boot();
  bridge.setBoot({
    model: boot.model,
    window: boot.contextWindow,
    windowAssumed: boot.windowAssumed,
    sessionPath: boot.sessionPath,
    continued: boot.continued,
    replayedMessages: boot.replayedMessages,
    yolo: boot.yolo,
  });
  if (boot.continued && boot.replayedMessages > 0) {
    bridge.pushInfo(
      `continuing previous session — ${boot.replayedMessages} messages replayed (incomplete tail dropped)`,
    );
  } else if (boot.continued) {
    bridge.pushInfo(
      "--continue: no resumable session found for this directory — starting a fresh one",
    );
  }
  if (boot.yolo) {
    bridge.pushInfo(
      "YOLO MODE — every tool call runs without permission prompts (config deny rules still apply)",
    );
  }
  for (const mcp of boot.mcp) {
    bridge.pushInfo(
      `mcp: ${mcp.server} — ${mcp.toolCount} tool(s)${mcp.serverName !== undefined ? ` (${mcp.serverName})` : ""}`,
    );
  }
  for (const error of boot.mcpErrors) {
    bridge.pushInfo(`MCP server "${error.server}" unavailable: ${error.message}`);
  }

  // Zero credentials -> onboarding happens INSIDE the app (opencode-style):
  // the connect dialog opens over the welcome hero; once a key is saved the
  // model picker takes over, so first-run setup ends on a working model.
  if (core.configuredProviders().length === 0) {
    bridge.openConnect();
  }

  // Engine events drive the transcript. The bridge is the only state writer
  // outside React events, keeping the data flow one-directional.
  const unsubscribe = core.events.onAny((event) => {
    bridge.emit(event);
  });

  // --- model picker flow ------------------------------------------------------

  /** Refresh the footer (ContextRow/Hero) after a model switch. */
  const syncBootModel = (): void => {
    const prev = bridge.getSnapshot().boot;
    if (prev === undefined) {
      return;
    }
    bridge.setBoot({
      ...prev,
      model: core.modelRef,
      window: core.contextWindow,
      windowAssumed: core.windowAssumed,
    });
  };

  const openPicker = (preferredProvider?: string): void => {
    const resolvedProvider =
      preferredProvider !== undefined
        ? (lookupProvider(preferredProvider)?.id ?? preferredProvider)
        : undefined;
    bridge.openPickerLoading(resolvedProvider);
    void (async () => {
      try {
        const providers = core.configuredProviders();
        if (providers.length === 0) {
          bridge.closePicker();
          bridge.pushInfo("no provider keys yet — pick a provider to connect:");
          bridge.openConnect();
          return;
        }
        const groups = [];
        for (const provider of providers) {
          groups.push(await core.providerModels(provider));
        }
        bridge.setPickerReady(
          groups,
          loadRecentModels(options.homeDir),
          core.modelRef,
          resolvedProvider,
        );
      } catch (error) {
        bridge.closePicker();
        bridge.pushInfo(`model list unavailable: ${describeApiError(error)}`);
      }
    })();
  };

  // --- input routing ----------------------------------------------------------

  let busy = false;
  const handleSubmit = (input: string): void => {
    if (input === "/clear") {
      bridge.clearTranscript();
      bridge.pushInfo("transcript cleared — the conversation view is fresh (context unchanged)");
      return;
    }
    if (input === "/models" || input.startsWith("/models ")) {
      const arg = input.startsWith("/models ") ? input.slice("/models ".length).trim() : undefined;
      openPicker(arg !== undefined && arg.length > 0 ? arg : undefined);
      return;
    }
    if (input === "/connect") {
      bridge.openConnect();
      return;
    }
    if (busy) {
      bridge.pushInfo("agent is still running — Esc interrupts the current turn");
      return;
    }
    bridge.pushUser(input);
    busy = true;
    void (async () => {
      try {
        const outcome = await core.handleInput(input);
        if (outcome.kind === "quit") {
          bridge.requestExit();
        } else if (outcome.kind === "handled") {
          if (outcome.info !== undefined) {
            bridge.pushInfo(outcome.info);
          }
        } else if (outcome.kind === "modelSwitched") {
          syncBootModel();
          bridge.pushInfo(outcome.info ?? "model switched");
        } else {
          for (const notice of outcome.result.notices) {
            bridge.pushInfo(notice);
          }
          if (!outcome.result.error && outcome.result.summary !== undefined) {
            bridge.pushSummary(outcome.result.summary);
          }
          if (outcome.result.contextPct !== undefined) {
            bridge.setContextPct(outcome.result.contextPct);
          }
        }
      } finally {
        busy = false;
      }
    })();
  };

  try {
    const instance = render(
      <TuiApp
        bridge={bridge}
        onSubmit={handleSubmit}
        onCancel={() => {
          try {
            core.abort();
          } catch {
            // Guard against abort propagation
          }
        }}
        onExit={() => {
          bridge.requestExit();
        }}
        onPickModel={(ref) => {
          bridge.closePicker();
          const outcome = core.switchModelTo(ref);
          if (outcome.kind === "modelSwitched") {
            syncBootModel();
          }
          bridge.pushInfo(
            outcome.kind === "modelSwitched"
              ? (outcome.info ?? "model switched")
              : ((outcome.kind === "handled" ? outcome.info : undefined) ?? "model not switched"),
          );
        }}
        onConnectSubmit={(providerId, apiKey) => {
          try {
            saveProviderKey(providerId, apiKey, options.homeDir);
            core.refreshEnv();
            bridge.closeConnect();
            bridge.pushInfo(
              `connected ${providerId} — key stored in ${authFilePath(options.homeDir)}`,
            );
            // Continue onboarding: pick a model from the connected provider's
            // catalog (scoped to this provider so other providers don't flood).
            openPicker(providerId);
          } catch (error) {
            bridge.closeConnect();
            bridge.pushInfo(`connect failed: ${describeApiError(error)}`);
          }
        }}
      />,
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
  } finally {
    unsubscribe();
    bridge.denyAllPending("session ended");
    await core.close();
  }
}
