import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authFilePath,
  clearProviderKey,
  envWithAuthKeys,
  loadAuthStore,
  saveProviderKey,
} from "../src/config/auth.ts";

/** The credential store: durable keys that survive double-clicks. */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "harness-auth-"));
}

describe("auth store", () => {
  it("starts empty and tolerates missing files", () => {
    const home = tempHome();
    try {
      expect(loadAuthStore(home).keys).toEqual({});
      expect(existsSync(authFilePath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saves, reloads and upserts keys; ignores unknown providers", () => {
    const home = tempHome();
    try {
      saveProviderKey("openrouter", "sk-or-v1-abc", home);
      saveProviderKey("openai", "sk-openai", home);
      saveProviderKey("openrouter", "sk-or-v1-xyz", home); // upsert
      expect(loadAuthStore(home).keys).toEqual({
        openrouter: "sk-or-v1-xyz",
        openai: "sk-openai",
      });

      expect(() => saveProviderKey("not-a-provider", "x", home)).toThrow(/Unknown provider/);
      expect(() => saveProviderKey("openai", "   ", home)).toThrow(/empty/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats a corrupt store as empty instead of bricking the CLI", () => {
    const home = tempHome();
    try {
      const path = authFilePath(home);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "{ not json", "utf8");
      expect(loadAuthStore(home).keys).toEqual({});
      // Saving repairs the file.
      saveProviderKey("openrouter", "sk-or-fix", home);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ openrouter: "sk-or-fix" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("filters out junk entries when reading", () => {
    const home = tempHome();
    try {
      const path = authFilePath(home);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ openrouter: "sk-ok", bogus_provider: "x", openai: 42, anthropic: "" }),
        "utf8",
      );
      expect(loadAuthStore(home).keys).toEqual({ openrouter: "sk-ok" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clearProviderKey removes one entry and ignores absent files", () => {
    const home = tempHome();
    try {
      clearProviderKey("openai", home); // no file yet — no throw
      saveProviderKey("openrouter", "sk-a", home);
      saveProviderKey("openai", "sk-b", home);
      clearProviderKey("openai", home);
      expect(loadAuthStore(home).keys).toEqual({ openrouter: "sk-a" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("envWithAuthKeys", () => {
  it("fills missing env vars from the store without overriding them", () => {
    const home = tempHome();
    try {
      saveProviderKey("openrouter", "sk-stored", home);
      saveProviderKey("openai", "sk-stored-openai", home);

      const merged = envWithAuthKeys({ OPENROUTER_API_KEY: "sk-env-wins" }, home);
      expect(merged["OPENROUTER_API_KEY"]).toBe("sk-env-wins");
      expect(merged["OPENAI_API_KEY"]).toBe("sk-stored-openai");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats blank env values as missing", () => {
    const home = tempHome();
    try {
      saveProviderKey("anthropic", "sk-ant-stored", home);
      const merged = envWithAuthKeys({ ANTHROPIC_API_KEY: "   " }, home);
      expect(merged["ANTHROPIC_API_KEY"]).toBe("sk-ant-stored");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mirrors a stored google key under both spellings", () => {
    const home = tempHome();
    try {
      saveProviderKey("google", "g-key", home);
      const merged = envWithAuthKeys({}, home);
      expect(merged["GOOGLE_GENERATIVE_AI_API_KEY"]).toBe("g-key");
      expect(merged["GOOGLE_API_KEY"]).toBe("g-key");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("env google spelling wins over the store without duplicating", () => {
    const home = tempHome();
    try {
      saveProviderKey("google", "g-stored", home);
      const merged = envWithAuthKeys({ GOOGLE_API_KEY: "g-env" }, home);
      expect(merged["GOOGLE_API_KEY"]).toBe("g-env");
      expect(merged["GOOGLE_GENERATIVE_AI_API_KEY"]).toBe("g-env");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
