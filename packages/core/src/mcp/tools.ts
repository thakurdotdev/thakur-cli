import type { ToolDefinition, ToolContext } from "../tools/definition.ts";
import type { ToolResult } from "../result.ts";
import { HarnessError } from "../result.ts";
import { McpClient } from "./client.ts";
import type { McpClientOptions, McpServerConfig, McpToolDescriptor } from "./client.ts";

/**
 * MCP tool provisioning.
 *
 * Every tool a server advertises becomes a first-class ToolDefinition named
 * `mcp__<server>__<tool>` and flows through the same permission gate,
 * event bus, and rendering pipeline as builtin tools — there is no side
 * door. The server owns input validation (JSON Schema); harness treats the
 * arguments as untrusted pass-through data.
 *
 * Server startup is error-tolerant: one broken server is reported and
 * skipped, the rest of the fleet still connects.
 */

export const MCP_TOOL_PREFIX = "mcp__";

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

/** Join MCP content blocks into the text the model should see. */
function contentToText(result: {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block?.text === "string") {
      parts.push(block.text);
    } else {
      // Non-text blocks (images, resources) are represented honestly.
      parts.push(`[${block?.type ?? "unknown"} content]`);
    }
  }
  return parts.join("\n");
}

function safeJsonSchema(schema: McpToolDescriptor["inputSchema"]): Record<string, unknown> {
  return typeof schema === "object" && schema !== null ? schema : { type: "object" };
}

function buildDefinition(options: {
  server: string;
  descriptor: McpToolDescriptor;
  client: McpClient;
}): ToolDefinition {
  const { server, descriptor, client } = options;
  const name = mcpToolName(server, descriptor.name);
  const description =
    typeof descriptor.description === "string" && descriptor.description.trim().length > 0
      ? `${descriptor.description.trim()} (MCP tool from server "${server}")`
      : `Tool "${descriptor.name}" provided by MCP server "${server}".`;

  return {
    name,
    description,
    // Conservative default: MCP tools may mutate remote state. Interactive
    // mode asks once per tool (session grants cover the rest); config allow
    // rules (including "mcp__<server>__*" wildcards) skip the prompt.
    risk: "write",
    inputJsonSchema: safeJsonSchema(descriptor.inputSchema),
    async execute(rawInput: unknown, context: ToolContext): Promise<ToolResult<unknown>> {
      try {
        const result =
          context.signal !== undefined
            ? await client.callTool(descriptor.name, rawInput, { signal: context.signal })
            : await client.callTool(descriptor.name, rawInput);
        const text = contentToText(result);
        if (result.isError === true) {
          return {
            ok: false,
            error: `MCP tool "${name}" reported failure`,
            ...(text.length > 0 ? { hint: text } : {}),
          };
        }
        return { ok: true, data: text };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error; // cancellation is not a tool failure
        }
        const message = error instanceof Error ? error.message : String(error);
        const stderr = client.stderr();
        return {
          ok: false,
          error: message,
          ...(stderr.length > 0 ? { hint: `server stderr: ${stderr}` } : {}),
        } as ToolResult<unknown>;
      }
    },
  };
}

export interface McpToolsOutcome {
  /** Definitions ready to merge into the tool registry. */
  tools: Record<string, ToolDefinition>;
  /** Live clients with their server names — the caller must close() on shutdown. */
  clients: Array<{ server: string; client: McpClient }>;
  /** Servers that failed to start or answer; the run continues without them. */
  errors: Array<{ server: string; message: string; hint?: string }>;
}

/**
 * Connect to every configured server and collect its tools.
 * Never throws for server-level failures — they are returned in `errors`
 * so callers decide how to present them.
 */
export async function createMcpTools(options: {
  servers: Record<string, McpServerConfig>;
  clientOptions?: McpClientOptions;
}): Promise<McpToolsOutcome> {
  const tools: Record<string, ToolDefinition> = {};
  const clients: McpToolsOutcome["clients"] = [];
  const errors: McpToolsOutcome["errors"] = [];

  for (const [server, config] of Object.entries(options.servers)) {
    const client = new McpClient(config, options.clientOptions);
    try {
      await client.connect();
      const descriptors = await client.listTools();
      clients.push({ server, client });
      for (const descriptor of descriptors) {
        if (typeof descriptor.name !== "string" || descriptor.name.length === 0) {
          continue;
        }
        const definition = buildDefinition({ server, descriptor, client });
        tools[definition.name] = definition;
      }
    } catch (error) {
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        error instanceof HarnessError && error.hint !== undefined ? error.hint : undefined;
      errors.push({ server, message, ...(hint !== undefined ? { hint } : {}) });
    }
  }

  return { tools, clients, errors };
}
