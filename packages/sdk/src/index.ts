import { join } from "node:path";
import type { LanguageModel, ModelMessage } from "ai";
import {
  AllowAllGate,
  EventBus,
  FALLBACK_CONTEXT_WINDOW,
  HarnessError,
  PolicyGate,
  ReadTracker,
  SessionStore,
  asAbsolutePath,
  buildPermissionPolicy,
  buildRepoContext,
  buildSystemPrompt,
  createMcpTools,
  createTruncator,
  findResumableSession,
  formatTokens,
  resumableMessages,
  runAgent,
} from "@harness/core";
import type {
  AskDecision,
  CompactionPolicy,
  HarnessEvent,
  McpClientOptions,
  McpServerConfig,
  PermissionDecision,
  PermissionGate,
  PermissionRequest,
  RunResult,
  ToolContext,
  ToolDefinition,
} from "@harness/core";
import {
  lookupModelMetadata,
  parseModelRef,
  parseHarnessEnv,
  resolveModel,
} from "@harness/providers";
import type { HarnessEnv } from "@harness/providers";
import { tools as builtinTools } from "@harness/tools";

/**
 * Programmatic harness — the SDK front door.
 *
 * `createHarness()` performs the same wiring the CLI does (model resolution,
 * builtin + MCP tools, permission policy, compaction policy, session
 * transcript) and exposes it as a single object with one `run()` method.
 * The engine stays presentation-free: callers subscribe to `harness.events`
 * to stream text, tool calls, and errors.
 */

export interface CreateHarnessOptions {
  /** Model reference in "provider:model" form. Defaults to config/env/default model. */
  modelRef?: string;
  /**
   * Direct LanguageModel override (skips provider resolution) — for custom
   * adapters, gateways, and tests. modelRef is still used for labels,
   * context-window lookup, and cost estimates.
   */
  model?: LanguageModel;
  /** Project root the agent operates in. Defaults to process.cwd(). */
  cwd?: string;
  /** Skip every permission prompt (deny rules still apply). Default false. */
  yolo?: boolean;
  /**
   * Callback consulted for calls no policy rule covers. Default: deny with a
   * hint — SDKs must be safe by default (the CLI supplies an interactive one).
   */
  onPermissionAsk?: (request: PermissionRequest) => AskDecision | Promise<AskDecision>;
  /** Auto-allow read-classified tools without consulting onPermissionAsk. Default true. */
  autoAllowReads?: boolean;
  /** Policy rule strings, same syntax as the CLI config. */
  permissionRules?: { allow?: string[]; deny?: string[] };
  maxSteps?: number;
  maxTotalTokens?: number;
  maxRetries?: number;
  /** Overrides the model catalog's context window for compaction math. */
  contextWindow?: number;
  compaction?: { enabled?: boolean; triggerRatio?: number; keepRecentMessages?: number };
  truncation?: { toolOutputMaxChars?: number };
  /** MCP stdio servers; tools appear as mcp__<server>__<tool>. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Startup/call timeouts forwarded to MCP clients. */
  mcpClientOptions?: McpClientOptions;
  /** Session transcript: true (default) = new session, "continue" = resume latest, false = none. */
  session?: boolean | "continue";
  /** Override the system prompt entirely (repo context is still appended). */
  system?: string;
  /** Environment used for model resolution. Defaults to process.env. */
  env?: HarnessEnv;
}

export interface HarnessRunResult extends RunResult {
  /** The assistant's text output for this run (deltas joined in order). */
  text: string;
}

export interface Harness {
  /** Subscribe for streaming events (text deltas, tool calls, errors, …). */
  readonly events: EventBus<HarnessEvent>;
  readonly modelRef: string;
  readonly contextWindow: number;
  readonly sessionPath: string | undefined;
  /** Names of every registered tool (builtin + MCP). */
  readonly toolNames: readonly string[];
  /** Servers that failed to connect — the run continues without them. */
  readonly mcpErrors: ReadonlyArray<{ server: string; message: string; hint?: string }>;
  /** Run one user prompt to completion. */
  run(prompt: string, options?: { signal?: AbortSignal }): Promise<HarnessRunResult>;
  /** Swap the model mid-conversation (window recalibrated, telemetry reset). */
  switchModel(ref: string): Promise<void>;
  /** Shut down MCP servers. Idempotent; call when done. */
  close(): Promise<void>;
}

/** Safe-by-default ask callback for SDK consumers. */
function denyByDefault(): AskDecision {
  return {
    action: "deny",
    reason:
      "no permission handler configured — pass onPermissionAsk, allow rules, or yolo:true (sandboxed environments only)",
  };
}

