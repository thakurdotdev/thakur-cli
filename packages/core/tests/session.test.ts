import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "@harness/core";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-session-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionStore", () => {
  it("writes a meta line on create and appends valid JSONL", () => {
    const dir = tempDir();
    const store = SessionStore.create(dir, { model: "openrouter:test/model", cwd: "/repo" });
    store.appendMessage({ role: "user", content: "hello" });
    store.appendUsage(10, 5);
    store.appendDone("stop");

    const lines = readFileSync(store.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);

    const meta = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(meta["kind"]).toBe("meta");
    expect(meta["v"]).toBe(1);
    expect(meta["model"]).toBe("openrouter:test/model");

    const done = JSON.parse(lines[3] ?? "{}") as Record<string, unknown>;
    expect(done["kind"]).toBe("done");
    expect(done["stopReason"]).toBe("stop");
  });

  it("loads back everything it wrote, in order", () => {
    const dir = tempDir();
    const store = SessionStore.create(dir, { model: "m", cwd: "/repo" });
    store.appendMessage({ role: "user", content: "create hi.txt" });
    store.appendMessage({ role: "assistant", content: "done" });

    const { lines, errors } = SessionStore.load(store.path);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(3);
    expect(lines[0]?.kind).toBe("meta");
    expect(lines[1]?.kind).toBe("message");
    if (lines[1]?.kind === "message") {
      expect(lines[1].message).toEqual({ role: "user", content: "create hi.txt" });
    }
    expect(lines[2]?.kind).toBe("message");
  });

  it("reports corrupted lines instead of failing the whole load", () => {
    const dir = tempDir();
    const store = SessionStore.create(dir, { model: "m", cwd: "/repo" });
    store.appendMessage({ role: "user", content: "keep me" });

    const raw = readFileSync(store.path, "utf8");
    writeFileSync(store.path, `${raw}this is not json\n{"kind":"usage"}`, "utf8");

    const { lines, errors } = SessionStore.load(store.path);
    expect(lines.map((line) => line.kind)).toEqual(["meta", "message"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.line).toBe(3);
    expect(errors[1]?.line).toBe(4);
  });

  it("rejects messages that are not valid model messages on load", () => {
    const dir = tempDir();
    const store = SessionStore.create(dir, { model: "m", cwd: "/repo" });
    store.appendMessage({ role: "user", content: "fine" });
    const raw = readFileSync(store.path, "utf8");
    writeFileSync(
      store.path,
      `${raw}${JSON.stringify({ kind: "message", message: { role: "wizard", content: "bogus" } })}\n`,
      "utf8",
    );

    const { lines, errors } = SessionStore.load(store.path);
    expect(lines).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it("records and loads model switch lines", () => {
    const dir = tempDir();
    const store = SessionStore.create(dir, { model: "google:gemini-2.5-flash", cwd: "/repo" });
    store.appendModelSwitch("google:gemini-2.5-pro");

    const { lines, errors } = SessionStore.load(store.path);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.kind).toBe("model_switch");
    if (lines[1]?.kind === "model_switch") {
      expect(lines[1].model).toBe("google:gemini-2.5-pro");
      expect(typeof lines[1].switchedAt).toBe("string");
    }
  });
});
