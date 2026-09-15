import { existsSync } from "node:fs";

/**
 * Ripgrep binary resolution for the grep tool.
 *
 * Prefers the binary bundled by `@vscode/ripgrep` (platform-specific optional
 * dependency, resolved through its own loader logic). The dynamic import is
 * wrapped because a broken optional-dependency install makes the module throw
 * at evaluation time — in that case we degrade gracefully to `rg` on PATH.
 */

let cached: Promise<string | null> | null = null;

async function resolveOnce(): Promise<string | null> {
  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath?: unknown };
    if (typeof mod.rgPath === "string" && mod.rgPath.length > 0 && existsSync(mod.rgPath)) {
      return mod.rgPath;
    }
  } catch {
    // Platform binary missing — fall through to PATH lookup.
  }

  try {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync("rg", ["--version"], { stdio: "ignore", windowsHide: true });
    if (probe.error === undefined) {
      return "rg";
    }
  } catch {
    // Not on PATH either.
  }
  return null;
}

/** Cached ripgrep binary path (absolute or PATH name), or null if unavailable. */
export function resolveRgBinary(): Promise<string | null> {
  cached ??= resolveOnce();
  return cached;
}
