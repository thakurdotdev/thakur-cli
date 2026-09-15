import { z } from "zod";
import type { McpServerConfig } from "@harness/core";

/**
 * Layered configuration (zod-validated at every layer):
 *
 *   defaults <- ~/.harness/config.json <- .harness.json <- environment <- CLI flags
 */

export const ConfigSchema = z.object({
  model: z.string().min(1).optional(),
  // Chat frontend: "auto" picks the Ink TUI on interactive terminals and the
  // plain renderer everywhere else (pipes, CI, dumb terms).
  ui: z.enum(["auto", "tui", "plain"]).optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
  permissions: z
    .object({
      autoAllowReads: z.boolean().optional(),
      // Rule strings ("bash", "write_file", "bash:npm *") — syntax is
      // validated against core's parser in loadConfig so failures name the
      // exact rule instead of failing later at gate time.
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  truncation: z
    .object({
      toolOutputMaxChars: z.number().int().min(1_000).max(1_000_000).optional(),
    })
    .optional(),
  // Hard cap on cumulative input+output tokens per run. Unset = unlimited;
  // the loop still respects maxSteps and the model's context window.
  maxTotalTokens: z.number().int().min(1_000).optional(),
  // Overrides the model catalog's context length for budget/compaction math
  // (useful for custom endpoints with different real limits).
  contextWindow: z.number().int().min(1_000).optional(),
  compaction: z
    .object({
      enabled: z.boolean().optional(),
      triggerRatio: z.number().min(0.05).max(1).optional(),
      keepRecentMessages: z.number().int().min(2).max(50).optional(),
    })
    .optional(),
  retries: z
    .object({
      // Transient-error retries (rate limits, 5xx, network) per model call.
      maxAttempts: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
  // MCP (Model Context Protocol) stdio servers. Every tool a server
  // advertises becomes a gated tool named mcp__<server>__<tool>.
  mcpServers: z
    .record(
      z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9_-]+$/, "server names may only contain letters, digits, '-' and '_'"),
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

export type PartialConfig = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  model: string;
  ui: "auto" | "tui" | "plain";
  maxSteps: number;
  permissions: {
    autoAllowReads: boolean;
    allow: string[];
    deny: string[];
  };
  truncation: {
    toolOutputMaxChars: number;
  };
  maxTotalTokens: number | undefined;
  contextWindow: number | undefined;
  compaction: {
    enabled: boolean;
    triggerRatio: number;
    keepRecentMessages: number;
  };
  retries: {
    maxAttempts: number;
  };
  mcpServers: Record<string, McpServerConfig>;
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  model: "openrouter:nex-agi/nex-n2.5-pro:free",
  ui: "auto",
  maxSteps: 25,
  permissions: {
    autoAllowReads: true,
    allow: [],
    deny: [],
  },
  truncation: {
    toolOutputMaxChars: 30_000,
  },
  maxTotalTokens: undefined,
  contextWindow: undefined,
  compaction: {
    enabled: true,
    triggerRatio: 0.8,
    keepRecentMessages: 6,
  },
  retries: {
    maxAttempts: 3,
  },
  mcpServers: {},
};
