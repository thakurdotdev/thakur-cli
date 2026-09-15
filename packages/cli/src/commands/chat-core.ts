import { join } from "node:path";
import { homedir } from "node:os";
import {
  AllowAllGate,
  createMcpTools,
  describeApiError,
  estimateMessagesTokens,
  EventBus,
  FALLBACK_CONTEXT_WINDOW,
  findResumableSession,
  formatTokens,
  HarnessError,
  InteractiveGate,
  isAbortError,
  PolicyGate,
  ReadTracker,
  resumableMessages,
  runAgent,
  SessionStore,
  asAbsolutePath,
  buildPermissionPolicy,
  createTruncator,
} from "@harness/core";
import type {
  AskDecision,
  CompactionPolicy,
  EventBus as EventBusType,
  HarnessEvent,
  McpClient,
  PermissionGate,
  PermissionRequest,
  ToolContext,
  ToolDefinition,
} from "@harness/core";
import type { LanguageModel, ModelMessage } from "ai";
import {
  availableProviders,
  estimateCostUsd,
  fallbackModelsForProvider,
  fetchProviderModels,
  formatCostUsd,
  lookupModelMetadata,
  parseHarnessEnv,
  parseModelRef,
  providerApiKey,
  resolveModel,
} from "@harness/providers";
import type { HarnessEnv, ProviderInfo, ProviderModelInfo } from "@harness/providers";
import { tools as builtinTools } from "@harness/tools";
import { envWithAuthKeys } from "../config/auth.ts";
import { loadConfig } from "../config/loader.ts";
import { recordRecentModel } from "../config/recents.ts";
import { renderSlashHelp } from "../commands/slash-commands.ts";
import { buildRepoContext, buildSystemPrompt } from "../context/repo.ts";

/**
 * The REPL engine shared by every chat frontend (plain readline, Ink TUI).
 *
 * ChatCore owns everything stateful about an interactive session — model
 * resolution, session store, permission gates, MCP provisioning, message
 * history, compaction calibration — and exposes two verbs: handleInput for
 * slash commands and runTurn for agent work. Frontends only render.
 */

/** Facts a frontend needs once at boot, rendered however it likes. */
export interface ChatBootInfo {
  model: string;
  contextWindow: number;
  /** True when the window came from the fallback, not config or the catalog. */
  windowAssumed: boolean;
  sessionPath: string;
  /** --continue was requested (regardless of whether a session was found). */
  continued: boolean;
  replayedMessages: number;
  yolo: boolean;
  mcp: Array<{ server: string; toolCount: number; serverName?: string }>;
  mcpErrors: Array<{ server: string; message: string; hint?: string }>;
}

export type InputOutcome =
  | { kind: "quit" }
  | { kind: "handled"; info?: string }
  | { kind: "modelSwitched"; info?: string }
  | { kind: "turn"; result: TurnResult };

export interface TurnResult {
  stopReason: string;
  error: boolean;
  /** Formatted totals line ("4 steps · 12k in / 1.2k out · context ~47% ..."). */
  summary?: string;
  /** Context usage after the run, percent of the window (for status bars). */
  contextPct?: number;
  /** Warnings worth surfacing after the run (learned window, interruption). */
  notices: string[];
}

export interface McpProvisioning {
  tools: Record<string, ToolDefinition>;
  clients: Array<{ server: string; client: McpClient }>;
  errors: Array<{ server: string; message: string; hint?: string }>;
}

export interface ChatCoreOptions {
  modelFlag?: string | undefined;
  yolo?: boolean | undefined;
  continueFlag?: boolean | undefined;
  /**
   * Presentation-level permission asks. The plain REPL passes the clack
   * implementation, the TUI passes its dialog bridge; tests pass stubs.
   * When omitted without --yolo, every ask is denied with an actionable
   * reason (safe default, mirrors the SDK's createHarness).
   */
  onAsk?: ((request: PermissionRequest) => AskDecision | Promise<AskDecision>) | undefined;
  /** Test seam — a pre-resolved model object (skips provider resolution). */
  modelOverride?: LanguageModel | undefined;
  /** Test seam — a fixed tool registry (skips MCP provisioning). */
  registryOverride?: Record<string, ToolDefinition> | undefined;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Home directory for the auth store + recent-models file (test seam). */
  homeDir?: string | undefined;
  /** Event bus override (a frontend may bridge it into its own state). */
  events?: EventBusType<HarnessEvent> | undefined;
}

