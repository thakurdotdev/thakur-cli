import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "@harness/providers";

/**
 * Credential store — the fix for "the exe doesn't open on double-click".
 *
 * API keys exported in a shell only exist in that shell; a launcher-launched
 * binary (Explorer double-click, Start menu, `start harness.exe`) gets a
 * fresh environment and boots without credentials. This module persists keys
 * per provider to `~/.harness/auth.json` so a one-time `harness auth` (or
 * the first-boot onboarding) makes every later launch work everywhere.
 *
 * Precedence is deliberately `process.env` wins: a key set in the session is
 * the more explicit, more recent statement (CI, key rotation) and the store
 * is the durable fallback.
 */

export interface AuthStore {
  /** provider id -> API key. Unknown provider ids are ignored on read. */
  readonly keys: Readonly<Record<string, string>>;
}

export function authFilePath(homeDir: string = homedir()): string {
  return join(homeDir, ".harness", "auth.json");
}

const KNOWN_PROVIDER_IDS = new Set(PROVIDERS.map((provider) => provider.id));

function sanitize(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const keys: Record<string, string> = {};
  for (const [providerId, key] of Object.entries(raw as Record<string, unknown>)) {
    if (KNOWN_PROVIDER_IDS.has(providerId) && typeof key === "string" && key.trim().length > 0) {
      keys[providerId] = key.trim();
    }
  }
  return keys;
}

/** Read the store; missing or malformed files resolve to an empty store (never throw). */
export function loadAuthStore(homeDir: string = homedir()): AuthStore {
  const path = authFilePath(homeDir);
  if (!existsSync(path)) {
    return { keys: {} };
  }
  try {
    return { keys: sanitize(JSON.parse(readFileSync(path, "utf8"))) };
  } catch {
    // A corrupt store must not brick the CLI — treat as empty; saving will
    // rewrite it cleanly.
    return { keys: {} };
  }
}

/** Upsert one provider key and persist the store atomically (tmp file + rename). */
export function saveProviderKey(
  providerId: string,
  apiKey: string,
  homeDir: string = homedir(),
): void {
  if (!KNOWN_PROVIDER_IDS.has(providerId)) {
    throw new Error(
      `Unknown provider "${providerId}" — known: ${[...KNOWN_PROVIDER_IDS].join(", ")}`,
    );
  }
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new Error("API key must not be empty");
  }
  const path = authFilePath(homeDir);
  mkdirSync(join(path, ".."), { recursive: true });
  const store = loadAuthStore(homeDir);
  const keys = { ...store.keys, [providerId]: trimmed };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, "utf8");
  // Best-effort restrictive permissions (posix only; Windows ignores it).
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // chmod is advisory here — the file lives in the user's home directory.
  }
  renameSync(tmp, path);
}

/** Remove one provider key (used by `harness auth --unset <provider>`). */
export function clearProviderKey(providerId: string, homeDir: string = homedir()): void {
  const path = authFilePath(homeDir);
  if (!existsSync(path)) {
    return;
  }
  const store = loadAuthStore(homeDir);
  const { [providerId]: _removed, ...rest } = store.keys;
  void _removed;
  writeFileSync(path, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
}

/**
 * Merge stored keys under `process.env`-style input: environment variables
 * win, stored keys fill the gaps. Returns a plain string map safe to feed to
 * `parseHarnessEnv`.
 */
export function envWithAuthKeys(
  env: Record<string, string | undefined>,
  homeDir: string = homedir(),
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  const stored = loadAuthStore(homeDir).keys;
  const has = (value: string | undefined): boolean =>
    value !== undefined && value.trim().length > 0;

  // Simple providers: one env var, one store slot. Env (even blank→refilled)
  // wins; the store only fills genuine gaps.
  for (const providerId of ["openrouter", "openai", "anthropic"] as const) {
    const provider = PROVIDERS.find((entry) => entry.id === providerId);
    const storedKey = stored[providerId];
    if (provider === undefined || storedKey === undefined) {
      continue;
    }
    if (!has(merged[provider.apiKeyEnv])) {
      merged[provider.apiKeyEnv] = storedKey;
    }
  }

  // Google accepts either spelling: any env spelling wins; the store fills
  // only when neither is set. The resolved key is mirrored to both spellings
  // so every consumer (registry, adapters) sees the same credential.
  const envGoogle = [env["GOOGLE_GENERATIVE_AI_API_KEY"], env["GOOGLE_API_KEY"]].find((value) =>
    has(value),
  );
  const googleKey = envGoogle ?? stored["google"];
  if (googleKey !== undefined) {
    merged["GOOGLE_GENERATIVE_AI_API_KEY"] = googleKey;
    merged["GOOGLE_API_KEY"] = googleKey;
  }
  return merged;
}
