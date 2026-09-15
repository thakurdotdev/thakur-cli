/**
 * Permission primitives (Phase 1 gate wrapper).
 *
 * The full policy engine (glob allow/deny, .harness.json precedence,
 * environment redaction) lands in Phase 3 — but the *shape* of permission
 * decisions is fixed here so every mutating tool already flows through one
 * choke point from day one.
 */

export type ToolRisk = "read" | "write" | "execute";

export interface PermissionRequest {
  /** Tool name, e.g. "write_file". */
  tool: string;
  /** Classified risk level of the tool. */
  risk: ToolRisk;
  /** Raw tool input (already schema-validated). */
  input: unknown;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface PermissionGate {
  decide(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision>;
}

/** Answers the gate may solicit from a human or policy layer. */
export type AskAction = "allow" | "always" | "deny";

export interface AskDecision {
  action: AskAction;
  reason?: string;
}

/** Permit-everything gate. Used for headless/CI smoke runs only. */
export class AllowAllGate implements PermissionGate {
  decide(_request: PermissionRequest): PermissionDecision {
    return { allowed: true, reason: "allow-all policy" };
  }
}

export interface InteractiveGateOptions {
  /**
   * Callback that asks the user for a decision. The engine never implements
   * presentation itself — the CLI supplies a clack-based implementation.
   */
  onAsk: (request: PermissionRequest) => AskDecision | Promise<AskDecision>;
  /** Auto-allow read-classified tools without asking (default true). */
  autoAllowReads?: boolean;
  /** Tools already approved for the lifetime of this gate instance. */
  sessionGrants?: Set<string>;
}

/**
 * Interactive gate: reads auto-allowed per policy, everything else asks.
 * "always" answers are remembered session-scoped (per gate instance).
 */
export class InteractiveGate implements PermissionGate {
  private readonly options: InteractiveGateOptions;
  private readonly grants: Set<string>;

  constructor(options: InteractiveGateOptions) {
    this.options = options;
    this.grants = options.sessionGrants ?? new Set<string>();
  }

  decide(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision> {
    const autoAllowReads = this.options.autoAllowReads ?? true;
    if (autoAllowReads && request.risk === "read") {
      return { allowed: true, reason: "reads auto-allowed" };
    }
    if (this.grants.has(request.tool)) {
      return { allowed: true, reason: "granted for this session" };
    }
    return this.ask(request);
  }

  private async ask(request: PermissionRequest): Promise<PermissionDecision> {
    const answer = await this.options.onAsk(request);
    if (answer.action === "always") {
      this.grants.add(request.tool);
      return { allowed: true, reason: "granted for this session" };
    }
    if (answer.action === "allow") {
      return { allowed: true };
    }
    return { allowed: false, reason: answer.reason ?? "declined by user" };
  }
}
