import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessError } from "@harness/core";
import { loadConfig } from "../src/config/loader.ts";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";

const dirs: string[] = [];
function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig precedence", () => {
  it("returns defaults when nothing is configured", () => {
    const project = tempTree();
    const config = loadConfig({ env: {}, homeDir: project, projectDir: project });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("applies user config over defaults", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({ model: "openrouter:openai/gpt-4.1-mini", maxSteps: 10 }),
      "utf8",
    );
    const config = loadConfig({ env: {}, homeDir: home, projectDir: project });
    expect(config.model).toBe("openrouter:openai/gpt-4.1-mini");
    expect(config.maxSteps).toBe(10);
    expect(config.truncation.toolOutputMaxChars).toBe(DEFAULT_CONFIG.truncation.toolOutputMaxChars);
  });

  it("project config overrides user config", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({ model: "user/model" }),
      "utf8",
    );
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({ model: "project/model" }),
      "utf8",
    );
    expect(loadConfig({ env: {}, homeDir: home, projectDir: project }).model).toBe("project/model");
  });

  it("environment overrides project config", () => {
    const project = tempTree();
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({ model: "project/model" }),
      "utf8",
    );
    const config = loadConfig({
      env: { HARNESS_MODEL: "env/model" },
      homeDir: project,
      projectDir: project,
    });
    expect(config.model).toBe("env/model");
  });

  it("flags override everything", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({ model: "user/model" }),
      "utf8",
    );
    const config = loadConfig({
      env: { HARNESS_MODEL: "env/model" },
      homeDir: home,
      projectDir: project,
      flags: { model: "flag/model" },
    });
    expect(config.model).toBe("flag/model");
  });

  it("merges nested sections without dropping unspecified keys", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({ permissions: { autoAllowReads: false } }),
      "utf8",
    );
    const config = loadConfig({
      env: {},
      homeDir: home,
      projectDir: project,
      flags: { truncation: { toolOutputMaxChars: 5_000 } },
    });
    expect(config.permissions.autoAllowReads).toBe(false);
    expect(config.truncation.toolOutputMaxChars).toBe(5_000);
  });

  it("fails fast on invalid JSON with a HarnessError", () => {
    const project = tempTree();
    writeFileSync(join(project, ".harness.json"), "{ not json", "utf8");
    expect(() => loadConfig({ env: {}, homeDir: project, projectDir: project })).toThrowError(
      HarnessError,
    );
  });

  it("fails fast on invalid config shapes with issue details", () => {
    const project = tempTree();
    writeFileSync(join(project, ".harness.json"), JSON.stringify({ maxSteps: 0 }), "utf8");
    try {
      loadConfig({ env: {}, homeDir: project, projectDir: project });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).hint).toContain("maxSteps");
    }
  });
});

describe("loadConfig permission rules", () => {
  it("defaults allow/deny to empty arrays", () => {
    const project = tempTree();
    const config = loadConfig({ env: {}, homeDir: project, projectDir: project });
    expect(config.permissions.allow).toEqual([]);
    expect(config.permissions.deny).toEqual([]);
  });

  it("resolves allow/deny rule lists from project config", () => {
    const project = tempTree();
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({
        permissions: {
          allow: ["bash:npm *", "bash:git status"],
          deny: ["read_file:.secrets/**"],
        },
      }),
      "utf8",
    );
    const config = loadConfig({ env: {}, homeDir: project, projectDir: project });
    expect(config.permissions.allow).toEqual(["bash:npm *", "bash:git status"]);
    expect(config.permissions.deny).toEqual(["read_file:.secrets/**"]);
  });

  it("fails fast naming an invalid rule", () => {
    const project = tempTree();
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({ permissions: { allow: ["bash:"] } }),
      "utf8",
    );
    try {
      loadConfig({ env: {}, homeDir: project, projectDir: project });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as Error).message).toContain('Invalid permission rule: "bash:"');
    }
  });
});

