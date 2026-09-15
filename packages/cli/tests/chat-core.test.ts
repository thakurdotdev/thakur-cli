import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { loadResumableSession } from "@harness/core";
import { availableProviders, parseHarnessEnv } from "@harness/providers";
import { ChatCore } from "../src/commands/chat-core.ts";
import type { ChatCoreOptions } from "../src/commands/chat-core.ts";
import { saveProviderKey } from "../src/config/auth.ts";

/**
 * ChatCore tests — the REPL engine both frontends share. Slash commands,
 * boot facts, mock-model turns and the safe-by-default gate behavior, all
 * against a temp cwd so no real session files are touched.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-chat-core-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const usage = (inputTotal: number, outputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp-1", modelId: "mock-model" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: text },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: usage(100, 20),
            },
          ],
        }),
      },
    ],
  });
}

function baseOptions(cwd: string, extra: ChatCoreOptions = {}): ChatCoreOptions {
  return {
    cwd,
    env: { OPENROUTER_API_KEY: "test-key" },
    registryOverride: {},
    modelOverride: textModel("ok"),
    ...extra,
  };
}

describe("ChatCore boot", () => {
  it("reports model, window, session path and MCP facts", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    const boot = core.boot();

    expect(boot.model).toBe("openrouter:nex-agi/nex-n2.5-pro:free");
    expect(boot.contextWindow).toBeGreaterThan(1000);
    expect(boot.windowAssumed).toBe(false); // catalog knows this model
    expect(boot.sessionPath.startsWith(join(cwd, ".harness", "sessions"))).toBe(true);
    expect(boot.continued).toBe(false);
    expect(boot.yolo).toBe(false);
    expect(boot.mcp).toEqual([]);
    expect(boot.mcpErrors).toEqual([]);
    await core.close();
  });

  it("creates a session transcript file on disk", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    const boot = core.boot();
    expect(existsSync(boot.sessionPath)).toBe(true);
    await core.close();
  });
});

describe("ChatCore without credentials", () => {
  const hostEnvHasKeys =
    availableProviders(parseHarnessEnv(process.env as Record<string, string | undefined>)).length >
    0;

  it("boots and reports boot facts with zero provider keys (no throw)", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create({ cwd, env: {}, registryOverride: {} });
    const boot = core.boot();
    expect(boot.model).toBe("openrouter:nex-agi/nex-n2.5-pro:free");
    expect(boot.contextWindow).toBeGreaterThan(1000);
    await core.close();
  });

  it("fails a turn with an actionable notice pointing at /connect", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create({ cwd, env: {}, registryOverride: {} });
    const outcome = await core.handleInput("hello");
    expect(outcome.kind).toBe("turn");
    if (outcome.kind === "turn") {
      expect(outcome.result.error).toBe(true);
      const text = outcome.result.notices.join("\n");
      expect(text).toContain("OPENROUTER_API_KEY");
      expect(text).toContain("/connect");
    }
    await core.close();
  });

  it("picks up a stored key after refreshEnv — no restart needed", async () => {
    if (hostEnvHasKeys) {
      return; // host shell exports a real key — the zero-credential premise fails
    }
    const cwd = tempDir();
    const home = tempDir();
    try {
      const core = await ChatCore.create({ cwd, homeDir: home, registryOverride: {} });
      expect(core.configuredProviders()).toEqual([]);
      saveProviderKey("openrouter", "sk-test", home);
      core.refreshEnv();
      expect(core.configuredProviders().map((provider) => provider.id)).toContain("openrouter");
      await core.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ChatCore slash commands", () => {
  it("handles /help and bare /model without running a turn", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));

    const help = await core.handleInput("/help");
    expect(help.kind).toBe("handled");
    if (help.kind === "handled") {
      expect(help.info).toContain("Commands:");
    }

    const model = await core.handleInput("/model");
    expect(model.kind).toBe("handled");
    if (model.kind === "handled") {
      expect(model.info).toContain("current model:");
    }
    await core.close();
  });

  it("switches models with /model <ref> and reports the new window", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(
      baseOptions(cwd, { env: { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" } }),
    );
    const outcome = await core.handleInput("/model openai:gpt-4.1");
    expect(outcome.kind).toBe("modelSwitched");
    if (outcome.kind === "modelSwitched") {
      expect(outcome.info).toContain("openai:gpt-4.1");
      expect(outcome.info).toContain("window");
    }
    await core.close();
  });

  it("surfaces missing-key errors from /model as handled info, not throws", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    const outcome = await core.handleInput("/model openai:gpt-4.1");
    expect(outcome.kind).toBe("handled");
    if (outcome.kind === "handled" && outcome.info !== undefined) {
      expect(outcome.info).toContain("OPENAI_API_KEY");
    } else {
      expect.unreachable("expected handled outcome with info");
    }
    await core.close();
  });

  it("quits on /exit", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    expect((await core.handleInput("/exit")).kind).toBe("quit");
    await core.close();
  });

  it("treats empty input as a no-op", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    const outcome = await core.handleInput("   ");
    expect(outcome.kind).toBe("handled");
    if (outcome.kind === "handled") {
      expect(outcome.info).toBeUndefined();
    }
    await core.close();
  });

  it("providerModels returns curated fallback models when live fetch fails", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    const result = await core.providerModels({
      id: "google",
      name: "Google Gemini",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      keyUrl: "",
      exampleModels: [],
    });
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.some((m) => m.id === "gemini-2.5-pro")).toBe(true);
    await core.close();
  });
});

describe("ChatCore turns", () => {
  it("runs a mock-model turn end to end and reports usage + context", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));

    const events: string[] = [];
    core.events.onAny((event) => events.push(event.type));

    const outcome = await core.handleInput("say hello");
    expect(outcome.kind).toBe("turn");
    if (outcome.kind === "turn") {
      expect(outcome.result.stopReason).toBe("stop");
      expect(outcome.result.error).toBe(false);
      expect(outcome.result.summary).toContain("1 step");
      expect(outcome.result.summary).toContain("in /");
      expect(outcome.result.summary).toContain("stop");
      expect(typeof outcome.result.contextPct).toBe("number");
    }

    // Engine events flowed through the shared bus (renderers subscribe here).
    expect(events).toContain("run:start");
    expect(events).toContain("text:delta");
    expect(events).toContain("done");
    await core.close();
  });

  it("appends the exchange to the session transcript", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd));
    await core.handleInput("hello again");
    const boot = core.boot();
    const raw = readdirSync(join(cwd, ".harness", "sessions"));
    expect(raw.length).toBe(1);
    expect(boot.sessionPath.endsWith(raw[0] ?? "")).toBe(true);
    await core.close();
  });

  it("denies tool calls by default when no asker is configured (safe default)", async () => {
    const cwd = tempDir();
    const { write_file } = (await import("@harness/tools")).tools;
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-1", modelId: "mock-model" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "nope.txt", content: "should not exist" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(10, 5),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-2", modelId: "mock-model" },
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: "cannot write" },
              { type: "text-end", id: "text-2" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(15, 5),
              },
            ],
          }),
        },
      ],
    });

    const core = await ChatCore.create(
      baseOptions(cwd, { modelOverride: model, registryOverride: { write_file } }),
    );
    const outcome = await core.handleInput("write a file");
    expect(outcome.kind).toBe("turn");
    if (outcome.kind === "turn") {
      expect(outcome.result.stopReason).toBe("stop");
    }
    // The write never happened — no asker, no approval.
    expect(existsSync(join(cwd, "nope.txt"))).toBe(false);
    await core.close();
  });

  it("routes permission asks through the injected onAsk callback", async () => {
    const cwd = tempDir();
    const { write_file } = (await import("@harness/tools")).tools;
    const asks: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-1", modelId: "mock-model" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "yes.txt", content: "approved" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(10, 5),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-2", modelId: "mock-model" },
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: "wrote it" },
              { type: "text-end", id: "text-2" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(15, 5),
              },
            ],
          }),
        },
      ],
    });

    const core = await ChatCore.create(
      baseOptions(cwd, {
        modelOverride: model,
        registryOverride: { write_file },
        onAsk: (request) => {
          asks.push(request.tool);
          return { action: "always" };
        },
      }),
    );
    const outcome = await core.handleInput("write the file");
    if (outcome.kind === "turn") {
      expect(outcome.result.stopReason).toBe("stop");
    } else {
      expect.unreachable("expected a turn outcome");
    }
    expect(asks).toEqual(["write_file"]);
    expect(existsSync(join(cwd, "yes.txt"))).toBe(true);
    await core.close();
  });

  it("safely ignores core.abort() when no run is active", async () => {
    const cwd = tempDir();
    const core = await ChatCore.create(baseOptions(cwd, { modelOverride: textModel("hi") }));
    expect(() => core.abort()).not.toThrow();
    await core.close();
  });

  it("prunes unclosed messages with resumableMessages when a turn is aborted", async () => {
    const cwd = tempDir();
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            initialDelayInMs: 100,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "resp-1", modelId: "mock-model" },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "working on it" },
            ],
          }),
        },
      ],
    });

    const core = await ChatCore.create(baseOptions(cwd, { modelOverride: model }));
    setTimeout(() => core.abort(), 20);
    const outcome = await core.handleInput("will be aborted");
    if (outcome.kind === "turn") {
      expect(outcome.result.stopReason).toBe("aborted");
    } else {
      expect.unreachable("expected turn outcome");
    }
    // Dangling unclosed prompt is dropped by resumableMessages
    expect(core.boot().replayedMessages).toBe(0);
    expect(loadResumableSession(core.boot().sessionPath)).toBeUndefined();
    await core.close();
  });
});
