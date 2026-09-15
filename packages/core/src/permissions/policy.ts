import picomatch from "picomatch";
import { HarnessError } from "../result.ts";
import type { PermissionDecision, PermissionGate, PermissionRequest } from "./types.ts";

/**
 * Declarative permission policy (Phase 3).
 *
 * Rules are strings in one of two forms:
 *
 *   "bash"            — matches every call to that tool
 *   "bash:npm *"      — matches calls whose *target string* matches the
 *                       pattern (tool-dependent semantics below)
 *
 * The tool part may itself contain wildcards ("mcp__fs__*") — useful for
 * MCP tools whose full names are only known at runtime. A wildcard tool
 * part matches the request's tool name with full-string wildcard semantics;
 * a `:pattern` after a wildcard tool part matches the target as usual
 * (tools without a natural target can only be matched by pattern-less
 * rules, which is exactly the case for MCP tools).
 *
 * Target strings are extracted from validated tool input:
 *   bash → command · read/write/edit_file → path · grep/glob/list_dir → path
 *
 * Pattern semantics: `bash` rules use full-string wildcards (`*` crosses
 * `/`, so "rm *" matches "rm -rf /"); path-bearing tools use real glob
 * semantics (`*` stays inside a path segment, `**` crosses, dotfiles match).
 *
 * Evaluation order is security-first: **deny beats allow beats fallback**.
 * The gate composes with any fallback (interactive clack gate in the REPL,
 * AllowAllGate headless) so policy layers stack without special cases.
 */

export interface PermissionRule {
  /** Exact tool name the rule applies to. */
  readonly tool: string;
  /** Glob pattern over the tool's target string; absent = match all inputs. */
  readonly pattern: string | undefined;
}

const RULE_SEPARATOR = ":";

export function parsePermissionRule(rule: string): PermissionRule {
  const trimmed = rule.trim();
  if (trimmed.length === 0) {
    throw new HarnessError(
      "Empty permission rule",
      'Rules look like "bash", "write_file", or "bash:npm *" (tool:glob).',
    );
  }

  const separator = trimmed.indexOf(RULE_SEPARATOR);
  if (separator === -1) {
    return { tool: trimmed, pattern: undefined };
  }

  const tool = trimmed.slice(0, separator).trim();
  const pattern = trimmed.slice(separator + RULE_SEPARATOR.length).trim();
  if (tool.length === 0 || pattern.length === 0) {
    throw new HarnessError(
      `Invalid permission rule: "${rule}"`,
      'Use "tool" or "tool:glob" with non-empty parts, e.g. "bash:npm *".',
    );
  }
  return { tool, pattern };
}

/**
 * The string a `tool:pattern` rule is matched against. Tools without a
 * natural target yield "" — only pattern-less rules can match them.
 */
export function permissionTarget(tool: string, input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "";
  }
  const record = input as Record<string, unknown>;
  switch (tool) {
    case "bash":
      return typeof record["command"] === "string" ? record["command"] : "";
    case "read_file":
    case "write_file":
    case "edit_file":
      return typeof record["path"] === "string" ? record["path"] : "";
    case "grep":
    case "glob":
    case "list_dir":
      return typeof record["path"] === "string" ? record["path"] : ".";
    default:
      return "";
  }
}

/**
 * Shell commands are not paths: `*` in a bash rule must cross `/` so that
 * "rm *" matches "rm -rf /". A tiny wildcard matcher (glob-style escaping,
 * `*` = any run of characters, `?` = one character) gives precise,
 * full-string semantics without glob's path-segment rules.
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`);
}

function wildcardMatches(pattern: string, target: string): boolean {
  return wildcardToRegExp(pattern).test(target);
}

export function ruleMatches(rule: PermissionRule, request: PermissionRequest): boolean {
  const toolHasWildcard = /[*?]/.test(rule.tool);
  if (toolHasWildcard) {
    if (!wildcardMatches(rule.tool, request.tool)) {
      return false;
    }
  } else if (rule.tool !== request.tool) {
    return false;
  }
  if (rule.pattern === undefined) {
    return true;
  }
  const target = permissionTarget(rule.tool, request.input);
  if (rule.tool === "bash") {
    return wildcardMatches(rule.pattern, target);
  }
  // Path-bearing tools use real glob semantics (`*` stays in its segment);
  // dot is enabled so deny rules like "read_file:.secrets/**" hit dotfiles.
  return picomatch.isMatch(target, rule.pattern, { dot: true });
}

export interface PermissionPolicy {
  /** Rules that auto-approve a matching call. */
  readonly allow: readonly PermissionRule[];
  /** Rules that refuse a matching call — evaluated first, always wins. */
  readonly deny: readonly PermissionRule[];
}

export interface BuildPermissionPolicyOptions {
  allow?: readonly string[] | undefined;
  deny?: readonly string[] | undefined;
}

export function buildPermissionPolicy(
  options: BuildPermissionPolicyOptions = {},
): PermissionPolicy {
  return {
    allow: (options.allow ?? []).map(parsePermissionRule),
    deny: (options.deny ?? []).map(parsePermissionRule),
  };
}

export interface PolicyGateOptions {
  policy: PermissionPolicy;
  /** Consulted when no rule matches (deny/allow both miss). */
  fallback: PermissionGate;
}

export class PolicyGate implements PermissionGate {
  private readonly policy: PermissionPolicy;
  private readonly fallback: PermissionGate;

  constructor(options: PolicyGateOptions) {
    this.policy = options.policy;
    this.fallback = options.fallback;
  }

  decide(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision> {
    for (const rule of this.policy.deny) {
      if (ruleMatches(rule, request)) {
        return {
          allowed: false,
          reason: `denied by policy rule "${rule.tool}${rule.pattern === undefined ? "" : `:${rule.pattern}`}"`,
        };
      }
    }
    for (const rule of this.policy.allow) {
      if (ruleMatches(rule, request)) {
        return {
          allowed: true,
          reason: `allowed by policy rule "${rule.tool}${rule.pattern === undefined ? "" : `:${rule.pattern}`}"`,
        };
      }
    }
    return this.fallback.decide(request);
  }
}
