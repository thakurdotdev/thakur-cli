import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { HarnessError } from "../result.ts";

/**
 * Minimal Model Context Protocol (MCP) stdio client — zero dependencies.
 *
 * Implements the subset of the MCP spec a coding agent needs:
 *
 *   initialize handshake -> tools/list -> tools/call -> shutdown
 *
 * over the stdio transport: newline-delimited JSON-RPC 2.0 on the child
 * process's stdin/stdout. Notifications and server->client requests are
 * ignored (no sampling, no roots, no elicitation).
 *
 * Why hand-rolled: the official SDK drags in zod@3 (conflicts with our zod 4
 * pipeline) for schema parsing we do not need — the wire format is plain
 * JSON-RPC and our ToolDefinition boundary already treats MCP input as
 * server-validated.
 */

/** Latest protocol version this client speaks. Servers may downgrade. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 1_500;
const STDERR_TAIL_CHARS = 2_000;

/** One configured MCP server (from config `mcpServers` or SDK options). */
export interface McpServerConfig {
  /** Executable to launch, e.g. "npx", "bun", "/usr/local/bin/my-server". */
  command: string;
  /** Command-line arguments. */
  args?: string[];
  /** Extra environment variables layered over a minimal inherited base. */
  env?: Record<string, string>;
}

/** A tool advertised by a server via tools/list. */
export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  /** JSON Schema (draft-07) for the tool's arguments. May be absent. */
  inputSchema?: Record<string, unknown> | undefined;
}

export interface McpClientOptions {
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Line-oriented JSON-RPC frame parser. Feed it raw stdout chunks, it emits
 * parsed messages. Exported for unit tests.
 */
export function createFrameParser(onMessage: (message: unknown) => void): {
  push: (chunk: string) => void;
} {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) {
          continue;
        }
        try {
          onMessage(JSON.parse(line));
        } catch {
          // Malformed line — skip it. Servers that emit non-JSON noise on
          // stdout must not crash the client; stderr is the diagnostic
          // channel and it is captured separately.
        }
      }
    },
  };
}

function isResponseMessage(
  message: unknown,
): message is { id: number | string } & Record<string, unknown> {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    (typeof (message as Record<string, unknown>)["id"] === "number" ||
      typeof (message as Record<string, unknown>)["id"] === "string")
  );
}

/** Env base for MCP servers: small allowlist, config env layered on top. */
function serverEnv(config: McpServerConfig): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC"]) {
    const value = process.env[key];
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return { ...base, ...config.env };
}

/**
 * Windows cannot exec `.cmd`/`.bat` shims without a shell (Node 18+ policy).
 * Wrap those commands in `cmd /c` automatically; everything else execs direct.
 */
function spawnArgs(config: McpServerConfig): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(config.command)) {
    return {
      command: process.env["COMSPEC"] ?? "cmd.exe",
      args: ["/c", config.command, ...(config.args ?? [])],
    };
  }
  return { command: config.command, args: config.args ?? [] };
}

export class McpClient {
  private readonly config: McpServerConfig;
  private readonly options: McpClientOptions;
  private process: ChildProcess | undefined;
  private parser = createFrameParser(() => {});
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;
  private exitPromise: Promise<number | null> | undefined;
  /** Protocol version the server actually negotiated. */
  serverProtocolVersion: string | undefined;
  /** Server-reported identity from the initialize response. */
  serverInfo: { name?: string; version?: string } | undefined;

  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    this.config = config;
    this.options = options;
  }

  /** Launch the server process and complete the initialize handshake. */
  async connect(): Promise<void> {
    if (this.process !== undefined) {
      return;
    }
    const { command, args } = spawnArgs(this.config);
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: serverEnv(this.config),
        windowsHide: true,
      });
    } catch (error) {
      throw new HarnessError(
        `MCP server "${this.config.command}" failed to start`,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.process = child;
    this.exitPromise = new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => resolveExit(code));
      child.once("error", () => resolveExit(null));
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    child.stdout?.setEncoding("utf8");
    this.parser = createFrameParser((message) => this.handleMessage(message));
    child.stdout?.on("data", (chunk: string) => this.parser.push(chunk));

    const earlyExit = this.exitPromise.then((code) => {
      throw new HarnessError(
        `MCP server "${this.config.command}" exited before responding (code ${code ?? "unknown"})`,
        this.stderrTail.trim().length > 0 ? `server stderr: ${this.stderrTail.trim()}` : undefined,
      );
    });

    try {
      const result = (await Promise.race([
        this.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "harness", version: "0.1.0" },
        }),
        earlyExit,
      ])) as
        | {
            protocolVersion?: string;
            serverInfo?: { name?: string; version?: string };
          }
        | undefined;
      this.serverProtocolVersion = result?.protocolVersion;
      this.serverInfo = result?.serverInfo;
    } catch (error) {
      await this.close();
      throw error;
    }

    // Handshake completion notification — no response expected.
    this.notify("notifications/initialized", {});
  }

  /** Advertised tools. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as
      | { tools?: McpToolDescriptor[] }
      | undefined;
    return Array.isArray(result?.tools) ? (result?.tools as McpToolDescriptor[]) : [];
  }

  /**
   * Call a tool on the server. Returns the raw MCP result envelope
   * ({ content: [...], isError? }) — callers convert to ToolResult.
   */
  async callTool(
    name: string,
    args: unknown,
    context: { signal?: AbortSignal } = {},
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }> {
    return (await this.request(
      "tools/call",
      { name, ...(args !== undefined && args !== null ? { arguments: args } : {}) },
      this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      context.signal,
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  }

  /** Terminate the server process. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const child = this.process;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        this.exitPromise ?? Promise.resolve(null),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CLOSE_GRACE_MS)),
      ]);
      if (exited === "timeout") {
        child.kill("SIGKILL");
      }
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new HarnessError(`MCP server "${this.config.command}" closed`));
      this.pending.delete(id);
    }
    this.process = undefined;
  }

  /** Diagnostics tail from the server's stderr (for error hints). */
  stderr(): string {
    return this.stderrTail.trim();
  }

  private handleMessage(message: unknown): void {
    if (!isResponseMessage(message)) {
      // Notifications and server->client requests are out of scope.
      return;
    }
    const id = message.id;
    const entry = this.pending.get(id as number);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(id as number);
    clearTimeout(entry.timer);
    if (typeof message["error"] === "object" && message["error"] !== null) {
      const err = message["error"] as { message?: string; code?: number };
      entry.reject(
        new HarnessError(
          `MCP server error${typeof err.code === "number" ? ` ${err.code}` : ""}: ${err.message ?? "unknown error"}`,
        ),
      );
      return;
    }
    entry.resolve(message["result"]);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const proc = this.process;
    const stdin = proc?.stdin;
    if (
      this.closed ||
      proc === undefined ||
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed
    ) {
      return Promise.reject(new HarnessError(`MCP server "${this.config.command}" is not running`));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HarnessError(
            `MCP server "${this.config.command}" timed out after ${Math.round(timeoutMs / 1000)}s on "${method}"`,
            "Check that the server command is correct and responsive, or raise the timeout in your configuration.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (signal !== undefined) {
        signal.addEventListener(
          "abort",
          () => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            }
          },
          { once: true },
        );
      }
      stdin.write(frame, (error) => {
        if (error !== undefined && error !== null) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(
            new HarnessError(
              `MCP server "${this.config.command}" rejected input`,
              this.stderr().length > 0 ? `server stderr: ${this.stderr()}` : undefined,
            ),
          );
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const proc = this.process;
    const stdin = proc?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) {
      return;
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, () => {});
  }
}
