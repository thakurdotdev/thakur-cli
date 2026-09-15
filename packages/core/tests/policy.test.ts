import { describe, expect, it } from "vitest";
import {
  AllowAllGate,
  InteractiveGate,
  PolicyGate,
  buildPermissionPolicy,
  parsePermissionRule,
  permissionTarget,
  ruleMatches,
} from "@harness/core";
import type { PermissionDecision, PermissionGate, PermissionRequest } from "@harness/core";
import { HarnessError } from "@harness/core";

function request(
  tool: string,
  input: unknown,
  risk: PermissionRequest["risk"] = "execute",
): PermissionRequest {
  return { tool, input, risk };
}

describe("parsePermissionRule", () => {
  it("parses bare tool rules", () => {
    expect(parsePermissionRule("bash")).toEqual({ tool: "bash", pattern: undefined });
    expect(parsePermissionRule("  write_file  ")).toEqual({
      tool: "write_file",
      pattern: undefined,
    });
  });

  it("splits tool:pattern on the first colon", () => {
    expect(parsePermissionRule("bash:npm *")).toEqual({ tool: "bash", pattern: "npm *" });
    expect(parsePermissionRule("bash:npm run *:quiet")).toEqual({
      tool: "bash",
      pattern: "npm run *:quiet",
    });
  });

  it("rejects empty or malformed rules", () => {
    expect(() => parsePermissionRule("")).toThrow(HarnessError);
    expect(() => parsePermissionRule("   ")).toThrow(HarnessError);
    expect(() => parsePermissionRule(":pattern")).toThrow(HarnessError);
    expect(() => parsePermissionRule("tool:")).toThrow(HarnessError);
  });
});

