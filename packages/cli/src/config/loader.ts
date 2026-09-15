import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessError, parsePermissionRule } from "@harness/core";
import { ConfigSchema } from "./schema.ts";
import type { PartialConfig, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

/**
 * Config loader with deterministic precedence:
 *   defaults <- ~/.harness/config.json <- .harness.json <- env <- flags
 *
 * Invalid files fail fast with the exact validation issue — never silently
 * ignored, never partially applied.
 */

function readConfigFile(path: string): PartialConfig {
  if (!existsSync(path)) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new HarnessError(
      `Invalid JSON in config file: ${path}`,
      error instanceof Error ? error.message : undefined,
    );
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new HarnessError(`Invalid configuration in ${path}`, issues);
  }
  return result.data;
}

function envLayer(env: Record<string, string | undefined>): PartialConfig {
  const layer: PartialConfig = {};
  const model = env["HARNESS_MODEL"];
  if (typeof model === "string" && model.length > 0) {
    layer.model = model;
  }
  return layer;
}

function mergeSectionFields<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (base === undefined) {
    return override;
  }
  if (override === undefined) {
    return base;
  }
  // Nested sections merge field-by-field so a project overriding one knob
  // does not silently reset the rest; arrays (permission rule lists) still
  // replace wholesale.
  return { ...base, ...override };
}

function mergeLayers(layers: ReadonlyArray<PartialConfig>): PartialConfig {
  let merged: PartialConfig = {};
  for (const layer of layers) {
    merged = {
      ...merged,
      ...(layer.model !== undefined ? { model: layer.model } : {}),
      ...(layer.ui !== undefined ? { ui: layer.ui } : {}),
      ...(layer.maxSteps !== undefined ? { maxSteps: layer.maxSteps } : {}),
      permissions: mergeSectionFields(merged.permissions, layer.permissions),
      truncation: mergeSectionFields(merged.truncation, layer.truncation),
      ...(layer.maxTotalTokens !== undefined ? { maxTotalTokens: layer.maxTotalTokens } : {}),
      ...(layer.contextWindow !== undefined ? { contextWindow: layer.contextWindow } : {}),
      compaction: mergeSectionFields(merged.compaction, layer.compaction),
      retries: mergeSectionFields(merged.retries, layer.retries),
      // Records merge per-key: a project defining one server does not reset
      // servers configured at a higher-precedence layer.
      mcpServers: mergeSectionFields(merged.mcpServers, layer.mcpServers),
    };
  }
  return merged;
}

export function loadConfig(options: {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  projectDir?: string;
  flags?: PartialConfig;
}): ResolvedConfig {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const projectDir = options.projectDir ?? process.cwd();

  const merged = mergeLayers([
    readConfigFile(join(homeDir, ".harness", "config.json")),
    readConfigFile(join(projectDir, ".harness.json")),
    envLayer(env),
    options.flags ?? {},
  ]);

  const resolved = ConfigSchema.safeParse(merged);
  if (!resolved.success) {
    throw new HarnessError("Invalid configuration", "Check your config files and CLI flags.");
  }

  // Permission rules are validated eagerly (fail-fast): a typo in a config
  // file should stop the boot, not surface as a surprise mid-session.
  for (const rule of [
    ...(resolved.data.permissions?.allow ?? []),
    ...(resolved.data.permissions?.deny ?? []),
  ]) {
    try {
      parsePermissionRule(rule);
    } catch (error) {
      throw new HarnessError(
        `Invalid permission rule: "${rule}"`,
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  return {
    model: resolved.data.model ?? DEFAULT_CONFIG.model,
    ui: resolved.data.ui ?? DEFAULT_CONFIG.ui,
    maxSteps: resolved.data.maxSteps ?? DEFAULT_CONFIG.maxSteps,
    permissions: {
      autoAllowReads:
        resolved.data.permissions?.autoAllowReads ?? DEFAULT_CONFIG.permissions.autoAllowReads,
      allow: resolved.data.permissions?.allow ?? DEFAULT_CONFIG.permissions.allow,
      deny: resolved.data.permissions?.deny ?? DEFAULT_CONFIG.permissions.deny,
    },
    truncation: {
      toolOutputMaxChars:
        resolved.data.truncation?.toolOutputMaxChars ??
        DEFAULT_CONFIG.truncation.toolOutputMaxChars,
    },
    maxTotalTokens: resolved.data.maxTotalTokens ?? DEFAULT_CONFIG.maxTotalTokens,
    contextWindow: resolved.data.contextWindow ?? DEFAULT_CONFIG.contextWindow,
    compaction: {
      enabled: resolved.data.compaction?.enabled ?? DEFAULT_CONFIG.compaction.enabled,
      triggerRatio:
        resolved.data.compaction?.triggerRatio ?? DEFAULT_CONFIG.compaction.triggerRatio,
      keepRecentMessages:
        resolved.data.compaction?.keepRecentMessages ??
        DEFAULT_CONFIG.compaction.keepRecentMessages,
    },
    retries: {
      maxAttempts: resolved.data.retries?.maxAttempts ?? DEFAULT_CONFIG.retries.maxAttempts,
    },
    // Normalize zod's | undefined optionals into core's McpServerConfig shape.
    mcpServers: Object.fromEntries(
      Object.entries(resolved.data.mcpServers ?? {}).map(([name, cfg]) => [
        name,
        {
          command: cfg.command,
          ...(cfg.args !== undefined ? { args: cfg.args } : {}),
          ...(cfg.env !== undefined ? { env: cfg.env } : {}),
        },
      ]),
    ),
  };
}
