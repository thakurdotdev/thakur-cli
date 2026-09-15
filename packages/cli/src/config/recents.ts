import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Recently used models, persisted next to the auth store. Powers the
 * model picker's "Recent" section (OpenCode convention): the models you
 * actually ran, newest first, deduplicated, capped.
 */

const MAX_RECENTS = 8;

export function recentModelsPath(homeDir: string = homedir()): string {
  return join(homeDir, ".harness", "recent-models.json");
}

export function loadRecentModels(homeDir: string = homedir()): string[] {
  const path = recentModelsPath(homeDir);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

/** Most-recent-first upsert. Failures are silent — recents are a nicety. */
export function recordRecentModel(modelRef: string, homeDir: string = homedir()): void {
  const current = loadRecentModels(homeDir);
  const next = [modelRef, ...current.filter((entry) => entry !== modelRef)].slice(0, MAX_RECENTS);
  try {
    const path = recentModelsPath(homeDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // Best effort only.
  }
}
