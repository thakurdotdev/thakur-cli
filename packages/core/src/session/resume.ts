import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { SessionStore } from "./store.ts";
import type { SessionLine } from "./schema.ts";

/**
 * Session resume.
 *
 * `--continue` replays the most recent usable transcript in the current
 * project. Transcripts are append-only JSONL, so an interrupted run can leave
 * the file in a half-finished state: a dangling user turn the model never
 * answered, or an assistant tool-call whose tool result never got appended.
 * Replaying such a tail would hand the provider a protocol-violating message
 * list, so `resumableMessages` cuts the history back to the last *closed*
 * boundary:
 *
 *   - every assistant tool-call in the kept prefix has its tool result, and
 *   - the last kept message is not an unanswered user turn.
 *
 * The dropped tail is never lost — it stays in the transcript on disk; resume
 * simply starts prompting from a point where a new user turn is legal.
 */

export interface ResumableSession {
  path: string;
  sessionId: string;
  model: string;
  cwd: string;
  startedAt: string;
  /** Sanitized, replayable message history (possibly empty for meta-only files). */
  messages: ModelMessage[];
  runs: number;
  totalUsage: { inputTokens: number; outputTokens: number };
}

/**
 * Reduce a raw message list to the largest prefix that ends in a state where
 * appending a new user message is protocol-safe.
 */
export function resumableMessages(messages: ReadonlyArray<ModelMessage>): ModelMessage[] {
  let pendingToolCalls = 0;
  let lastClosedIndex = -1;

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      let added = 0;
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-call") {
            pendingToolCalls += 1;
            added += 1;
          }
        }
      }
      // A pure-text assistant turn closes cleanly.
      if (added === 0) {
        lastClosedIndex = index;
      }
      continue;
    }
    if (message.role === "tool") {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-result" && pendingToolCalls > 0) {
            pendingToolCalls -= 1;
          }
        }
      }
      if (pendingToolCalls === 0) {
        lastClosedIndex = index;
      }
      continue;
    }
    // A user turn is never a closed boundary: it may be an unanswered prompt
    // from an aborted run. The next assistant/tool message will close it.
  }

  return messages.slice(0, lastClosedIndex + 1);
}

function extractFromLines(path: string, lines: SessionLine[]): ResumableSession | undefined {
  const meta = lines.find((line) => line.kind === "meta");
  if (meta === undefined || meta.kind !== "meta") {
    return undefined;
  }
  const messages: ModelMessage[] = [];
  let runs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of lines) {
    if (line.kind === "message") {
      messages.push(line.message);
    } else if (line.kind === "usage") {
      inputTokens += line.inputTokens;
      outputTokens += line.outputTokens;
    } else if (line.kind === "done") {
      runs += 1;
    }
  }
  return {
    path,
    sessionId: meta.sessionId,
    model: meta.model,
    cwd: meta.cwd,
    startedAt: meta.startedAt,
    messages: resumableMessages(messages),
    runs,
    totalUsage: { inputTokens, outputTokens },
  };
}

/**
 * Load one transcript and reduce it to a resumable form. Returns undefined
 * when the file is missing, unreadable, has no meta line, or sanitizes to an
 * empty history (nothing safe to replay).
 */
export function loadResumableSession(path: string): ResumableSession | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const { lines } = SessionStore.load(path);
    const session = extractFromLines(path, lines);
    if (session === undefined || session.messages.length === 0) {
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

/**
 * Find the most recent resumable session in `dir`, newest first. When
 * `options.cwd` is given, sessions started in other directories are skipped —
 * continuing a transcript against a different project root would break every
 * path the conversation references.
 */
export function findResumableSession(
  dir: string,
  options: { cwd?: string } = {},
): ResumableSession | undefined {
  for (const path of listSessionFiles(dir)) {
    const session = loadResumableSession(path);
    if (session === undefined) {
      continue;
    }
    if (options.cwd !== undefined && session.cwd !== options.cwd) {
      continue;
    }
    return session;
  }
  return undefined;
}
