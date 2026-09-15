import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import {
  askChoices,
  CommandMenu,
  ConnectDialog,
  ContextRow,
  Hero,
  InputBox,
  LiveArea,
  MarkdownText,
  ModelPicker,
  PermissionDialog,
  rotate,
  ThoughtView,
  Transcript,
  TranscriptItemView,
} from "../src/tui/components.tsx";
import { TuiApp } from "../src/tui/App.tsx";
import { TuiBridge } from "../src/tui/bridge.ts";
import { filterSlashCommands } from "../src/commands/slash-commands.ts";
import type { TranscriptItem } from "../src/tui/transcript.ts";
import type { PickerProviderGroup } from "../src/tui/picker.ts";

/**
 * Ink component frame tests via renderToString — synchronous, no terminal,
 * no streams. Assertions target plain substrings that survive ANSI styling.
 */

const stripAnsi = (frame: string): string =>
  frame
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type ItemInput = DistributiveOmit<TranscriptItem, "id">;

let itemId = 0;
function item(next: ItemInput): TranscriptItem {
  itemId += 1;
  return { ...next, id: itemId } as TranscriptItem;
}

describe("transcript item frames", () => {
  it("renders user prompts with the ❯ marker", () => {
    const frame = renderToString(
      <TranscriptItemView item={item({ kind: "user", text: "fix the bug" })} />,
    );
    expect(frame).toContain("❯ fix the bug");
  });

  it("renders assistant text verbatim", () => {
    const frame = renderToString(
      <TranscriptItemView item={item({ kind: "assistant", text: "Done — tests pass." })} />,
    );
    expect(frame).toContain("Done — tests pass.");
  });

  it("renders a pending tool call without a result line", () => {
    const frame = renderToString(
      <TranscriptItemView
        item={item({
          kind: "tool",
          name: "bash",
          display: "Bash(ls -la)",
          ok: undefined,
          summary: "",
          ms: 0,
        })}
      />,
    );
    expect(frame).toContain("Bash(ls -la)");
    expect(frame).toContain("⎿ …");
  });

  it("renders an ok tool result with summary and duration", () => {
    const frame = renderToString(
      <TranscriptItemView
        item={item({
          kind: "tool",
          name: "bash",
          display: "Bash(ls)",
          ok: true,
          summary: "3 lines",
          ms: 12,
        })}
      />,
    );
    expect(frame).toContain("⎿ 3 lines (12ms)");
  });

  it("renders a failing tool result with the error marker", () => {
    const frame = renderToString(
      <TranscriptItemView
        item={item({
          kind: "tool",
          name: "bash",
          display: "Bash(ls)",
          ok: false,
          summary: "exit code 1",
          ms: 4,
        })}
      />,
    );
    expect(frame).toContain("⎿ ✗ exit code 1");
  });

  it("renders errors with hint, compaction with delta, info and summary lines", () => {
    const error = renderToString(
      <TranscriptItemView
        item={item({
          kind: "error",
          message: "context window exceeded",
          hint: "history compacted",
        })}
      />,
    );
    expect(error).toContain("✗ context window exceeded");
    expect(error).toContain("history compacted");

    const compaction = renderToString(
      <TranscriptItemView item={item({ kind: "compaction", before: 200_000, after: 80_000 })} />,
    );
    expect(compaction).toContain("⟳ compacted context");
    expect(compaction).toContain("200k");
    expect(compaction).toContain("80k");

    const info = renderToString(
      <TranscriptItemView item={item({ kind: "info", text: "model switched" })} />,
    );
    expect(info).toContain("model switched");

    const summary = renderToString(
      <TranscriptItemView item={item({ kind: "summary", text: "1 step · stop" })} />,
    );
    expect(summary).toContain("▪ 1 step · stop");
  });
});

describe("transcript blocks", () => {
  it("renders all items through <Static>", () => {
    const frame = renderToString(
      <Transcript
        items={[
          item({ kind: "user", text: "hello" }),
          item({ kind: "assistant", text: "hi back" }),
          item({ kind: "summary", text: "1 step" }),
        ]}
      />,
    );
    expect(frame).toContain("❯ hello");
    expect(frame).toContain("hi back");
    expect(frame).toContain("▪ 1 step");
  });

  it("renders the live area only when there is something live", () => {
    expect(renderToString(<LiveArea text="" busy={false} toolName={undefined} />)).toBe("");
    const streaming = renderToString(
      <LiveArea text="partial li" busy={false} toolName={undefined} />,
    );
    expect(streaming).toContain("partial li");
    const running = renderToString(<LiveArea text="" busy={true} toolName="bash" />);
    expect(running).toContain("running bash…");
  });
});

