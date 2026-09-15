/**
 * Minimal MCP stdio server used by mcp.test.ts.
 *
 * Implements the JSON-RPC surface the harness client speaks: initialize,
 * tools/list, tools/call. Tools:
 *
 *   echo      — replies "echo: <message>"
 *   fail_tool — replies isError:true (server-reported failure)
 *   never     — never replies (client timeout tests)
 *
 * stdout carries ONLY JSON-RPC frames; diagnostics go to stderr.
 */
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the message back",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "fail_tool",
    description: "Always reports failure",
    inputSchema: { type: "object" },
  },
  {
    name: "never",
    description: "Never responds (timeout tests)",
    inputSchema: { type: "object" },
  },
];

function respond(id: unknown, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  if (line.trim().length === 0) {
    return;
  }
  let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`[fixture] unparseable line: ${line}\n`);
    return;
  }
  // Notifications (no id) need no response.
  if (typeof message.id !== "number" && typeof message.id !== "string") {
    return;
  }
  switch (message.method) {
    case "initialize": {
      respond(message.id, {
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo-server", version: "1.0.0" },
        },
      });
      break;
    }
    case "tools/list": {
      respond(message.id, { result: { tools: TOOLS } });
      break;
    }
    case "tools/call": {
      const name = message.params?.["name"];
      const args = (message.params?.["arguments"] ?? {}) as Record<string, unknown>;
      if (name === "echo") {
        respond(message.id, {
          result: { content: [{ type: "text", text: `echo: ${String(args["message"] ?? "")}` }] },
        });
      } else if (name === "fail_tool") {
        respond(message.id, {
          result: {
            content: [
              {
                type: "text",
                text: `intentional failure: ${String(args["reason"] ?? "unspecified")}`,
              },
            ],
            isError: true,
          },
        });
      } else if (name === "never") {
        // Intentionally never responds — client timeout tests use this.
      } else {
        respond(message.id, {
          error: { code: -32602, message: `Unknown tool: ${String(name)}` },
        });
      }
      break;
    }
    default: {
      respond(message.id, {
        error: { code: -32601, message: `Method not found: ${String(message.method)}` },
      });
    }
  }
});
