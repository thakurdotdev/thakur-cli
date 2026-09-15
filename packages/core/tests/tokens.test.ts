import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, estimateTokens } from "@harness/core";

describe("estimateTokens", () => {
  it("averages about four characters per token for ASCII text", () => {
    // 40 ASCII chars -> ~10 tokens (ceil, minimum-aware).
    const text = "a".repeat(40);
    expect(estimateTokens(text)).toBe(10);
  });

  it("counts CJK code points at roughly one token each", () => {
    const text = "你好世界".repeat(10); // 40 CJK chars
    expect(estimateTokens(text)).toBe(40);
  });

  it("never returns less than 1", () => {
    expect(estimateTokens("")).toBe(1);
  });

  it("rounds up partial tokens", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("estimateMessagesTokens", () => {
  it("scales with message count and content", () => {
    const short = [{ role: "user" as const, content: "hi" }];
    const long = [
      { role: "user" as const, content: "x".repeat(400) },
      { role: "assistant" as const, content: "y".repeat(400) },
    ];
    const shortEstimate = estimateMessagesTokens(short);
    const longEstimate = estimateMessagesTokens(long);
    expect(longEstimate).toBeGreaterThan(shortEstimate);
    expect(longEstimate).toBeGreaterThan(200);
  });

  it("handles array content and empty lists", () => {
    expect(estimateMessagesTokens([])).toBe(0);
    const withParts = [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hello there" }],
      },
    ];
    expect(estimateMessagesTokens(withParts)).toBeGreaterThan(1);
  });
});
