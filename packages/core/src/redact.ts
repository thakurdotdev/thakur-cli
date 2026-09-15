/**
 * Environment secret redaction (Phase 3).
 *
 * Shell output is the classic exfiltration path: `env`, `printenv`, a stray
 * `cat .env`, a build tool echoing config. Before bash output reaches the
 * model, we replace the values of environment variables whose *names* look
 * secret-bearing with a fixed marker.
 *
 * This is a heuristic second line of defense, not a sandbox:
 * - name-based detection (KEY/TOKEN/SECRET/PASSWORD/PASSPHRASE/CREDENTIAL)
 * - values shorter than 8 characters are ignored (too false-positive prone)
 * - a bounded candidate list keeps the scan cheap even in hostile envs
 */

export const DEFAULT_SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL)/i;

export const REDACTED_MARKER = "***REDACTED***";

const MIN_SECRET_VALUE_LENGTH = 8;
const MAX_SECRET_CANDIDATES = 64;

export interface CollectSecretsOptions {
  namePattern?: RegExp | undefined;
  /** Explicit allowlist of variable names to never treat as secrets. */
  ignoreNames?: ReadonlySet<string> | undefined;
}

/** Collect candidate secret values from an environment record. */
export function collectSecrets(
  env: Record<string, string | undefined>,
  options: CollectSecretsOptions = {},
): string[] {
  const namePattern = options.namePattern ?? DEFAULT_SECRET_NAME_PATTERN;
  const ignoreNames = options.ignoreNames;
  const values = new Set<string>();

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_VALUE_LENGTH) {
      continue;
    }
    if (ignoreNames?.has(name) === true) {
      continue;
    }
    if (!namePattern.test(name)) {
      continue;
    }
    values.add(value);
    if (values.size >= MAX_SECRET_CANDIDATES) {
      break;
    }
  }
  return [...values];
}

/** Replace every occurrence of each candidate value with the marker. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
  replacement: string = REDACTED_MARKER,
): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length === 0 || !output.includes(secret)) {
      continue;
    }
    output = output.split(secret).join(replacement);
  }
  return output;
}