const EMPTY_MCP: McpProvisioning = { tools: {}, clients: [], errors: [] };

export class ChatCore {
  readonly events: EventBusType<HarnessEvent>;

  private readonly config: ReturnType<typeof loadConfig>;
  private env: HarnessEnv;
  private readonly cwd: string;
  private readonly yolo: boolean;
  private readonly homeDir: string;

  /**
   * Resolved lazily — a fresh machine has no credentials yet, and setup
   * happens inside the frontend (never before it). Until a key exists this
   * stays undefined and turns fail with an actionable notice instead of
   * crashing the boot.
   */
  private model: LanguageModel | undefined;
  private currentModelRef: string;
  private contextWindowValue: number;
  private windowAssumedValue: boolean;

  private readonly compaction: CompactionPolicy;
  private observedContextTokens = 0;

  private readonly messages: ModelMessage[] = [];
  private readonly session: SessionStore;
  private readonly registry: Record<string, ToolDefinition>;
  private readonly permissions: PermissionGate;
  private readonly toolContext: ToolContext;
  private readonly mcp: McpProvisioning;

  /** Live model-list cache: providerId -> (fetchedAt, models), per session. */
  private readonly modelListCache = new Map<string, { at: number; models: ProviderModelInfo[] }>();

  private activeController: AbortController | null = null;

  private constructor(
    config: ReturnType<typeof loadConfig>,
    env: HarnessEnv,
    cwd: string,
    yolo: boolean,
    continueRequested: boolean,
    events: EventBusType<HarnessEvent>,
    model: LanguageModel | undefined,
    registry: Record<string, ToolDefinition>,
    mcp: McpProvisioning,
    permissions: PermissionGate,
    toolContext: ToolContext,
    homeDir: string,
  ) {
    this.config = config;
    this.env = env;
    this.cwd = cwd;
    this.yolo = yolo;
    this.homeDir = homeDir;
    this.continueRequested = continueRequested;
    this.events = events;
    this.model = model;
    this.currentModelRef = config.model;
    this.registry = registry;
    this.mcp = mcp;
    this.permissions = permissions;
    this.toolContext = toolContext;

    const catalogWindow = lookupModelMetadata(
      parseModelRef(this.currentModelRef).id,
    )?.contextLength;
    this.windowAssumedValue = config.contextWindow === undefined && catalogWindow === undefined;
    this.contextWindowValue = config.contextWindow ?? catalogWindow ?? FALLBACK_CONTEXT_WINDOW;

    this.compaction = {
      contextWindow: this.contextWindowValue,
      triggerRatio: config.compaction.triggerRatio,
      keepRecentMessages: config.compaction.keepRecentMessages,
    };

    // Session handling: `--continue` reopens the most recent usable transcript
    // in this directory and replays its sanitized history; otherwise a fresh
    // session file is created. Either way new turns are appended to it.
    const sessionsDir = join(cwd, ".harness", "sessions");
    if (continueRequested) {
      const resumed = findResumableSession(sessionsDir, { cwd });
      if (resumed !== undefined) {
        this.session = SessionStore.openExisting(resumed.path);
        this.messages.push(...resumed.messages);
      } else {
        this.session = SessionStore.create(sessionsDir, { model: config.model, cwd });
      }
    } else {
      this.session = SessionStore.create(sessionsDir, { model: config.model, cwd });
    }
  }

