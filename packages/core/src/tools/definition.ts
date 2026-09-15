import { z } from "zod";
import type { AbsolutePath } from "../brand.ts";
import type { ToolResult } from "../result.ts";
import type { ReadTracker } from "../tracker.ts";
import type { Truncator } from "../truncation.ts";
import type { ToolRisk } from "../permissions/types.ts";

/**
 * Tool abstraction shared by builtin and (later) MCP tools.
 *
 * Every tool enters the system through this definition and passes through the
 * same permission gate, schema validation, and output truncation pipeline —
 * regardless of where it was registered.
 */

export interface ToolContext {
  /** Project root. All file tools are contained within it. */
  readonly cwd: AbsolutePath;
  /** Read-before-edit tracker shared across the run. */
  readonly readTracker: ReadTracker;
  /** Bounds tool output before it reaches the model. */
  readonly truncator: Truncator;
  /** Abort signal for the current run (wired to cancellation). */
  readonly signal?: AbortSignal;
}

/**
 * Uniform, variance-safe tool shape stored in registries.
 *
 * Input schemas come in two flavors — exactly one must be provided:
 *
 *   - `inputSchema`: a zod schema (builtin tools via defineTool). Inputs are
 *     re-validated at the boundary before `execute` runs.
 *   - `inputJsonSchema`: a raw JSON Schema draft-07 object (MCP tools, whose
 *     servers own validation). Inputs are passed through unvalidated — the
 *     authoritative schema check happens server-side.
 */
export interface ToolDefinition {
  readonly name: string;
  /** Model-facing description of what the tool does and when to use it. */
  readonly description: string;
  /** Risk classification used by the permission gate. */
  readonly risk: ToolRisk;
  /** Runtime input schema (zod) — exposed to the model and re-validated here. */
  readonly inputSchema?: z.ZodType<unknown>;
  /** Raw JSON Schema (draft-07) alternative to `inputSchema` — used by MCP tools. */
  readonly inputJsonSchema?: Record<string, unknown>;
  /** Executes against raw (untrusted) input; validates before calling the impl. */
  execute(rawInput: unknown, context: ToolContext): Promise<ToolResult<unknown>>;
}

export interface ToolSpec<S extends z.ZodType, Output> {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: S;
  execute(input: z.output<S>, context: ToolContext): Promise<ToolResult<Output>>;
}

/**
 * Define a tool with zod validation at the boundary: invalid model input
 * becomes an actionable `ToolResult` error instead of an exception.
 */
export function defineTool<S extends z.ZodType, Output>(spec: ToolSpec<S, Output>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    inputSchema: spec.inputSchema as z.ZodType<unknown>,
    async execute(rawInput: unknown, context: ToolContext): Promise<ToolResult<unknown>> {
      const parsed = spec.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return {
          ok: false,
          error: `Invalid input for tool "${spec.name}"`,
          hint: issues,
        };
      }
      return (await spec.execute(parsed.data, context)) as ToolResult<unknown>;
    },
  };
}
