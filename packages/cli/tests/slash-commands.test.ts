import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  renderSlashHelp,
  slashCommandFill,
  slashCommandLabel,
} from "../src/commands/slash-commands.ts";

/** The shared slash-command registry — TUI menu, plain completer and /help. */

describe("registry", () => {
  it("has unique names with leading slashes and non-empty descriptions", () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of SLASH_COMMANDS) {
      expect(command.name.startsWith("/")).toBe(true);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.executeOnPick).toBe(command.args === undefined);
    }
  });

  it("covers the core command set", () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining(["/help", "/models", "/model", "/connect", "/exit", "/clear"]),
    );
  });
});

describe("filterSlashCommands", () => {
  it("empty query lists every command for the surface", () => {
    const all = filterSlashCommands("", "all").map((command) => command.name);
    expect(all).toEqual(["/help", "/models", "/model", "/connect", "/exit"]);
    const tui = filterSlashCommands("", "tui").map((command) => command.name);
    expect(tui).toContain("/clear");
  });

  it("prefix and substring matching on the name", () => {
    const mo = filterSlashCommands("/mo", "all").map((command) => command.name);
    expect(mo).toEqual(["/models", "/model"]);
    const conn = filterSlashCommands("/conn", "all").map((command) => command.name);
    expect(conn).toEqual(["/connect"]);
    // Substring fallback: "del" matches /models and /model (both contain it).
    const del = filterSlashCommands("/del", "all").map((command) => command.name);
    expect(del).toEqual(["/models", "/model"]);
  });

  it("works with or without the leading slash, case-insensitively", () => {
    expect(filterSlashCommands("HELP", "all").map((c) => c.name)).toEqual(["/help"]);
  });

  it("no matches for unknown prefixes", () => {
    expect(filterSlashCommands("/zzz", "all")).toEqual([]);
  });
});

describe("labels / fills / help", () => {
  it("args-taking commands label with the hint and fill with a trailing space", () => {
    const model = SLASH_COMMANDS.find((command) => command.name === "/model");
    expect(model).toBeDefined();
    if (model !== undefined) {
      expect(slashCommandLabel(model)).toBe("/model <provider:model>");
      expect(slashCommandFill(model)).toBe("/model ");
    }
    const exit = SLASH_COMMANDS.find((command) => command.name === "/exit");
    expect(exit).toBeDefined();
    if (exit !== undefined) {
      expect(slashCommandFill(exit)).toBe("/exit");
    }
  });

  it("/help body lists every all-surface command aligned", () => {
    const help = renderSlashHelp();
    expect(help.startsWith("Commands:")).toBe(true);
    expect(help).toContain("/models");
    expect(help).toContain("/model <provider:model>");
    expect(help).not.toContain("/clear"); // tui-only command stays out of shared help
  });
});