  /**
   * Async construction: MCP servers connect before the first turn. One
   * broken server is a warning, not a boot failure.
   */
  static async create(options: ChatCoreOptions = {}): Promise<ChatCore> {
    const config = loadConfig({
      flags: options.modelFlag !== undefined ? { model: options.modelFlag } : {},
    });
    const homeDir = options.homeDir ?? homedir();
    // Credentials come from the process environment with the on-disk auth
    // store (~/.harness/auth.json) as fallback — a launcher-launched binary
    // without shell env vars still boots.
    const env = parseHarnessEnv(options.env ?? envWithAuthKeys(process.env, homeDir));
    const cwd = options.cwd ?? process.cwd();
    const events = options.events ?? new EventBus<HarnessEvent>();
    // Model resolution is deferred: with zero configured keys (fresh machine,
    // launcher-launched exe) this must not throw — the frontend boots first
    // and onboards the user; ensureModel() retries on every turn.
    let model: LanguageModel | undefined = options.modelOverride;
    if (model === undefined) {
      try {
        model = resolveModel(config.model, { env });
      } catch {
        // No credentials yet — picked up lazily after /connect.
      }
    }

    let mcp: McpProvisioning = EMPTY_MCP;
    if (options.registryOverride === undefined && Object.keys(config.mcpServers).length > 0) {
      const outcome = await createMcpTools({ servers: config.mcpServers });
      mcp = {
        tools: outcome.tools,
        clients: outcome.clients.map(({ server, client }) => ({ server, client })),
        errors: outcome.errors.map((error) => ({
          server: error.server,
          message: error.message,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
        })),
      };
    }
    const registry: Record<string, ToolDefinition> = options.registryOverride ?? {
      ...builtinTools,
      ...mcp.tools,
    };

    const baseGate: PermissionGate =
      options.yolo === true
        ? new AllowAllGate()
        : new InteractiveGate({
            autoAllowReads: config.permissions.autoAllowReads,
            onAsk:
              options.onAsk ??
              (() => ({
                action: "deny" as const,
                reason: "no interactive asker configured",
              })),
          });
    // Policy wraps the base gate: deny rules win everywhere (including yolo),
    // allow rules skip prompts, everything else falls through.
    const permissions = new PolicyGate({
      policy: buildPermissionPolicy({
        allow: config.permissions.allow,
        deny: config.permissions.deny,
      }),
      fallback: baseGate,
    });

    const readTracker = new ReadTracker();
    const truncator = createTruncator({ maxChars: config.truncation.toolOutputMaxChars });
    const toolContext: ToolContext = { cwd: asAbsolutePath(cwd), readTracker, truncator };

    const core = new ChatCore(
      config,
      env,
      cwd,
      options.yolo === true,
      options.continueFlag === true,
      events,
      model,
      registry,
      mcp,
      permissions,
      toolContext,
      homeDir,
    );
    return core;
  }

  boot(): ChatBootInfo {
    // Remember this model as recently used if credentials exist for it.
    const currentProvider = parseModelRef(this.currentModelRef).provider;
    if (availableProviders(this.env).some((p) => p.id === currentProvider)) {
      recordRecentModel(this.currentModelRef, this.homeDir);
    }
    return {
      model: this.currentModelRef,
      contextWindow: this.contextWindowValue,
      windowAssumed: this.windowAssumedValue,
      sessionPath: this.session.path,
      continued: this.continueRequested,
      replayedMessages: this.messages.length,
      yolo: this.yolo,
      mcp: this.mcp.clients.map(({ server, client }) => ({
        server,
        toolCount: Object.keys(this.mcp.tools).filter((name) => name.startsWith(`mcp__${server}__`))
          .length,
        ...(client.serverInfo?.name !== undefined ? { serverName: client.serverInfo.name } : {}),
      })),
      mcpErrors: this.mcp.errors.map((error) => ({ ...error })),
    };
  }

  private readonly continueRequested: boolean;

  abort(): void {
    try {
      this.activeController?.abort();
    } catch {
      // Cooperative cancellation: ignore synchronous abort/runtime errors so
      // unhandled DOMExceptions never bubble into frontend callers.
    }
  }

  async close(): Promise<void> {
    for (const { client } of this.mcp.clients) {
      await client.close();
    }
  }

  /** Current model ref, e.g. "openrouter:anthropic/claude-sonnet-4.5". */
  get modelRef(): string {
    return this.currentModelRef;
  }

  /** Current context window in tokens (recalibrated on model switch/overflow). */
  get contextWindow(): number {
    return this.contextWindowValue;
  }

  /** True when the window came from the fallback, not config or the catalog. */
  get windowAssumed(): boolean {
    return this.windowAssumedValue;
  }

