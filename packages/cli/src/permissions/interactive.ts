import * as prompts from "@clack/prompts";
import { InteractiveGate } from "@harness/core";
import type { AskDecision, PermissionRequest } from "@harness/core";

/**
 * Interactive permission UX ([allow once / always this session / deny]) built
 * on @clack/prompts. Presentation lives in the CLI; the engine only sees the
 * PermissionGate interface.
 */

function summariseInput(input: unknown): string {
  try {
    const text = JSON.stringify(input) ?? "";
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return "";
  }
}

/**
 * The clack-backed ask callback. Exported separately from the gate factory so
 * frontends that compose their own gate chain (ChatCore) can reuse the same
 * presentation without constructing a second gate.
 */
export async function clackAsk(request: PermissionRequest): Promise<AskDecision> {
  const summary = summariseInput(request.input);
  const message =
    summary.length > 0 ? `Allow ${request.tool} ${summary}?` : `Allow ${request.tool}?`;

  const choice = await prompts.select({
    message,
    options: [
      { value: "allow", label: "Allow once" },
      { value: "always", label: `Always allow ${request.tool} in this session` },
      { value: "deny", label: "Deny" },
    ],
  });

  if (prompts.isCancel(choice) || typeof choice !== "string") {
    return { action: "deny", reason: "cancelled by user" };
  }
  return { action: choice };
}

export function createClackGate(options: {
  autoAllowReads?: boolean | undefined;
}): InteractiveGate {
  return new InteractiveGate({
    ...(options.autoAllowReads !== undefined ? { autoAllowReads: options.autoAllowReads } : {}),
    onAsk: clackAsk,
  });
}
