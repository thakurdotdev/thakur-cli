import { z } from "zod";
import { modelMessageSchema } from "ai";

/**
 * Versioned session schema (v1).
 *
 * JSONL lines use a discriminated union with a version literal so old
 * transcripts remain parseable and migratable. Message lines are validated
 * with the AI SDK's own `modelMessageSchema` — persisted messages must be
 * exactly what the model protocol understands.
 *
 * Secrets policy: session files must never contain API keys. Messages,
 * usage and metadata only are persisted.
 */

export const SessionMetaLineSchema = z.object({
  kind: z.literal("meta"),
  v: z.literal(1),
  sessionId: z.string().min(1),
  model: z.string().min(1),
  cwd: z.string().min(1),
  startedAt: z.string().min(1),
});

export const SessionMessageLineSchema = z.object({
  kind: z.literal("message"),
  message: modelMessageSchema,
});

export const SessionUsageLineSchema = z.object({
  kind: z.literal("usage"),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
});

export const SessionDoneLineSchema = z.object({
  kind: z.literal("done"),
  stopReason: z.string().min(1),
  finishedAt: z.string().min(1),
});

/** Audit record: estimated context tokens before/after a compaction pass. */
export const SessionCompactionLineSchema = z.object({
  kind: z.literal("compaction"),
  before: z.number().int().min(0),
  after: z.number().int().min(0),
  at: z.string().min(1),
});

/** Audit record: model switch during the session. */
export const SessionModelSwitchLineSchema = z.object({
  kind: z.literal("model_switch"),
  model: z.string().min(1),
  switchedAt: z.string().min(1),
});

export const SessionLineSchema = z.discriminatedUnion("kind", [
  SessionMetaLineSchema,
  SessionMessageLineSchema,
  SessionUsageLineSchema,
  SessionDoneLineSchema,
  SessionCompactionLineSchema,
  SessionModelSwitchLineSchema,
]);

export type SessionMetaLine = z.infer<typeof SessionMetaLineSchema>;
export type SessionMessageLine = z.infer<typeof SessionMessageLineSchema>;
export type SessionUsageLine = z.infer<typeof SessionUsageLineSchema>;
export type SessionDoneLine = z.infer<typeof SessionDoneLineSchema>;
export type SessionCompactionLine = z.infer<typeof SessionCompactionLineSchema>;
export type SessionModelSwitchLine = z.infer<typeof SessionModelSwitchLineSchema>;
export type SessionLine = z.infer<typeof SessionLineSchema>;
