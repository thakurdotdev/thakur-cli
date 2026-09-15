import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HarnessError,
  McpClient,
  MCP_PROTOCOL_VERSION,
  ReadTracker,
  asAbsolutePath,
  createFrameParser,
  createMcpTools,
  createTruncator,
  mcpToolName,
} from "@harness/core";
import type { ToolContext } from "@harness/core";

/**
 * MCP stdio client + tool provisioning tests.
 * Integration tests spawn a real fixture server via the bun runtime and are
 * skipped when no bun binary is available (same pattern as grep tests).
 */

const bunBinary = process.execPath.includes("bun") ? process.execPath : "bun";
const hasBun = spawnSync(bunBinary, ["--version"], { timeout: 15_000 }).status === 0;
const fixtureServer = fileURLToPath(new URL("./fixtures/mcp-echo-server.ts", import.meta.url));

const fixtureConfig = {
  command: bunBinary,
  args: ["run", fixtureServer],
};

function makeToolContext(): ToolContext {
  return {
    cwd: asAbsolutePath(process.cwd()),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 1_000 }),
  };
}

describe("createFrameParser", () => {
  it("parses a single JSON line", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((message) => seen.push(message));
    parser.push('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("reassembles frames split across pushes", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((message) => seen.push(message));
    parser.push('{"jsonrpc":"2.0",');
    parser.push('"id":7,"res');
    parser.push('ult":{}}\n');
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  });

  it("skips empty and malformed lines, tolerates CRLF", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((message) => seen.push(message));
    parser.push('\r\nnot json\n{"jsonrpc":"2.0","id":2,"result":1}\r\n{broken\n');
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 2, result: 1 }]);
  });
});

describe("McpClient", () => {
  describe.skipIf(!hasBun)("against the fixture server", () => {
    it("completes the initialize handshake and reports server info", async () => {
      const client = new McpClient(fixtureConfig);
      try {
        await client.connect();
        expect(client.serverProtocolVersion).toBe(MCP_PROTOCOL_VERSION);
        expect(client.serverInfo).toMatchObject({ name: "echo-server" });
      } finally {
        await client.close();
      }
    });

    it("lists advertised tools with JSON Schemas", async () => {
      const client = new McpClient(fixtureConfig);
      try {
        await client.connect();
        const tools = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail_tool", "never"]);
        const echo = tools[0]!;
        expect(echo.inputSchema).toMatchObject({ type: "object" });
      } finally {
        await client.close();
      }
    });

    it("calls a tool and returns the content envelope", async () => {
      const client = new McpClient(fixtureConfig);
      try {
        await client.connect();
        const result = await client.callTool("echo", { message: "hi" });
        expect(result.content?.[0]?.text).toBe("echo: hi");
        expect(result.isError).toBeUndefined();
      } finally {
        await client.close();
      }
    });

    it("surfaces server-reported JSON-RPC errors", async () => {
      const client = new McpClient(fixtureConfig);
      try {
        await client.connect();
        await expect(client.callTool("missing_tool", {})).rejects.toThrow(HarnessError);
        await expect(client.callTool("missing_tool", {})).rejects.toThrow(/-32602/);
      } finally {
        await client.close();
      }
    });

    it("rejects with a timeout when the server never answers", async () => {
      const client = new McpClient(fixtureConfig, { callTimeoutMs: 400 });
      try {
        await client.connect();
        await expect(client.callTool("never", {})).rejects.toThrow(
          /timed out .*400ms|timed out .*0s|timed out/,
        );
      } finally {
        await client.close();
      }
    });

    it("close() terminates the server process and rejects later calls", async () => {
      const client = new McpClient(fixtureConfig);
      await client.connect();
      await client.close();
      await expect(client.callTool("echo", {})).rejects.toThrow(/not running/);
      await client.close(); // idempotent
    });

    it("rejects connect() for a command that cannot start", async () => {
      const client = new McpClient({
        command: "harness-definitely-not-a-command-xyz",
        args: ["--nope"],
      });
      await expect(client.connect()).rejects.toThrow(/harness-definitely-not-a-command-xyz/);
    });
  });
});

describe("createMcpTools", () => {
  describe.skipIf(!hasBun)("against the fixture server", () => {
    it("registers tools under mcp__<server>__<tool> and executes through ToolDefinition", async () => {
      const outcome = await createMcpTools({ servers: { echo: fixtureConfig } });
      try {
        expect(outcome.errors).toEqual([]);
        expect(outcome.clients).toHaveLength(1);
        const names = Object.keys(outcome.tools);
        expect(names).toContain(mcpToolName("echo", "echo"));
        expect(names).toContain(mcpToolName("echo", "fail_tool"));

        const definition = outcome.tools[mcpToolName("echo", "echo")]!;
        expect(definition.name).toBe("mcp__echo__echo");
        expect(definition.risk).toBe("write");
        expect(definition.description).toContain('MCP tool from server "echo"');
        expect(definition.inputSchema).toBeUndefined();
        expect(definition.inputJsonSchema).toMatchObject({ type: "object" });

        const result = await definition.execute({ message: "world" }, makeToolContext());
        expect(result).toMatchObject({ ok: true, data: "echo: world" });
      } finally {
        for (const { client } of outcome.clients) {
          await client.close();
        }
      }
    });

    it("converts isError results into ToolResult failures", async () => {
      const outcome = await createMcpTools({ servers: { echo: fixtureConfig } });
      try {
        const definition = outcome.tools[mcpToolName("echo", "fail_tool")]!;
        const result = await definition.execute({ reason: "testing" }, makeToolContext());
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("reported failure");
          expect(result.hint).toContain("intentional failure: testing");
        }
      } finally {
        for (const { client } of outcome.clients) {
          await client.close();
        }
      }
    });

    it("tolerates a broken server: error recorded, healthy server still registered", async () => {
      const outcome = await createMcpTools({
        servers: {
          broken: { command: "harness-definitely-not-a-command-xyz" },
          echo: fixtureConfig,
        },
      });
      try {
        expect(outcome.errors).toHaveLength(1);
        expect(outcome.errors[0]?.server).toBe("broken");
        expect(Object.keys(outcome.tools)).toContain(mcpToolName("echo", "echo"));
      } finally {
        for (const { client } of outcome.clients) {
          await client.close();
        }
      }
    });
  });
});