describe("loadConfig context & reliability keys", () => {
  it("resolves compaction/retry/budget defaults", () => {
    const project = tempTree();
    const config = loadConfig({ env: {}, homeDir: project, projectDir: project });
    expect(config.compaction).toEqual({ enabled: true, triggerRatio: 0.8, keepRecentMessages: 6 });
    expect(config.retries).toEqual({ maxAttempts: 3 });
    expect(config.maxTotalTokens).toBeUndefined();
    expect(config.contextWindow).toBeUndefined();
  });

  it("merges context & reliability keys across layers", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({
        compaction: { enabled: false },
        retries: { maxAttempts: 1 },
      }),
      "utf8",
    );
    const config = loadConfig({
      env: {},
      homeDir: home,
      projectDir: project,
      flags: {
        compaction: { keepRecentMessages: 10 },
        maxTotalTokens: 120_000,
        contextWindow: 32_000,
      },
    });
    expect(config.compaction.enabled).toBe(false);
    expect(config.compaction.keepRecentMessages).toBe(10);
    expect(config.compaction.triggerRatio).toBe(0.8);
    expect(config.retries.maxAttempts).toBe(1);
    expect(config.maxTotalTokens).toBe(120_000);
    expect(config.contextWindow).toBe(32_000);
  });

  it("rejects out-of-range compaction and retry values", () => {
    const project = tempTree();
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({ retries: { maxAttempts: 99 } }),
      "utf8",
    );
    try {
      loadConfig({ env: {}, homeDir: project, projectDir: project });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
    }
  });
});

describe("mcpServers configuration", () => {
  it("defaults to an empty server registry", () => {
    const project = tempTree();
    const config = loadConfig({ env: {}, homeDir: project, projectDir: project });
    expect(config.mcpServers).toEqual({});
  });

  it("merges per-server across layers (project adds one, user keeps the other)", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({
        mcpServers: { fs: { command: "npx", args: ["-y", "mcp-server-fs"] } },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({
        mcpServers: { db: { command: "bun", args: ["run", "db-server.ts"] } },
      }),
      "utf8",
    );
    const config = loadConfig({ env: {}, homeDir: home, projectDir: project });
    expect(Object.keys(config.mcpServers).sort()).toEqual(["db", "fs"]);
    expect(config.mcpServers["fs"]).toEqual({
      command: "npx",
      args: ["-y", "mcp-server-fs"],
    });
  });

  it("lets a higher-precedence layer replace a whole server definition", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(
      join(home, ".harness", "config.json"),
      JSON.stringify({
        mcpServers: { fs: { command: "npx", args: ["-y", "mcp-server-fs"] } },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({
        mcpServers: { fs: { command: "bunx" } },
      }),
      "utf8",
    );
    const config = loadConfig({ env: {}, homeDir: home, projectDir: project });
    // Server definitions replace wholesale — predictable override semantics
    // (other servers defined only at the lower layer are preserved).
    expect(config.mcpServers["fs"]).toEqual({ command: "bunx" });
  });

  it("rejects server names with unsafe characters", () => {
    const project = tempTree();
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({
        mcpServers: { "bad name": { command: "npx" } },
      }),
      "utf8",
    );
    expect(() => loadConfig({ env: {}, homeDir: project, projectDir: project })).toThrow(
      HarnessError,
    );
  });

  it("rejects servers without a command", () => {
    const project = tempTree();
    writeFileSync(
      join(project, ".harness.json"),
      JSON.stringify({ mcpServers: { fs: {} } }),
      "utf8",
    );
    expect(() => loadConfig({ env: {}, homeDir: project, projectDir: project })).toThrow(
      HarnessError,
    );
  });
});

describe("ui option", () => {
  it("defaults to auto", () => {
    const project = tempTree();
    const config = loadConfig({ env: {}, homeDir: project, projectDir: project });
    expect(config.ui).toBe("auto");
  });

  it("accepts tui and plain from any layer", () => {
    const home = tempTree();
    const project = tempTree();
    mkdirSync(join(home, ".harness"));
    writeFileSync(join(home, ".harness", "config.json"), JSON.stringify({ ui: "tui" }), "utf8");
    writeFileSync(join(project, ".harness.json"), JSON.stringify({ ui: "plain" }), "utf8");
    // Project layer wins.
    expect(loadConfig({ env: {}, homeDir: home, projectDir: project }).ui).toBe("plain");
    // Flags win over everything.
    expect(
      loadConfig({ env: {}, homeDir: home, projectDir: project, flags: { ui: "tui" } }).ui,
    ).toBe("tui");
  });

  it("rejects unknown ui values", () => {
    const project = tempTree();
    writeFileSync(join(project, ".harness.json"), JSON.stringify({ ui: "fancy" }), "utf8");
    expect(() => loadConfig({ env: {}, homeDir: project, projectDir: project })).toThrow(
      HarnessError,
    );
  });
});
