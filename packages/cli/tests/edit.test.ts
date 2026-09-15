import { describe, expect, it } from "vitest";
import {
  backspace,
  cursorToEnd,
  cursorToStart,
  deleteAtCursor,
  emptyEdit,
  insertNewline,
  insertText,
  isSlashToken,
  killToEnd,
  killToStart,
  moveCursor,
} from "../src/tui/edit.ts";
import type { InputEdit } from "../src/tui/edit.ts";

/** Pure editing model behind the TUI input box — readline semantics. */

const e = (value: string, cursor: number): InputEdit => ({ value, cursor });

describe("insertText", () => {
  it("inserts at the cursor and leaves it after the inserted text", () => {
    expect(insertText(e("hello", 0), "X")).toEqual(e("Xhello", 1));
    expect(insertText(e("hello", 5), "X")).toEqual(e("helloX", 6));
    expect(insertText(e("hello", 2), "XY")).toEqual(e("heXYllo", 4));
  });

  it("multi-character paste lands wholesale at the cursor", () => {
    expect(insertText(emptyEdit, "fix the bug")).toEqual(e("fix the bug", 11));
  });

  it("clamps out-of-range cursors and ignores empty inserts", () => {
    expect(insertText(e("abc", 99), "-")).toEqual(e("abc-", 4));
    expect(insertText(e("abc", -5), "-")).toEqual(e("-abc", 1));
    expect(insertText(e("abc", 1), "")).toEqual(e("abc", 1));
  });
});

describe("backspace / deleteAtCursor", () => {
  it("backspace removes before the cursor, no-op at the start", () => {
    expect(backspace(e("hello", 5))).toEqual(e("hell", 4));
    expect(backspace(e("hello", 1))).toEqual(e("ello", 0));
    expect(backspace(e("hello", 0))).toEqual(e("hello", 0));
  });

  it("delete removes at the cursor, no-op at the end", () => {
    expect(deleteAtCursor(e("hello", 0))).toEqual(e("ello", 0));
    expect(deleteAtCursor(e("hello", 2))).toEqual(e("helo", 2));
    expect(deleteAtCursor(e("hello", 5))).toEqual(e("hello", 5));
  });
});

describe("cursor movement", () => {
  it("moveCursor steps and clamps at both ends", () => {
    expect(moveCursor(e("abc", 1), -1)).toEqual(e("abc", 0));
    expect(moveCursor(e("abc", 0), -1)).toEqual(e("abc", 0));
    expect(moveCursor(e("abc", 1), 1)).toEqual(e("abc", 2));
    expect(moveCursor(e("abc", 3), 1)).toEqual(e("abc", 3));
  });

  it("home/end jump to the boundaries", () => {
    expect(cursorToStart(e("abc", 2))).toEqual(e("abc", 0));
    expect(cursorToEnd(e("abc", 1))).toEqual(e("abc", 3));
  });
});

describe("kill operations", () => {
  it("ctrl+u kills to the start, ctrl+k kills to the end", () => {
    expect(killToStart(e("hello world", 6))).toEqual(e("world", 0));
    expect(killToEnd(e("hello world", 5))).toEqual(e("hello", 5));
  });
});

describe("insertNewline", () => {
  it("ctrl+j embeds a newline (enter still submits)", () => {
    expect(insertNewline(e("ab", 2))).toEqual(e("ab\n", 3));
  });
});

describe("isSlashToken", () => {
  it("true only for a lone leading-slash token", () => {
    expect(isSlashToken("")).toBe(false);
    expect(isSlashToken("/")).toBe(true);
    expect(isSlashToken("/mo")).toBe(true);
    expect(isSlashToken("/MODELS")).toBe(true);
    expect(isSlashToken("/model openai:gpt")).toBe(false); // args started — menu closes
    expect(isSlashToken("hello")).toBe(false);
    expect(isSlashToken("a/b")).toBe(false);
  });
});