describe("permission dialog", () => {
  it("lists the three choices and highlights the selection", () => {
    const frame = renderToString(
      <PermissionDialog
        request={{ tool: "bash", risk: "execute", input: { command: "rm -rf /" } }}
        selected={0}
      />,
    );
    expect(frame).toContain("Permission required — bash (execute)");
    expect(frame).toContain("Allow once");
    expect(frame).toContain("Always allow bash in this session");
    expect(frame).toContain("Deny");
    expect(frame).toContain("❯ Allow once");
    expect(frame).toContain("command");
  });

  it("moves the selection marker with the selected index", () => {
    const frame = renderToString(
      <PermissionDialog request={{ tool: "bash", risk: "execute", input: {} }} selected={2} />,
    );
    expect(frame).toContain("❯ Deny");
  });

  it("askChoices carries the right decisions", () => {
    const choices = askChoices("bash");
    expect(choices.map((choice) => choice.decision.action)).toEqual(["allow", "always", "deny"]);
  });

  it("rotate wraps in both directions", () => {
    expect(rotate(0, -1, 3)).toBe(2);
    expect(rotate(2, 1, 3)).toBe(0);
    expect(rotate(1, 0, 3)).toBe(1);
    expect(rotate(0, 1, 0)).toBe(0);
  });
});

describe("input box, context row, hero", () => {
  it("renders the bordered input with placeholder when empty", () => {
    const frame = renderToString(<InputBox value="" disabled={false} busy={false} />);
    expect(frame).toContain("❯");
    expect(frame).toContain("Ask anything…");
  });

  it("renders typed value over the placeholder", () => {
    const frame = renderToString(<InputBox value="fix the" disabled={false} busy={false} />);
    expect(frame).toContain("fix the");
    expect(frame).not.toContain("Ask anything…");
  });

  it("empty input: the cursor block sits at the START of the placeholder", () => {
    // The cursor (inverse space) must render between the ❯ prompt and the
    // placeholder text — never trailing it.
    const plain = stripAnsi(renderToString(<InputBox value="" disabled={false} busy={false} />));
    const promptEnd = plain.indexOf("❯");
    const placeholderStart = plain.indexOf("Ask anything…");
    expect(promptEnd).toBeGreaterThanOrEqual(0);
    expect(placeholderStart).toBeGreaterThan(promptEnd);
    expect(plain.slice(promptEnd + 1, placeholderStart).trim()).toBe("");
  });

  it("mid-text cursor splits the value at the offset", () => {
    const frame = stripAnsi(
      renderToString(<InputBox value="fix the" cursor={4} disabled={false} busy={false} />),
    );
    // head "fix " + cursor char + tail "he" reassembles to the full value.
    expect(frame.replace(/\s+/g, "")).toContain("fixthe");
  });

  it("joins the context row parts and switches hints while busy", () => {
    const idle = renderToString(
      <ContextRow
        model="openai:gpt-5"
        modelFree={false}
        contextPct={42}
        sessionName="abc.jsonl"
        busy={false}
      />,
    );
    expect(idle).toContain("Build · openai:gpt-5");
    expect(idle).toContain("ctx ~42%");
    expect(idle).toContain("abc.jsonl");
    expect(idle).toContain("type / for commands");

    const busy = renderToString(
      <ContextRow
        model={undefined}
        modelFree={false}
        contextPct={undefined}
        sessionName={undefined}
        busy={true}
      />,
    );
    expect(busy).toContain("esc interrupts");
  });

  it("free models get a (free) suffix in the context row", () => {
    const frame = renderToString(
      <ContextRow
        model="openrouter:z-ai/glm-4.5-air:free"
        modelFree={true}
        contextPct={undefined}
        sessionName={undefined}
        busy={false}
      />,
    );
    expect(frame).toContain("(free)");
  });

  it("renders the hero with logo, tip and model line", () => {
    const frame = renderToString(<Hero modelLabel="openrouter:anthropic/claude-sonnet-4.5" />);
    expect(frame).toContain("AI coding agent");
    expect(frame).toContain("/models");
    expect(frame).toContain("openrouter:anthropic/claude-sonnet-4.5");
  });
});

describe("slash-command menu", () => {
  it("renders nothing when no commands match", () => {
    const frame = renderToString(<CommandMenu commands={[]} cursor={0} />);
    expect(frame).toBe("");
  });

  it("lists filtered commands with descriptions and a hint row", () => {
    const commands = filterSlashCommands("/m", "tui");
    const frame = stripAnsi(renderToString(<CommandMenu commands={commands} cursor={0} />));
    expect(frame).toContain("/models");
    expect(frame).toContain("/model");
    expect(frame).toContain("pick a model from live provider catalogs");
    expect(frame).toContain("tab complete");
  });

  it("highlights the selected row", () => {
    const commands = filterSlashCommands("", "tui");
    const frame = stripAnsi(renderToString(<CommandMenu commands={commands} cursor={1} />));
    expect(frame).toContain("● /models");
    expect(frame).toContain("/clear");
  });
});

