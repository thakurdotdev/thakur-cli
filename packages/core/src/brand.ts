/**
 * Branded primitive types.
 *
 * Branding prevents accidental mixing of unrelated strings (e.g. feeding a raw
 * user-supplied path where a validated absolute path is required) while keeping
 * the underlying representation a plain string at runtime.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & {
  readonly [brand]: B;
};

/** A validated absolute filesystem path (platform-native separators). */
export type AbsolutePath = Brand<string, "AbsolutePath">;

/** A model identifier in `provider:model` form, e.g. `openrouter:anthropic/claude-sonnet-4.5`. */
export type ModelId = Brand<string, "ModelId">;

/** A session identifier (UUID). */
export type SessionId = Brand<string, "SessionId">;

export function asAbsolutePath(value: string): AbsolutePath {
  return value as AbsolutePath;
}

export function asModelId(value: string): ModelId {
  return value as ModelId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}
