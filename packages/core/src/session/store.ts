import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { SessionLineSchema } from "./schema.ts";
import type { SessionLine } from "./schema.ts";
import { describeError } from "../result.ts";

/**
 * Append-only JSONL session persistence.
 *
 * The store is intentionally simple and synchronous: CLI-scale write volumes
 * make appendFileSync both the fastest and the most crash-safe option. Every
 * line is schema-validated when read back, so corrupted transcripts degrade
 * gracefully instead of poisoning a resumed session (full resume lands in
 * Phase 4).
 */
export class SessionStore {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  /** Create a new session file under `dir` and write the meta line. */
  static create(
    dir: string,
    meta: { sessionId?: string; model: string; cwd: string },
  ): SessionStore {
    mkdirSync(dir, { recursive: true });
    const sessionId = meta.sessionId ?? randomUUID();
    const store = new SessionStore(join(dir, `${sessionId}.jsonl`));
    store.append({
      kind: "meta",
      v: 1,
      sessionId,
      model: meta.model,
      cwd: meta.cwd,
      startedAt: new Date().toISOString(),
    });
    return store;
  }

  /**
   * Reopen an existing transcript for appending (session resume). The meta
   * line is left untouched — the resumed session keeps its original id,
   * model history and start time.
   */
  static openExisting(path: string): SessionStore {
    return new SessionStore(path);
  }

  /** Append one schema-validated line. */
  append(line: SessionLine): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, "utf8");
  }

  appendMessage(message: ModelMessage): void {
    this.append({ kind: "message", message });
  }

  appendUsage(inputTokens: number, outputTokens: number, costUsd?: number): void {
    if (costUsd === undefined) {
      this.append({ kind: "usage", inputTokens, outputTokens });
      return;
    }
    this.append({ kind: "usage", inputTokens, outputTokens, costUsd });
  }

  appendDone(stopReason: string): void {
    this.append({ kind: "done", stopReason, finishedAt: new Date().toISOString() });
  }

  appendCompaction(beforeTokens: number, afterTokens: number): void {
    this.append({
      kind: "compaction",
      before: beforeTokens,
      after: afterTokens,
      at: new Date().toISOString(),
    });
  }

  appendModelSwitch(model: string): void {
    this.append({
      kind: "model_switch",
      model,
      switchedAt: new Date().toISOString(),
    });
  }

  /**
   * Load and validate a session file. Corrupted lines are reported per line
   * instead of failing the whole load.
   */
  static load(path: string): {
    lines: SessionLine[];
    errors: Array<{ line: number; problem: string }>;
  } {
    const text = readFileSync(path, "utf8");
    const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
    const lines: SessionLine[] = [];
    const errors: Array<{ line: number; problem: string }> = [];
    for (const [index, raw] of rawLines.entries()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        lines.push(SessionLineSchema.parse(parsed));
      } catch (error) {
        errors.push({ line: index + 1, problem: describeError(error) });
      }
    }
    return { lines, errors };
  }
}
