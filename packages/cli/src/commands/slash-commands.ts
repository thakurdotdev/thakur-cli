/**
 * The slash-command registry — one source of truth for every surface that
 * shows or completes commands:
 *
 *   TUI     -> the `/` autocomplete menu (surface "tui" sees everything)
 *   plain   -> readline Tab completion (surface "all" only)
 *   /help   -> the generated command list (surface "all" only)
 *
 * Pure data + a pure filter, so tests cover every consumer at once.
 */

export type SlashSurface = "all" | "tui";

export interface SlashCommand {
  /** Including the leading slash, e.g. "/models". */
  name: string;
  /** Argument hint when the command takes one, e.g. "<provider:model>". */
  args?: string;
  description: string;
  /**
   * True when pressing Enter on the highlighted entry in the TUI menu should
   * run the command immediately (argless commands). Args-taking commands are
   * filled into the input instead so the user can finish typing them.
   */
  executeOnPick: boolean;
  /** "tui" commands only exist in the full-screen app (they need live UI). */
  surface: SlashSurface;
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    name: "/help",
    description: "show every command and a few tips",
    executeOnPick: true,
    surface: "all",
  },
  {
    name: "/models",
    description: "pick a model from live provider catalogs (searchable, free models badged)",
    executeOnPick: true,
    surface: "all",
  },
  {
    name: "/model",
    args: "<provider:model>",
    description: "switch model directly, e.g. /model openai:gpt-4.1",
    executeOnPick: false,
    surface: "all",
  },
  {
    name: "/connect",
    description: "store a provider API key (~/.harness/auth.json) — no restart needed",
    executeOnPick: true,
    surface: "all",
  },
  {
    name: "/clear",
    description: "clear the transcript and start the session view fresh",
    executeOnPick: true,
    surface: "tui",
  },
  {
    name: "/exit",
    description: "quit the session (transcript stays on disk)",
    executeOnPick: true,
    surface: "all",
  },
];

/**
 * Commands visible on a surface, optionally filtered by a partial token.
 * `query` may include the leading slash ("/mo", "mo") - matching is
 * prefix-first on the name, then substring, so "/m" finds /models and
 * /model while "/conn" finds /connect. Order follows the registry.
 */
export function filterSlashCommands(
  query: string,
  surface: SlashSurface = "all",
): Array<SlashCommand> {
  const token = query.replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.filter((command) => {
    if (surface === "all" && command.surface !== "all") {
      return false;
    }
    const name = command.name.slice(1).toLowerCase();
    if (token.length === 0) {
      return true;
    }
    return name.startsWith(token) || name.includes(token);
  });
}

/** "/model <provider:model>" — display label with the args hint, if any. */
export function slashCommandLabel(command: SlashCommand): string {
  return command.args === undefined ? command.name : `${command.name} ${command.args}`;
}

/** Fill text for picking/finalizing a command: args-taking commands append a space. */
export function slashCommandFill(command: SlashCommand): string {
  return command.args === undefined ? command.name : `${command.name} `;
}

/** The /help body shared by every frontend (registry order, aligned). */
export function renderSlashHelp(): string {
  const commands = SLASH_COMMANDS.filter((command) => command.surface === "all");
  const rows = commands.map((command) => ({
    label: slashCommandLabel(command),
    description: command.description,
  }));
  const width = Math.max(...rows.map((row) => row.label.length));
  return [
    "Commands:",
    ...rows.map((row) => `  ${row.label.padEnd(width + 2)}${row.description}`),
    "  Everything else is a task for the agent — just type it.",
  ].join("\n");
}
