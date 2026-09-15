/**
 * Pure editing model for the TUI input box — readline semantics without a
 * readline: an explicit cursor into the value, so the blinking block cursor
 * sits exactly where the user is editing (start of the placeholder when
 * empty, mid-text while fixing a typo) instead of always trailing the line.
 *
 * All functions are total: every index is clamped, so key handling can call
 * them blindly. Exported for direct unit tests.
 */

export interface InputEdit {
  value: string;
  /** Cursor offset in code units, always within [0, value.length]. */
  cursor: number;
}

export const emptyEdit: InputEdit = { value: "", cursor: 0 };

function clamp(value: string, cursor: number): number {
  return Math.max(0, Math.min(cursor, value.length));
}

/** Insert text at the cursor (multi-character pastes land wholesale). */
export function insertText(edit: InputEdit, text: string): InputEdit {
  if (text.length === 0) {
    return edit;
  }
  const cursor = clamp(edit.value, edit.cursor);
  const value = edit.value.slice(0, cursor) + text + edit.value.slice(cursor);
  return { value, cursor: cursor + text.length };
}

/** Remove the code unit before the cursor (backspace); no-op at the start. */
export function backspace(edit: InputEdit): InputEdit {
  if (edit.cursor <= 0) {
    return edit;
  }
  const cursor = clamp(edit.value, edit.cursor);
  const value = edit.value.slice(0, cursor - 1) + edit.value.slice(cursor);
  return { value, cursor: cursor - 1 };
}

/** Remove the code unit at the cursor (Delete key); no-op at the end. */
export function deleteAtCursor(edit: InputEdit): InputEdit {
  const cursor = clamp(edit.value, edit.cursor);
  if (cursor >= edit.value.length) {
    return edit;
  }
  const value = edit.value.slice(0, cursor) + edit.value.slice(cursor + 1);
  return { value, cursor };
}

/** Move the cursor by one code unit; clamped at both ends. */
export function moveCursor(edit: InputEdit, delta: -1 | 1): InputEdit {
  const cursor = clamp(edit.value, edit.cursor + delta);
  return { value: edit.value, cursor };
}

export function cursorToStart(edit: InputEdit): InputEdit {
  return { value: edit.value, cursor: 0 };
}

export function cursorToEnd(edit: InputEdit): InputEdit {
  return { value: edit.value, cursor: edit.value.length };
}

/** Ctrl+U — kill everything before the cursor (classic readline). */
export function killToStart(edit: InputEdit): InputEdit {
  const cursor = clamp(edit.value, edit.cursor);
  return { value: edit.value.slice(cursor), cursor: 0 };
}

/** Ctrl+K — kill everything from the cursor to the end. */
export function killToEnd(edit: InputEdit): InputEdit {
  const cursor = clamp(edit.value, edit.cursor);
  return { value: edit.value.slice(0, cursor), cursor };
}

/** Ctrl+J — insert a literal newline (Enter still submits). */
export function insertNewline(edit: InputEdit): InputEdit {
  return insertText(edit, "\n");
}

/**
 * The `/<token>` predicate for the command menu: the whole input is one
 * token that starts with a slash (no whitespace yet). That is exactly when
 * claude-code-style completion applies.
 */
export function isSlashToken(value: string): boolean {
  return /^\/\S*$/.test(value);
}