describe("model picker", () => {
  const groups: PickerProviderGroup[] = [
    {
      provider: {
        id: "openrouter",
        name: "OpenRouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        keyUrl: "",
        exampleModels: [],
      },
      models: [
        {
          id: "z-ai/glm-4.5-air:free",
          name: "GLM 4.5 Air (free)",
          contextLength: 131_072,
          inputPricePerMillion: 0,
          outputPricePerMillion: 0,
          free: true,
        },
        {
          id: "anthropic/claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          contextLength: 200_000,
          inputPricePerMillion: 3,
          outputPricePerMillion: 15,
          free: false,
        },
      ],
    },
  ];

  it("loading state shows the fetch spinner", () => {
    const frame = renderToString(
      <ModelPicker status="loading" groups={[]} recents={[]} currentRef="" query="" cursor={0} />,
    );
    expect(frame).toContain("Select model");
    expect(frame).toContain("fetching model catalogs…");
  });

  it("ready state renders groups, free badge and current marker", () => {
    const frame = renderToString(
      <ModelPicker
        status="ready"
        groups={groups}
        recents={[]}
        currentRef="openrouter:anthropic/claude-sonnet-4.5"
        query=""
        cursor={0}
      />,
    );
    expect(frame).toContain("Select model");
    expect(frame).toContain("OpenRouter");
    expect(frame).toContain("GLM 4.5 Air (free)");
    expect(frame).toContain("Free");
    expect(frame).toContain("(current)");
  });

  it("search filters rows", () => {
    const frame = renderToString(
      <ModelPicker
        status="ready"
        groups={groups}
        recents={[]}
        currentRef=""
        query="glm"
        cursor={0}
      />,
    );
    expect(frame).toContain("GLM 4.5 Air");
    expect(frame).not.toContain("Claude Sonnet");
  });

  it("recent section appears first when present", () => {
    const frame = renderToString(
      <ModelPicker
        status="ready"
        groups={groups}
        recents={["openrouter:z-ai/glm-4.5-air:free"]}
        currentRef=""
        query=""
        cursor={0}
      />,
    );
    expect(frame).toContain("Recent");
  });

  it("renders provider tabs and filters models when providerFilter is set", () => {
    const multiGroups: PickerProviderGroup[] = [
      ...groups,
      {
        provider: {
          id: "google",
          name: "Google Gemini",
          apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
          keyUrl: "",
          exampleModels: [],
        },
        models: [
          {
            id: "gemini-2.5-flash",
            name: "Gemini 2.5 Flash",
            free: false,
            contextLength: undefined,
            inputPricePerMillion: undefined,
            outputPricePerMillion: undefined,
          },
        ],
      },
    ];
    const frame = renderToString(
      <ModelPicker
        status="ready"
        groups={multiGroups}
        recents={[]}
        currentRef=""
        query=""
        cursor={0}
        providerFilter="google"
      />,
    );
    expect(frame).toContain("Provider:");
    expect(frame).toContain("[Google Gemini]");
    expect(frame).toContain("[OpenRouter]");
    expect(frame).toContain("Gemini 2.5 Flash");
    expect(frame).not.toContain("Claude Sonnet");
  });
});

describe("connect dialog", () => {
  it("renders the provider list stage", () => {
    const frame = renderToString(
      <ConnectDialog stage="provider" providerIndex={0} providerName="" keyValue="" />,
    );
    expect(frame).toContain("Connect provider");
    expect(frame).toContain("OpenRouter");
    expect(frame).toContain("❯ OpenRouter");
  });

  it("renders the key entry stage with masked input", () => {
    const frame = renderToString(
      <ConnectDialog
        stage="key"
        providerIndex={0}
        providerName="OpenRouter"
        keyValue="sk-or-abc"
      />,
    );
    expect(frame).toContain("Paste your OpenRouter API key");
    expect(frame).toContain("•••••••••");
    expect(frame).not.toContain("sk-or-abc");
  });
});