export async function createHarness(options: CreateHarnessOptions = {}): Promise<Harness> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? parseHarnessEnv(process.env);

  let modelRef = options.modelRef ?? "openrouter:nex-agi/nex-n2.5-pro:free";
  let model: LanguageModel = options.model ?? resolveModel(modelRef, { env });

  const resolveWindow = (ref: string): number => {
    return (
      options.contextWindow ??
      lookupModelMetadata(parseModelRef(ref).id)?.contextLength ??
      FALLBACK_CONTEXT_WINDOW
    );
  };
  let contextWindow = resolveWindow(modelRef);

  const events = new EventBus<HarnessEvent>();

  // --- MCP provisioning (before the first run; error-tolerant per server).
  const mcpOutcome = await createMcpTools({
    servers: options.mcpServers ?? {},
    ...(options.mcpClientOptions !== undefined ? { clientOptions: options.mcpClientOptions } : {}),
  });

  const registeredTools: Record<string, ToolDefinition> = { ...builtinTools, ...mcpOutcome.tools };

  // --- Permissions: policy wraps the caller-provided (or denying) gate.
  const baseGate: PermissionGate =
    options.yolo === true
      ? new AllowAllGate()
      : {
          async decide(request: PermissionRequest): Promise<PermissionDecision> {
            const answer = await (options.onPermissionAsk ?? denyByDefault)(request);
            return answer.action === "allow" || answer.action === "always"
              ? { allowed: true }
              : { allowed: false, reason: answer.reason ?? "declined" };
          },
        };
  const permissions: PermissionGate = new PolicyGate({
    policy: buildPermissionPolicy({
      allow: options.permissionRules?.allow ?? [],
      deny: options.permissionRules?.deny ?? [],
    }),
    fallback: baseGate,
  });

  // --- Session persistence.
  const sessionsDir = join(cwd, ".harness", "sessions");
  const messages: ModelMessage[] = [];
  let session: SessionStore | undefined;
  let sessionPath: string | undefined;
  if (options.session !== false) {
    if (options.session === "continue") {
      const resumed = findResumableSession(sessionsDir, { cwd });
      if (resumed !== undefined) {
        session = SessionStore.openExisting(resumed.path);
        messages.push(...resumed.messages);
      } else {
        session = SessionStore.create(sessionsDir, { model: modelRef, cwd });
      }
    } else {
      session = SessionStore.create(sessionsDir, { model: modelRef, cwd });
    }
    sessionPath = session.path;
  }

  const readTracker = new ReadTracker();
  const truncator = createTruncator({
    maxChars: options.truncation?.toolOutputMaxChars ?? 30_000,
  });
  const toolContext: ToolContext = {
    cwd: asAbsolutePath(cwd),
    readTracker,
    truncator,
  };

  const compactionEnabled = options.compaction?.enabled ?? true;
  const compaction: CompactionPolicy | undefined = compactionEnabled
    ? {
        contextWindow,
        triggerRatio: options.compaction?.triggerRatio ?? 0.8,
        keepRecentMessages: options.compaction?.keepRecentMessages ?? 6,
      }
    : undefined;

  // Provider-reported context size from the previous run — ground truth that
  // beats the char-based estimator for compaction decisions.
  let observedContextTokens = 0;

  async function run(
    prompt: string,
    runOptions: { signal?: AbortSignal } = {},
  ): Promise<HarnessRunResult> {
    if (prompt.trim().length === 0) {
      throw new HarnessError("Prompt is empty", "Pass a non-empty task string to harness.run().");
    }

    const userMessage: ModelMessage = { role: "user", content: prompt };
    messages.push(userMessage);
    session?.appendMessage(userMessage);

    // Capture the assistant's text for this run while the renderer (if any)
    // does its own streaming.
    let text = "";
    const captureText = events.onAny((event) => {
      if (event.type === "text:delta") {
        text += event.text;
      }
    });

    try {
      const repoContext = await buildRepoContext(cwd);
      const result = await runAgent({
        model,
        system: options.system ?? buildSystemPrompt(cwd, repoContext, modelRef),
        messages,
        tools: registeredTools,
        permissions,
        events,
        toolContext,
        budget: {
          maxSteps: options.maxSteps ?? 25,
          maxRetries: options.maxRetries ?? 3,
          ...(options.maxTotalTokens !== undefined
            ? { maxTotalTokens: options.maxTotalTokens }
            : {}),
        },
        ...(compaction !== undefined ? { compaction } : {}),
        ...(observedContextTokens > 0 ? { observedContextTokens } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(runOptions.signal !== undefined ? { signal: runOptions.signal } : {}),
      });

      if (result.learnedContextWindow !== undefined) {
        contextWindow = result.learnedContextWindow;
        if (compaction !== undefined) {
          compaction.contextWindow = contextWindow;
        }
      }
      if (result.lastInputTokens !== undefined && result.lastInputTokens > observedContextTokens) {
        observedContextTokens = result.lastInputTokens;
      }

      if (result.stopReason === "error") {
        // Keep only closed exchanges — a failed turn's dangling tail would
        // poison the next request.
        messages.length = 0;
        messages.push(...resumableMessages(result.messages));
      } else {
        messages.length = 0;
        messages.push(...result.messages);
      }

      return { ...result, text };
    } catch (error) {
      // Drop the unanswered user turn so the next run starts clean.
      messages.pop();
      throw error;
    } finally {
      captureText();
    }
  }

  return {
    events,
    get modelRef(): string {
      return modelRef;
    },
    get contextWindow(): number {
      return contextWindow;
    },
    get sessionPath(): string | undefined {
      return sessionPath;
    },
    get toolNames(): readonly string[] {
      return Object.keys(registeredTools);
    },
    get mcpErrors(): ReadonlyArray<{ server: string; message: string; hint?: string }> {
      return mcpOutcome.errors;
    },
    run,
    async switchModel(ref: string): Promise<void> {
      model = resolveModel(ref, { env });
      modelRef = ref;
      contextWindow = resolveWindow(ref);
      if (compaction !== undefined) {
        compaction.contextWindow = contextWindow;
      }
      observedContextTokens = 0; // token accounting is per-model
    },
    async close(): Promise<void> {
      for (const { client } of mcpOutcome.clients) {
        await client.close();
      }
    },
  };
}

/** Human-ready context usage line, e.g. "context ~47% of 262k". */
export function formatContextUsage(harness: Harness, result: RunResult): string {
  const pct = Math.min(
    999,
    Math.round((Math.max(result.lastInputTokens ?? 0, 0) / harness.contextWindow) * 100),
  );
  return `context ~${pct}% of ${formatTokens(harness.contextWindow)}`;
}
