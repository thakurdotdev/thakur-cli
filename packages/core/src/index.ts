export { asAbsolutePath, asModelId, asSessionId } from "./brand.ts";
export type { AbsolutePath, Brand, ModelId, SessionId } from "./brand.ts";

export { describeError, HarnessError, isAbortError } from "./result.ts";
export type { ToolResult } from "./result.ts";

export { EventBus } from "./events/bus.ts";
export type { Unsubscribe } from "./events/bus.ts";
export { assertNeverEvent } from "./events/types.ts";
export type { HarnessEvent } from "./events/types.ts";

export { createTruncator } from "./truncation.ts";
export type { Truncator } from "./truncation.ts";

export { estimateMessagesTokens, estimateTokens } from "./tokens.ts";

export { ReadTracker } from "./tracker.ts";
export type { FileStatSnapshot } from "./tracker.ts";

export {
  SessionCompactionLineSchema,
  SessionDoneLineSchema,
  SessionLineSchema,
  SessionMessageLineSchema,
  SessionMetaLineSchema,
  SessionUsageLineSchema,
} from "./session/schema.ts";
export type {
  SessionCompactionLine,
  SessionDoneLine,
  SessionLine,
  SessionMessageLine,
  SessionMetaLine,
  SessionUsageLine,
} from "./session/schema.ts";
export { SessionStore } from "./session/store.ts";
export { findResumableSession, loadResumableSession, resumableMessages } from "./session/resume.ts";
export type { ResumableSession } from "./session/resume.ts";

export { AllowAllGate, InteractiveGate } from "./permissions/types.ts";
export type {
  AskAction,
  AskDecision,
  InteractiveGateOptions,
  PermissionDecision,
  PermissionGate,
  PermissionRequest,
  ToolRisk,
} from "./permissions/types.ts";
export {
  PolicyGate,
  buildPermissionPolicy,
  parsePermissionRule,
  permissionTarget,
  ruleMatches,
} from "./permissions/policy.ts";
export type {
  BuildPermissionPolicyOptions,
  PermissionPolicy,
  PermissionRule,
  PolicyGateOptions,
} from "./permissions/policy.ts";

export { collectSecrets, redactSecrets, REDACTED_MARKER } from "./redact.ts";
export type { CollectSecretsOptions } from "./redact.ts";

export { defineTool } from "./tools/definition.ts";
export type { ToolContext, ToolDefinition, ToolSpec } from "./tools/definition.ts";

export { runAgent } from "./agent/loop.ts";
export {
  COMPACTION_SYSTEM_PROMPT,
  compactMessages,
  DEFAULT_KEEP_RECENT_MESSAGES,
  DEFAULT_TRIGGER_RATIO,
  FALLBACK_CONTEXT_WINDOW,
  RECOVERY_TARGET_RATIO,
  shouldCompact,
} from "./agent/compaction.ts";
export type { CompactionOutcome, CompactionPolicy } from "./agent/compaction.ts";
export { emergencyCompact } from "./agent/emergency.ts";
export { describeApiError, detectContextOverflow, formatTokens } from "./agent/overflow.ts";
export type { ContextOverflow } from "./agent/overflow.ts";
export { DEFAULT_MAX_RETRIES, DEFAULT_MAX_STEPS } from "./agent/types.ts";
export type { RunBudget, RunOptions, RunResult, RunUsage } from "./agent/types.ts";

export { createFrameParser, McpClient, MCP_PROTOCOL_VERSION } from "./mcp/client.ts";
export type { McpClientOptions, McpServerConfig, McpToolDescriptor } from "./mcp/client.ts";
export { createMcpTools, MCP_TOOL_PREFIX, mcpToolName } from "./mcp/tools.ts";
export type { McpToolsOutcome } from "./mcp/tools.ts";

export { buildRepoContext, buildSystemPrompt } from "./context/repo.ts";
export { detectProject, formatProjectContext } from "./context/project-detection.ts";
export type { ProjectContext } from "./context/project-detection.ts";
