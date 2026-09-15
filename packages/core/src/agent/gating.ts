import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import type { HarnessEvent } from "../events/types.ts";
import type { EventBus } from "../events/bus.ts";
import type { PermissionGate } from "../permissions/types.ts";
import type { ToolContext, ToolDefinition } from "../tools/definition.ts";

/**
 * Permission gate wrapper.
 *
 * Converts harness tool definitions into AI SDK tools and wraps every execute
 * with the central permission pipeline:
 *
 *   schema validation (defineTool) -> permission policy -> human approval ->
 *   execution -> events
 *
 * Every mutating operation in the system flows through this one function —
 * there is no side door.
 */
export function toGatedAiTools(options: {
  definitions: Record<string, ToolDefinition>;
  context: ToolContext;
  permissions: PermissionGate;
  events: EventBus<HarnessEvent>;
}): ToolSet {
  const { definitions, context, permissions, events } = options;
  const aiTools: ToolSet = {};

  let nextCallId = 1;

  for (const [name, definition] of Object.entries(definitions)) {
    // Two schema flavors feed the same pipeline: zod (builtin tools) and raw
    // JSON Schema (MCP tools). Exactly one is present per definition.
    const inputSchema =
      definition.inputSchema !== undefined
        ? definition.inputSchema
        : jsonSchema(
            (definition.inputJsonSchema ?? { type: "object" }) as Parameters<typeof jsonSchema>[0],
          );
    aiTools[name] = tool({
      description: definition.description,
      inputSchema,
      execute: async (input: unknown, options: { abortSignal?: AbortSignal }) => {
        const decision = await permissions.decide({
          tool: name,
          risk: definition.risk,
          input,
        });
        if (!decision.allowed) {
          return {
            ok: false,
            error: `Permission denied for tool "${name}"`,
            hint: decision.reason ?? "The user did not approve this action.",
          } as const;
        }

        const callId = `call-${nextCallId++}`;
        events.emit({ type: "tool:call", name, input, id: callId });

        const executionContext: ToolContext =
          options.abortSignal !== undefined ? { ...context, signal: options.abortSignal } : context;

        const startedAt = performance.now();
        const result = await definition.execute(input, executionContext);
        const ms = Math.round(performance.now() - startedAt);

        events.emit({ type: "tool:result", name, result, ms, id: callId });
        return result;
      },
    });
  }

  return aiTools;
}
