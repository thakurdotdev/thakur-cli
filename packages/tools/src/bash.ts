import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { defineTool } from "@harness/core";
import type { ToolResult } from "@harness/core";
import { describeError } from "@harness/core";
import { collectSecrets, redactSecrets } from "@harness/core";

/**
 * Bash tool — arbitrary shell execution.
 *
 * Security posture: commands are treated as arbitrary code execution and
 * always require approval through the permission gate (risk: "execute").
 * Long-running subprocesses are bounded by an explicit timeout and killed
 * as a process group so cancellation cannot leave orphans behind.
 */

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

const STREAM_CAPTURE_CAP_CHARS = 200_000;

export interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  killedBySignal: string | null;
  durationMs: number;
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        return;
      }
      // Negative pid targets the whole process group (spawn is detached).
      process.kill(-child.pid, "SIGKILL");
      return;
    }
    child.kill("SIGKILL");
  } catch {
    // Process may have already exited — nothing to do.
  }
}

export const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command in the project root. Captures stdout, stderr, and exit code.\n\n" +
    "WHEN TO USE: Running builds, tests, linters, git commands, package managers, and other " +
    "CLI tasks. Any operation that needs a shell.\n" +
    "NOT FOR: File reading (use read_file), file search (use grep/glob), directory listing " +
    "(use list_dir) — the dedicated tools are faster, safer, and tracked.\n" +
    "KEY BEHAVIOR:\n" +
    "- Commands run in the project root directory.\n" +
    "- Default timeout: 120 seconds (override with timeout_ms, max 600s).\n" +
    "- Output is capped at ~200k chars. Secrets in environment variables are redacted.\n" +
    "- Commands require user approval (risk: execute).",
  risk: "execute",
  inputSchema: z.object({
    command: z.string().min(1).describe("The shell command to execute."),
    description: z
      .string()
      .optional()
      .describe("Brief explanation of what the command does and why it is being run."),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_BASH_TIMEOUT_MS)
      .optional()
      .describe(
        `Kill the command after this many milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}).`,
      ),
  }),
  async execute(input, context): Promise<ToolResult<BashOutput>> {
    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
    const startedAt = Date.now();
    // Env-secret redaction: `env`/`printenv`/config dumps must not leak
    // credentials into the model context. Collected once per invocation.
    const secrets = collectSecrets(process.env);

    return await new Promise<ToolResult<BashOutput>>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      let child: ChildProcess;
      try {
        // NOTE: Do NOT pass `signal` to spawn — Node's built-in abort sends
        // SIGTERM to the child directly (not the process group), racing with
        // the manual onAbort + killTree below which correctly kills the whole
        // group. Rely solely on the manual listener for group-aware cleanup.
        child = spawn(input.command, {
          shell: true,
          cwd: context.cwd,
          env: process.env,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        resolve({ ok: false, error: `Failed to start command: ${describeError(error)}` });
        return;
      }

      const settle = (result: ToolResult<BashOutput>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
        if (result.ok) {
          result.data.stdout = redactSecrets(result.data.stdout, secrets);
          result.data.stderr = redactSecrets(result.data.stderr, secrets);
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);

      const onAbort = () => {
        killTree(child);
      };
      context.signal?.addEventListener("abort", onAbort, { once: true });

      if (child.stdout !== null) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (stdout.length < STREAM_CAPTURE_CAP_CHARS) {
            stdout += chunk.slice(0, STREAM_CAPTURE_CAP_CHARS - stdout.length);
          }
        });
      }
      if (child.stderr !== null) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < STREAM_CAPTURE_CAP_CHARS) {
            stderr += chunk.slice(0, STREAM_CAPTURE_CAP_CHARS - stderr.length);
          }
        });
      }

      child.on("error", (error) => {
        // Abort-induced kill surfaces as an AbortError here before "close".
        // That is a graceful cancellation, not a tool failure.
        if (context.signal?.aborted === true) {
          settle({
            ok: true,
            data: {
              stdout,
              stderr,
              exitCode: -1,
              timedOut: false,
              killedBySignal: "SIGTERM",
              durationMs: Date.now() - startedAt,
            },
          });
          return;
        }
        settle({ ok: false, error: `Failed to run command: ${describeError(error)}` });
      });

      child.on("close", (code, killedWithSignal) => {
        settle({
          ok: true,
          data: {
            stdout,
            stderr,
            exitCode: code ?? -1,
            timedOut,
            killedBySignal: timedOut || killedWithSignal === null ? null : killedWithSignal,
            durationMs: Date.now() - startedAt,
          },
        });
      });
    });
  },
});