  /**
   * Resolve the model on demand. Returns the resolved model on success, or
   * the missing-credential problem so frontends can point at /connect.
   */
  private ensureModel():
    | { ok: true; model: LanguageModel }
    | { ok: false; message: string; hint?: string } {
    if (this.model !== undefined) {
      return { ok: true, model: this.model };
    }
    try {
      this.model = resolveModel(this.config.model, { env: this.env });
      return { ok: true, model: this.model };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        error instanceof HarnessError && error.hint !== undefined ? error.hint : undefined;
      return { ok: false, message, ...(hint !== undefined ? { hint } : {}) };
    }
  }

  /** Public switch used by the model picker frontends. */
  switchModelTo(nextRef: string): InputOutcome {
    return this.switchModel(nextRef);
  }

  /**
   * Re-read credentials (process.env over ~/.harness/auth.json). Called by
   * frontends after a successful /connect so newly stored keys are usable
   * without restarting.
   */
  refreshEnv(): void {
    this.env = parseHarnessEnv(envWithAuthKeys(process.env, this.homeDir));
  }

  /** One provider's live model list (or the error that blocked it). */
  async providerModels(
    provider: ProviderInfo,
  ): Promise<{ provider: ProviderInfo; models: ProviderModelInfo[]; error?: string }> {
    const cached = this.modelListCache.get(provider.id);
    const TTL_MS = 10 * 60 * 1000;
    if (cached !== undefined && Date.now() - cached.at < TTL_MS) {
      return { provider, models: cached.models };
    }
    const apiKey = providerApiKey(provider, this.env);
    try {
      const models = await fetchProviderModels({
        providerId: provider.id,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      const list = models.length > 0 ? models : fallbackModelsForProvider(provider.id);
      this.modelListCache.set(provider.id, { at: Date.now(), models: list });
      return { provider, models: list };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        error instanceof HarnessError && error.hint !== undefined ? error.hint : undefined;
      const fallback = fallbackModelsForProvider(provider.id);
      return {
        provider,
        models: fallback,
        ...(hint !== undefined ? { error: `${message} — ${hint}` } : { error: message }),
      };
    }
  }

  /**
   * Providers usable right now (credentials present), current provider
   * first — the picker's group order.
   */
  configuredProviders(): ProviderInfo[] {
    const available = availableProviders(this.env);
    const currentId = parseModelRef(this.currentModelRef).provider;
    return [...available].sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : 0));
  }

  /** Resolve the context window for a (possibly new) model ref. */
  private resolveWindow(modelRef: string): number {
    return (
      this.config.contextWindow ??
      lookupModelMetadata(parseModelRef(modelRef).id)?.contextLength ??
      FALLBACK_CONTEXT_WINDOW
    );
  }

