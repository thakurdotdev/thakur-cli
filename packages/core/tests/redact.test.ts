import { describe, expect, it } from "vitest";
import { collectSecrets, redactSecrets, REDACTED_MARKER } from "@harness/core";

describe("collectSecrets", () => {
  it("picks up values of secret-looking variable names", () => {
    const secrets = collectSecrets({
      OPENROUTER_API_KEY: "sk-or-v1-abcdef123456",
      GITHUB_TOKEN: "ghp_1234567890abcdef",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI",
      HARNESS_MODEL: "openrouter:anthropic/claude-sonnet-4.5",
    });
    expect(secrets).toContain("sk-or-v1-abcdef123456");
    expect(secrets).toContain("ghp_1234567890abcdef");
    expect(secrets).toContain("wJalrXUtnFEMI");
    expect(secrets).not.toContain("openrouter:anthropic/claude-sonnet-4.5");
  });

  it("ignores short values, undefined values, and non-matching names", () => {
    const secrets = collectSecrets({
      SHORT_KEY: "abc",
      UNRELATED: "definitely-not-a-secret-value",
      EMPTY_TOKEN: undefined,
    });
    expect(secrets).toEqual([]);
  });

  it("supports custom name patterns and ignore lists", () => {
    const secrets = collectSecrets(
      {
        PUBLIC_KEY: "public-value-123",
        PRIVATE_TOKEN: "private-value-456",
      },
      { ignoreNames: new Set(["PUBLIC_KEY"]) },
    );
    expect(secrets).toContain("private-value-456");
    expect(secrets).not.toContain("public-value-123");
  });

  it("deduplicates identical values", () => {
    const secrets = collectSecrets({
      A_TOKEN: "same-value-123",
      B_TOKEN: "same-value-123",
    });
    expect(secrets).toEqual(["same-value-123"]);
  });
});

describe("redactSecrets", () => {
  const secrets = ["sk-or-v1-abcdef123456", "ghp_1234567890abcdef"];

  it("replaces every occurrence with the marker", () => {
    const output = redactSecrets(
      "key=sk-or-v1-abcdef123456\nkey2=sk-or-v1-abcdef123456 token=ghp_1234567890abcdef",
      secrets,
    );
    expect(output).toBe(`key=${REDACTED_MARKER}\nkey2=${REDACTED_MARKER} token=${REDACTED_MARKER}`);
  });

  it("leaves text without secrets untouched", () => {
    const text = "harmless build output\nexit code 0";
    expect(redactSecrets(text, secrets)).toBe(text);
  });

  it("handles empty candidate lists fast", () => {
    expect(redactSecrets("anything", [])).toBe("anything");
  });
});
