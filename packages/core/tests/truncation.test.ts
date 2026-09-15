import { describe, expect, it } from "vitest";
import { createTruncator } from "@harness/core";

describe("createTruncator", () => {
  it("returns short text unchanged", () => {
    const t = createTruncator({ maxChars: 10_000 });
    const text = "hello world";
    expect(t.truncate(text)).toBe(text);
  });

  it("truncates long text to roughly the budget with an explicit marker", () => {
    const t = createTruncator({ maxChars: 1_000 });
    const text = "x".repeat(50_000);
    const result = t.truncate(text, "bash");
    expect(result.length).toBeLessThan(1_400);
    expect(result).toContain("[output truncated in bash:");
    expect(result).toContain("50000 characters");
  });

  it("keeps both head and tail of the text", () => {
    const t = createTruncator({ maxChars: 1_000 });
    const text = `START${"m".repeat(60_000)}END`;
    const result = t.truncate(text);
    expect(result.startsWith("START")).toBe(true);
    expect(result.endsWith("END")).toBe(true);
  });

  it("reports the label in the marker", () => {
    const t = createTruncator({ maxChars: 1_000 });
    const result = t.truncate("y".repeat(9_999), "src/foo.ts");
    expect(result).toContain("in src/foo.ts");
  });
});