  async handleInput(input: string): Promise<InputOutcome> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { kind: "handled" };
    }
    if (trimmed === "/exit" || trimmed === "/quit") {
      return { kind: "quit" };
    }
    if (trimmed === "/help") {
      return { kind: "handled", info: renderSlashHelp() };
    }
    if (trimmed === "/model") {
      return {
        kind: "handled",
        info: `current model: ${this.currentModelRef} — run /models to browse live catalogs, or /model <provider:model> (e.g. /model openai:gpt-4.1).`,
      };
    }
    if (trimmed.startsWith("/model ")) {
      return this.switchModel(trimmed.slice("/model ".length).trim());
    }
    const result = await this.runTurn(trimmed);
    return { kind: "turn", result };
  }

  private switchModel(nextRef: string): InputOutcome {
    try {
      const nextModel = resolveModel(nextRef, { env: this.env });
      this.model = nextModel;
      this.currentModelRef = nextRef;
      this.contextWindowValue = this.resolveWindow(nextRef);
      this.windowAssumedValue =
        this.config.contextWindow === undefined &&
        lookupModelMetadata(parseModelRef(nextRef).id)?.contextLength === undefined;
      this.compaction.contextWindow = this.contextWindowValue;
      this.observedContextTokens = 0; // token accounting is per-model
      recordRecentModel(nextRef, this.homeDir);
      this.session.appendModelSwitch(nextRef);
      return {
        kind: "modelSwitched",
        info: `model: ${this.currentModelRef} · window ~${formatTokens(this.contextWindowValue)}${this.config.contextWindow === undefined ? " (assumed)" : ""}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        error instanceof HarnessError && error.hint !== undefined ? error.hint : undefined;
      return {
        kind: "handled",
        info: hint === undefined ? message : `${message} — ${hint}`,
      };
    }
  }

  private async runTurn(task: string): Promise<TurnResult> {
    // Credentials may still be missing (onboarding happens inside the UI).
    // Fail the turn with an actionable message; nothing is appended to the
    // session, so the user's prompt stays editable.
    const ready = this.ensureModel();
    if (!ready.ok) {
      return {
        stopReason: "error",
        error: true,
        notices: [
          `${ready.message}${ready.hint !== undefined ? ` — ${ready.hint}` : ""}`,
          "run /connect to store a provider key, or /models to browse catalogs",
        ],
      };
    }

    const userMessage: ModelMessage = { role: "user", content: task };
    this.messages.push(userMessage);
    this.session.appendMessage(userMessage);

    const controller = new AbortController();
    this.activeController = controller;
    try {
      // Fresh per turn: branch/status/commits change between prompts.
      const repoContext = await buildRepoContext(this.cwd);
      const result = await runAgent({
        model: ready.model,
        system: buildSystemPrompt(this.cwd, repoContext, this.currentModelRef),
        messages: this.messages,
        tools: this.registry,
        permissions: this.permissions,
        events: this.events,
        toolContext: this.toolContext,
        budget: {
          maxSteps: this.config.maxSteps,
          maxRetries: this.config.retries.maxAttempts,
          ...(this.config.maxTotalTokens !== undefined
            ? { maxTotalTokens: this.config.maxTotalTokens }
            : {}),
        },
        compaction: this.compaction,
        ...(this.observedContextTokens > 0
          ? { observedContextTokens: this.observedContextTokens }
          : {}),
        session: this.session,
        signal: controller.signal,
      });

      // Adopt the model's real window if an overflow error revealed it, and
      // remember the provider-counted context size for the next turn.
      const notices: string[] = [];
      if (result.learnedContextWindow !== undefined) {
        this.contextWindowValue = result.learnedContextWindow;
        this.windowAssumedValue = false;
        this.compaction.contextWindow = this.contextWindowValue;
        notices.push(
          `provider reports this model's context window is ${formatTokens(this.contextWindowValue)} tokens — compaction recalibrated`,
        );
      }
      if (
        result.lastInputTokens !== undefined &&
        result.lastInputTokens > this.observedContextTokens
      ) {
        this.observedContextTokens = result.lastInputTokens;
      }

      if (result.stopReason === "error" || result.stopReason === "aborted") {
        // Keep only closed exchanges — the failed or aborted turn's dangling
        // tail would poison the next request. The user can re-ask or continue.
        this.messages.length = 0;
        this.messages.push(...resumableMessages(result.messages));
      } else {
        this.messages.length = 0;
        this.messages.push(...result.messages);
      }

      const modelMeta = lookupModelMetadata(parseModelRef(this.currentModelRef).id);
      const costLabel = formatCostUsd(estimateCostUsd(result.usage, modelMeta));
      // Context usage after the run: prefer provider-reported input tokens
      // (ground truth) over the char-based estimate.
      const contextTokens = Math.max(
        estimateMessagesTokens(this.messages),
        result.lastInputTokens ?? 0,
      );
      const contextPct = Math.min(999, Math.round((contextTokens / this.contextWindowValue) * 100));
      const summary = [
        `${result.steps} ${result.steps === 1 ? "step" : "steps"}`,
        `${formatTokens(result.usage.inputTokens)} in / ${formatTokens(result.usage.outputTokens)} out`,
        `context ~${contextPct}% of ${formatTokens(this.contextWindowValue)}`,
        ...(costLabel !== undefined ? [`~${costLabel}`] : []),
        result.stopReason,
      ].join(" · ");

      return {
        stopReason: result.stopReason,
        error: result.stopReason === "error",
        summary,
        contextPct,
        notices,
      };
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        // Cooperative cancellation: drop the unanswered user turn, carry on.
        this.messages.pop();
        return {
          stopReason: "aborted",
          error: false,
          notices: ["interrupted — partial turn discarded"],
        };
      }
      // Drop the unanswered user turn so the next prompt starts clean.
      this.messages.pop();
      const message = describeApiError(error);
      return { stopReason: "error", error: true, notices: [message] };
    } finally {
      this.activeController = null;
    }
  }
}
