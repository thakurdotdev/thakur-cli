import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionStore,
  findResumableSession,
  loadResumableSession,
  resumableMessages,
} from "@harness/core";
import type { ModelMessage } from "ai";

/**
 * Session resume: transcript sanitization and latest-session selection.
 * Fixtures are real SessionStore files so schema validation runs end to end.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-resume-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistantText = (text: string): ModelMessage => ({ role: "assistant", content: text });
const assistantCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "write_file", input: { path: "x" } }],
});
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "write_file",
      output: { type: "text", value: "ok" },
    },
  ],
});

describe("resumableMessages", () => {
  it("keeps a complete text exchange", () => {
    const messages = [user("one"), assistantText("reply"), user("two"), assistantText("done")];
    expect(resumableMessages(messages)).toEqual(messages);
  });

  it("drops a trailing unanswered user turn", () => {
    const messages = [user("one"), assistantText("reply"), user("never answered")];
    expect(resumableMessages(messages)).toEqual([user("one"), assistantText("reply")]);
  });

  it("drops a trailing assistant tool-call whose result never landed", () => {
    const messages = [user("go"), assistantText("on it"), assistantCall("c1")];
    expect(resumableMessages(messages)).toEqual([user("go"), assistantText("on it")]);
  });

  it("keeps a resolved tool exchange at the end", () => {
    const messages = [user("go"), assistantCall("c1"), toolResult("c1")];
    expect(resumableMessages(messages)).toEqual(messages);
  });

  it("cuts back to the last closed boundary in a mixed transcript", () => {
    const messages = [
      user("first"),
      assistantText("did it"),
      user("second"),
      assistantCall("c2"),
      toolResult("c2"),
      user("third"),
      assistantCall("c3"), // unresolved — dropped with the dangling user turn
    ];
    const expected = [
      user("first"),
      assistantText("did it"),
      user("second"),
      assistantCall("c2"),
      toolResult("c2"),
    ];
    expect(resumableMessages(messages)).toEqual(expected);
  });

  it("returns empty for a transcript with no closed boundary", () => {
    expect(resumableMessages([user("dangling")])).toEqual([]);
    expect(resumableMessages([assistantCall("c1")])).toEqual([]);
  });
});

describe("loadResumableSession", () => {
  it("replays messages and usage from a real transcript", () => {
    const dir = tempDir();
    const session = SessionStore.create(dir, { model: "mock", cwd: "/proj" });
    session.appendMessage(user("hello"));
    session.appendMessage(assistantText("hi back"));
    session.appendUsage(100, 20);
    session.appendUsage(50, 5);
    session.appendDone("stop");
    session.appendMessage(user("next turn"));

    const resumed = loadResumableSession(session.path);
    expect(resumed).toBeDefined();
    expect(resumed?.model).toBe("mock");
    expect(resumed?.cwd).toBe("/proj");
    expect(resumed?.sessionId).toBeTruthy();
    // The dangling "next turn" is dropped by sanitization.
    expect(resumed?.messages).toEqual([user("hello"), assistantText("hi back")]);
    expect(resumed?.runs).toBe(1);
    expect(resumed?.totalUsage).toEqual({ inputTokens: 150, outputTokens: 25 });
  });

  it("returns undefined for missing, meta-only, or unusable files", () => {
    const dir = tempDir();
    expect(loadResumableSession(join(dir, "missing.jsonl"))).toBeUndefined();

    const metaOnly = SessionStore.create(dir, { model: "m", cwd: "/p" });
    expect(loadResumableSession(metaOnly.path)).toBeUndefined();
  });

  it("openExisting appends to the same transcript without a second meta line", () => {
    const dir = tempDir();
    const original = SessionStore.create(dir, { model: "mock", cwd: "/proj" });
    original.appendMessage(user("one"));
    original.appendDone("stop");

    const reopened = SessionStore.openExisting(original.path);
    reopened.appendMessage(user("two"));
    reopened.appendDone("stop");

    const { lines, errors } = SessionStore.load(original.path);
    expect(errors).toEqual([]);
    expect(lines.filter((line) => line.kind === "meta")).toHaveLength(1);
    expect(lines.filter((line) => line.kind === "done")).toHaveLength(2);
  });
});

describe("findResumableSession", () => {
  it("returns the newest usable session, filtered by cwd", () => {
    const dir = tempDir();
    const older = SessionStore.create(dir, { model: "old", cwd: "/proj" });
    older.appendMessage(user("older conversation"));
    older.appendMessage(assistantText("older reply"));
    older.appendDone("stop");
    // Backdate so mtime ordering is deterministic even on fast filesystems.
    utimesSync(older.path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const newer = SessionStore.create(dir, { model: "new", cwd: "/proj" });
    newer.appendMessage(user("newer conversation"));
    newer.appendMessage(assistantText("newer reply"));
    newer.appendDone("stop");

    // A session from another project must be skipped entirely.
    const other = SessionStore.create(dir, { model: "elsewhere", cwd: "/other" });
    other.appendMessage(user("different project"));
    other.appendMessage(assistantText("elsewhere reply"));
    other.appendDone("stop");
    utimesSync(other.path, new Date(), new Date());

    const found = findResumableSession(dir, { cwd: "/proj" });
    expect(found?.model).toBe("new");
    expect(found?.messages).toEqual([user("newer conversation"), assistantText("newer reply")]);
  });

  it("skips sessions that sanitize to nothing and falls back to older ones", () => {
    const dir = tempDir();
    const older = SessionStore.create(dir, { model: "old", cwd: "/proj" });
    older.appendMessage(user("usable older"));
    older.appendMessage(assistantText("older reply"));
    older.appendDone("stop");
    utimesSync(older.path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    // Newest on disk, but the only turn was never answered — nothing safely
    // replayable, so resume falls back to the older transcript.
    const newest = SessionStore.create(dir, { model: "new", cwd: "/proj" });
    newest.appendMessage(user("never answered"));

    const found = findResumableSession(dir, { cwd: "/proj" });
    expect(found?.model).toBe("old");
  });

  it("returns undefined for an empty or missing directory", () => {
    expect(findResumableSession(join(tempDir(), "nope"))).toBeUndefined();
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    expect(findResumableSession(dir)).toBeUndefined();
  });
});