describe("permissionTarget", () => {
  it("extracts the command for bash and paths for file tools", () => {
    expect(permissionTarget("bash", { command: "npm test" })).toBe("npm test");
    expect(permissionTarget("write_file", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(permissionTarget("edit_file", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(permissionTarget("list_dir", {})).toBe(".");
    expect(permissionTarget("unknown_tool", { anything: true })).toBe("");
  });

  it("returns empty for non-object input", () => {
    expect(permissionTarget("bash", "rm -rf /")).toBe("");
    expect(permissionTarget("bash", null)).toBe("");
  });
});

describe("ruleMatches", () => {
  const rules = buildPermissionPolicy({
    allow: ["write_file:src/**", "bash"],
    deny: ["bash:rm -rf*", "read_file:.secrets/**"],
  });

  it("bare tool rules match any input of that tool", () => {
    expect(ruleMatches(rules.allow[1]!, request("bash", { command: "anything" }))).toBe(true);
    expect(ruleMatches(rules.allow[1]!, request("write_file", { path: "x" }))).toBe(false);
  });

  it("pattern rules glob against the target, dotfiles included", () => {
    const allow = rules.allow[0]!;
    expect(ruleMatches(allow, request("write_file", { path: "src/deep/a.ts" }))).toBe(true);
    expect(ruleMatches(allow, request("write_file", { path: "docs/a.ts" }))).toBe(false);

    const deny = rules.deny[1]!;
    expect(ruleMatches(deny, request("read_file", { path: ".secrets/credentials" }))).toBe(true);
    expect(ruleMatches(deny, request("read_file", { path: "src/main.ts" }))).toBe(false);
  });

  it("matches commands anywhere in the string for prefix patterns", () => {
    const deny = buildPermissionPolicy({ deny: ["bash:* --force"] }).deny[0]!;
    expect(ruleMatches(deny, request("bash", { command: "git push --force" }))).toBe(true);
  });

  it("bash wildcards cross slashes — commands are not paths", () => {
    const deny = buildPermissionPolicy({ deny: ["bash:rm *"] }).deny[0]!;
    expect(ruleMatches(deny, request("bash", { command: "rm -rf /" }))).toBe(true);
    expect(ruleMatches(deny, request("bash", { command: "sudo rm -rf /" }))).toBe(false);
  });
});

class RecordingGate implements PermissionGate {
  readonly calls: PermissionRequest[] = [];
  private readonly decision: PermissionDecision;

  constructor(decision: PermissionDecision) {
    this.decision = decision;
  }

  decide(req: PermissionRequest): PermissionDecision {
    this.calls.push(req);
    return this.decision;
  }
}

describe("PolicyGate", () => {
  it("deny wins even when an allow rule also matches", async () => {
    const gate = new PolicyGate({
      policy: buildPermissionPolicy({ allow: ["bash"], deny: ["bash:rm *"] }),
      fallback: new AllowAllGate(),
    });
    const decision = await gate.decide(request("bash", { command: "rm -rf /" }));
    expect(decision.allowed).toBe(false);
    if (typeof decision === "object" && "reason" in decision) {
      expect(decision.reason).toContain("denied by policy");
    }
  });

  it("allow rules auto-approve without consulting the fallback", async () => {
    const fallback = new RecordingGate({ allowed: true, reason: "fallback" });
    const gate = new PolicyGate({
      policy: buildPermissionPolicy({ allow: ["bash:npm *"] }),
      fallback,
    });
    const decision = await gate.decide(request("bash", { command: "npm run build" }));
    expect(decision.allowed).toBe(true);
    expect(fallback.calls).toHaveLength(0);
  });

  it("unmatched requests fall through to the fallback gate", async () => {
    const fallback = new RecordingGate({ allowed: false, reason: "asked the human" });
    const gate = new PolicyGate({
      policy: buildPermissionPolicy({ allow: ["write_file:src/**"] }),
      fallback,
    });
    const decision = await gate.decide(request("bash", { command: "curl evil" }));
    expect(decision.allowed).toBe(false);
    expect(fallback.calls).toHaveLength(1);
  });

  it("composes with the InteractiveGate contract (sync or async fallbacks)", async () => {
    const gate = new PolicyGate({
      policy: buildPermissionPolicy({ deny: ["bash"] }),
      fallback: new InteractiveGate({ onAsk: () => ({ action: "allow" }) }),
    });
    const decision = await gate.decide(request("bash", { command: "ls" }));
    expect(decision.allowed).toBe(false);
  });
});

describe("wildcard tool-name rules (MCP)", () => {
  it("matches wildcard tool parts against the request tool name", () => {
    const rule = parsePermissionRule("mcp__fs__*");
    expect(ruleMatches(rule, request("mcp__fs__read_file", {}))).toBe(true);
    expect(ruleMatches(rule, request("mcp__fs__write_file", {}))).toBe(true);
    expect(ruleMatches(rule, request("mcp__fsx__read_file", {}))).toBe(false);
    expect(ruleMatches(rule, request("read_file", {}))).toBe(false);
  });

  it("supports single-character wildcards", () => {
    const rule = parsePermissionRule("mcp__db-?");
    expect(ruleMatches(rule, request("mcp__db-1", {}))).toBe(true);
    expect(ruleMatches(rule, request("mcp__db-12", {}))).toBe(false);
  });

  it("deny with wildcard tool part beats an allow rule (deny-first order)", async () => {
    const gate = new PolicyGate({
      policy: buildPermissionPolicy({
        allow: ["mcp__fs__*"],
        deny: ["mcp__fs__write_file"],
      }),
      fallback: new AllowAllGate(),
    });
    expect((await gate.decide(request("mcp__fs__read_file", {}))).allowed).toBe(true);
    expect((await gate.decide(request("mcp__fs__write_file", {}))).allowed).toBe(false);
  });

  it("exact tool rules are unaffected by the wildcard generalization", () => {
    const rule = parsePermissionRule("bash");
    expect(ruleMatches(rule, request("bash", { command: "ls" }))).toBe(true);
    expect(ruleMatches(rule, request("grep", {}))).toBe(false);
  });
});