describe("TuiApp mount", () => {
  it("renders the full shell (input + context) from a bridge snapshot", () => {
    const bridge = new TuiBridge();
    bridge.setBoot({
      model: "openrouter:anthropic/claude-sonnet-4.5",
      window: 262_144,
      windowAssumed: false,
      sessionPath: "/tmp/.harness/sessions/abc.jsonl",
      continued: false,
      replayedMessages: 0,
      yolo: false,
    });
    bridge.pushUser("hello");
    bridge.pushSummary("1 step · stop");
    const frame = renderToString(
      <TuiApp
        bridge={bridge}
        onSubmit={() => {}}
        onCancel={() => {}}
        onExit={() => {}}
        onPickModel={() => {}}
        onConnectSubmit={() => {}}
      />,
    );
    expect(frame).toContain("❯ hello");
    expect(frame).toContain("▪ 1 step · stop");
    expect(frame).toContain("openrouter:anthropic/claude-sonnet-4.5");
    expect(frame).toContain("abc.jsonl");
    // The hero is gone once the transcript has items.
    expect(frame).not.toContain("AI coding agent");
  });

  it("shows the hero while the transcript is empty", () => {
    const bridge = new TuiBridge();
    const frame = renderToString(
      <TuiApp
        bridge={bridge}
        onSubmit={() => {}}
        onCancel={() => {}}
        onExit={() => {}}
        onPickModel={() => {}}
        onConnectSubmit={() => {}}
      />,
    );
    expect(frame).toContain("AI coding agent");
    expect(frame).toContain("Ask anything…");
  });
});

describe("opencode-style transcript", () => {
  it("renders Thought blocks with timing", () => {
    const frame = renderToString(<ThoughtView text="checking auth flow" ms={276} />);
    expect(frame).toContain("Thought");
    expect(frame).toContain("276ms");
    expect(frame).toContain("checking auth flow");
  });

  it("renders edit_file tools with red/green diff lines", () => {
    const frame = renderToString(
      <TranscriptItemView
        item={item({
          kind: "tool",
          name: "edit_file",
          display: "Edit(src/a.ts)",
          ok: true,
          summary: "src/a.ts · 1 replacement",
          ms: 5,
          input: { path: "src/a.ts", old_string: "const a = 1;\n", new_string: "const a = 2;\n" },
          data: { path: "src/a.ts", replacements: 1 },
        })}
      />,
    );
    expect(frame).toContain("Edit(src/a.ts)");
    expect(frame).toContain("const a = 1;");
    expect(frame).toContain("const a = 2;");
  });

  it("renders write_file tools with +new badge and added lines", () => {
    const frame = renderToString(
      <TranscriptItemView
        item={item({
          kind: "tool",
          name: "write_file",
          display: "Write(src/new.ts)",
          ok: true,
          summary: "src/new.ts · created 20b",
          ms: 8,
          input: { path: "src/new.ts", content: "export const x = 1;\n" },
          data: { path: "src/new.ts", bytes: 20, created: true },
        })}
      />,
    );
    expect(frame).toContain("Write(src/new.ts)");
    expect(frame).toContain("+new");
    expect(frame).toContain("export const x = 1;");
  });

  it("renders assistant markdown (headings, bold, code, bullets)", () => {
    const frame = stripAnsi(
      renderToString(
        <MarkdownText text={"# Title\n**bold** and `code`\n- item one\n```\nconst x = 1;\n```"} />,
      ),
    );
    expect(frame).toContain("Title");
    expect(frame).toContain("bold");
    expect(frame).toContain("code");
    expect(frame).toContain("item one");
    expect(frame).toContain("const x = 1;");
    // Ensure raw code fences are not dumped
    expect(frame).not.toContain("```");
  });

  it("renders horizontal rules, tables, task lists, and quotes without raw markdown artifacts", () => {
    const md = [
      "## Overview",
      "---",
      "| Col A | Col B |",
      "| :--- | :--- |",
      "| val1 | val2 |",
      "- [x] Done task",
      "- [ ] Open task",
      "1. First step",
      "2. Second step",
      "> Quoted tip",
      "Visit [site](https://example.com) for details.",
    ].join("\n");

    const frame = stripAnsi(renderToString(<MarkdownText text={md} />));
    expect(frame).toContain("Overview");
    // Should render box-drawing horizontal divider instead of raw ---
    expect(frame).toContain("────");
    expect(frame).not.toContain("---");
    // Table content
    expect(frame).toContain("Col A");
    expect(frame).toContain("val1");
    // Tasks and ordered lists
    expect(frame).toContain("☑ Done task");
    expect(frame).toContain("☐ Open task");
    expect(frame).toContain("1. First step");
    expect(frame).toContain("2. Second step");
    // Quote
    expect(frame).toContain("│ Quoted tip");
    // Link text rendered cleanly
    expect(frame).toContain("site");
  });

  it("shows thinking preview in the live area with the active tail line", () => {
    const frame = renderToString(
      <LiveArea
        text=""
        thinking={"first line\nactive live tail"}
        thinkingStartedAt={Date.now() - 3000}
        busy={true}
        toolName={undefined}
      />,
    );
    expect(frame).toContain("Thought");
    expect(frame).toContain("active live tail");
    expect(frame).toContain("thinking…");
    expect(frame).toContain("3s");
  });

  it("renders running tool name when a tool is executing", () => {
    const frame = renderToString(<LiveArea text="" busy={true} toolName="read_file" />);
    expect(frame).toContain("running read_file…");
  });
});
