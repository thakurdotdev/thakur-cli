import { describe, expect, it } from "vitest";
import { ReadTracker } from "@harness/core";

const STAT = (mtimeMs: number, size: number) => ({ mtimeMs, size });

describe("ReadTracker", () => {
  it("refuses mutation before the file was read", () => {
    const tracker = new ReadTracker();
    const result = tracker.check("/repo/src/a.ts", STAT(1, 10));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("has not been read");
      expect(result.hint).toContain("read_file");
    }
  });

  it("allows mutation after the file was read in the same state", () => {
    const tracker = new ReadTracker();
    tracker.markRead("/repo/src/a.ts", STAT(100, 42));
    expect(tracker.check("/repo/src/a.ts", STAT(100, 42)).ok).toBe(true);
  });

  it("refuses mutation when the file changed on disk after being read", () => {
    const tracker = new ReadTracker();
    tracker.markRead("/repo/src/a.ts", STAT(100, 42));
    const result = tracker.check("/repo/src/a.ts", STAT(200, 42));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("changed since it was last read");
    }
  });

  it("treats harness-side mutation as fresh state", () => {
    const tracker = new ReadTracker();
    tracker.markRead("/repo/src/a.ts", STAT(100, 42));
    tracker.markMutated("/repo/src/a.ts", STAT(300, 50));
    expect(tracker.check("/repo/src/a.ts", STAT(300, 50)).ok).toBe(true);
  });

  it("wasRead reflects tracker state", () => {
    const tracker = new ReadTracker();
    expect(tracker.wasRead("/repo/x")).toBe(false);
    tracker.markRead("/repo/x", STAT(1, 1));
    expect(tracker.wasRead("/repo/x")).toBe(true);
  });
});
