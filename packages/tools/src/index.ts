import type { ToolDefinition } from "@harness/core";
import { read_file } from "./read-file.ts";
import { write_file } from "./write-file.ts";
import { edit_file } from "./edit-file.ts";
import { bash } from "./bash.ts";
import { grep } from "./grep.ts";
import { glob } from "./glob.ts";
import { list_dir } from "./list-dir.ts";

/**
 * Typed builtin tool registry.
 *
 * Adding a tool = one implementation + one entry here. `ToolName` is derived,
 * so registries stay exhaustively typed.
 */
export const tools = {
  read_file,
  write_file,
  edit_file,
  bash,
  grep,
  glob,
  list_dir,
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof tools;

export { read_file, write_file, edit_file, bash, grep, glob, list_dir };

export type { BashOutput } from "./bash.ts";
export type { WriteFileOutput } from "./write-file.ts";
export type { EditFileOutput } from "./edit-file.ts";
