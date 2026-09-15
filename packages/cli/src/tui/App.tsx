import { Box } from "ink";
import { useApp, useInput } from "ink";
import { useSyncExternalStore, useEffect, useState } from "react";
import { basename } from "node:path";
import { PROVIDERS } from "@harness/providers";
import {
  askChoices,
  CommandMenu,
  ConnectDialog,
  ContextRow,
  Hero,
  InputBox,
  LiveArea,
  ModelPicker,
  PermissionDialog,
  rotate,
  Transcript,
} from "./components.tsx";
import {
  cycleProviderFilter,
  flattenPickerRows,
  initialCursor,
  moveCursor as movePickerCursor,
  selectableIndices,
} from "./picker.ts";
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
} from "./edit.ts";
import type { InputEdit } from "./edit.ts";
import { filterSlashCommands, slashCommandFill } from "../commands/slash-commands.ts";
import type { TuiBridge } from "./bridge.ts";

/**
 * Root Ink component for the interactive REPL.
 *
 * Layout (top to bottom): the immutable transcript (Ink <Static>, scrolls
 * naturally with the terminal buffer), then the live region (streaming
 * partial line / spinner), the welcome hero while the transcript is empty,
 * permission dialog / model picker / connect dialog when open, the bordered
 * input box and the context row.
 *
 * Key model (claude-code / opencode conventions):
 *   Enter        submit the prompt
 *   ↑/↓          input history (or modal navigation)
 *   Esc          interrupt the running turn / close a modal (no-op when idle)
 *   Ctrl+C       interrupt while busy, exit when idle
 *   dialog open  ↑/↓ + Enter pick an answer, Esc denies
 */

export interface HistoryCursor {
  index: number | undefined;
  /** The half-typed prompt, preserved while browsing history. */
  draft: string;
}

/**
 * Pure input-history navigation shared with tests.
 *
 * `currentValue` is what the user was typing before the keypress; `draft`
 * is the preserved pre-history text. First ↑ saves the typed text as draft.
 */
export function navigateHistory(
  history: ReadonlyArray<string>,
  cursor: HistoryCursor,
  currentValue: string,
  direction: "up" | "down",
): { value: string; cursor: HistoryCursor } {
  if (history.length === 0) {
    return { value: currentValue, cursor };
  }
  if (direction === "up") {
    if (cursor.index === undefined) {
      const next = history.length - 1;
      return {
        value: history[next] ?? currentValue,
        cursor: { index: next, draft: currentValue },
      };
    }
    const next = Math.max(0, cursor.index - 1);
    return { value: history[next] ?? currentValue, cursor: { index: next, draft: cursor.draft } };
  }
  if (cursor.index === undefined) {
    return { value: currentValue, cursor };
  }
  const next = cursor.index + 1;
  if (next >= history.length) {
    return { value: cursor.draft, cursor: { index: undefined, draft: cursor.draft } };
  }
  return { value: history[next] ?? currentValue, cursor: { index: next, draft: cursor.draft } };
}

export interface TuiAppProps {
  bridge: TuiBridge;
  /** Submit a user prompt (slash command or task) to the REPL core. */
  onSubmit: (input: string) => void;
  /** Interrupt the running turn. */
  onCancel: () => void;
  /** Quit when idle. */
  onExit: () => void;
  /** Model picked in the modal (fully-qualified ref). */
  onPickModel: (ref: string) => void;
  /** API key submitted by the connect dialog. */
  onConnectSubmit: (providerId: string, apiKey: string) => void;
}

export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const snapshot = useSyncExternalStore(props.bridge.subscribe, props.bridge.getSnapshot);
  const [edit, setEdit] = useState<InputEdit>(emptyEdit);
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<HistoryCursor>({
    index: undefined,
    draft: "",
  });
  const [askIndex, setAskIndex] = useState(0);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerCursor, setPickerCursor] = useState(0);
  // Slash-command menu: open while the whole input is one "/token".
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [menuCursor, setMenuCursor] = useState(0);
  const { exit } = useApp();

  const value = edit.value;
  const pendingPicker = snapshot.pendingPicker;
  const pendingConnect = snapshot.pendingConnect;
  const menuCommands =
    !menuDismissed && isSlashToken(value) ? filterSlashCommands(value, "tui") : [];
  const menuOpen = menuCommands.length > 0;
  const menuAt = Math.min(menuCursor, Math.max(0, menuCommands.length - 1));

  useEffect(() => {
    if (snapshot.exitRequested) {
      exit();
    }
  }, [snapshot.exitRequested, exit]);

  useEffect(() => {
    if (snapshot.pendingAsk !== undefined) {
      setAskIndex(0);
    }
  }, [snapshot.pendingAsk]);

  useEffect(() => {
    setMenuCursor(0);
  }, [value]);

  useEffect(() => {
    if (value.length === 0) {
      setMenuDismissed(false);
    }
  }, [value]);

  /** Shared by Enter (task or slash command) and the menu's run/fill actions. */
  const submitInput = (text: string): void => {
    setHistory((current) => [...current, text]);
    setHistoryCursor({ index: undefined, draft: "" });
    setEdit(emptyEdit);
    setMenuDismissed(false);
    props.onSubmit(text);
  };

  useEffect(() => {
    if (pendingPicker?.status === "ready") {
      const rows = flattenPickerRows({
        groups: pendingPicker.groups,
        recents: pendingPicker.recents,
        currentRef: pendingPicker.currentRef,
        query: pickerQuery,
      });
      setPickerCursor(initialCursor(rows));
    }
    // Recompute the landing cursor whenever the picker opens with data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPicker]);

  useInput((input, key) => {
    // --- permission dialog ---------------------------------------------------
    const pending = snapshot.pendingAsk;
    if (pending !== undefined) {
      const choices = askChoices(pending.tool);
      if (key.upArrow) {
        setAskIndex((current) => rotate(current, -1, choices.length));
      } else if (key.downArrow) {
        setAskIndex((current) => rotate(current, 1, choices.length));
      } else if (key.return) {
        props.bridge.resolveAsk(choices[askIndex]?.decision ?? { action: "deny" });
      } else if (key.escape || (key.ctrl && input === "c")) {
        props.bridge.resolveAsk({ action: "deny", reason: "cancelled by user" });
      }
      return;
    }

    // --- model picker --------------------------------------------------------
    if (pendingPicker !== undefined) {
      if (key.escape || (key.ctrl && input === "c")) {
        props.bridge.closePicker();
        setPickerQuery("");
        return;
      }
      if (pendingPicker.status !== "ready") {
        return; // still loading — only esc works
      }
      const providerFilter = pendingPicker.providerFilter;
      const rows = flattenPickerRows({
        groups: pendingPicker.groups,
        recents: pendingPicker.recents,
        currentRef: pendingPicker.currentRef,
        query: pickerQuery,
        providerFilter,
      });
      const selectable = selectableIndices(rows);
      if (key.tab && pendingPicker.groups.length > 1) {
        const availableIds = pendingPicker.groups.map((g) => g.provider.id);
        const nextFilter = cycleProviderFilter(availableIds, providerFilter);
        props.bridge.setPickerProviderFilter(nextFilter);
        setPickerCursor(0);
        return;
      }
      if (key.upArrow) {
        setPickerCursor((current) => movePickerCursor(selectable, current, -1));
      } else if (key.downArrow) {
        setPickerCursor((current) => movePickerCursor(selectable, current, 1));
      } else if (key.return) {
        const row = rows.find((entry) => entry.selectableIndex === pickerCursor);
        if (row?.row.kind === "model") {
          props.onPickModel(row.row.ref);
          setPickerQuery("");
        }
      } else if (key.backspace) {
        setPickerQuery((current) => current.slice(0, Math.max(0, current.length - 1)));
      } else if (
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !key.upArrow &&
        !key.downArrow &&
        input.length > 0 &&
        !key.return &&
        !key.escape
      ) {
        setPickerQuery((current) => current + input);
      }
      return;
    }

    // --- connect dialog ------------------------------------------------------
    if (pendingConnect !== undefined) {
      if (key.escape || (key.ctrl && input === "c")) {
        props.bridge.closeConnect();
        return;
      }
      if (pendingConnect.stage === "provider") {
        if (key.upArrow) {
          props.bridge.moveConnectProvider(-1, PROVIDERS.length);
        } else if (key.downArrow) {
          props.bridge.moveConnectProvider(1, PROVIDERS.length);
        } else if (key.return) {
          const provider = PROVIDERS[pendingConnect.index];
          if (provider !== undefined) {
            props.bridge.setConnectKeyStage(provider.id, provider.name);
          }
        }
        return;
      }
      // key entry stage
      if (key.return) {
        if (pendingConnect.value.trim().length > 0) {
          props.onConnectSubmit(pendingConnect.providerId, pendingConnect.value.trim());
        }
      } else if (key.backspace) {
        props.bridge.backspaceConnectKey();
      } else if (!key.ctrl && !key.meta && input.length > 0) {
        props.bridge.appendConnectKey(input);
      }
      return;
    }

    // --- slash-command menu (input is a single "/token") ---------------------
    // Navigation/finalization lives here; editing keys fall through so the
    // user keeps typing while the menu filters.
    if (menuOpen) {
      if (key.escape) {
        setMenuDismissed(true);
        return;
      }
      if (key.ctrl && input === "c") {
        if (snapshot.busy) {
          try {
            props.onCancel();
          } catch {
            // Guard against abort exceptions
          }
        } else {
          props.onExit();
        }
        return;
      }
      if (key.upArrow) {
        setMenuCursor((current) => rotate(current, -1, menuCommands.length));
        return;
      }
      if (key.downArrow) {
        setMenuCursor((current) => rotate(current, 1, menuCommands.length));
        return;
      }
      if (key.tab || key.return) {
        const command = menuCommands[menuAt];
        if (command !== undefined && (key.tab || command.executeOnPick)) {
          submitInput(command.name);
        } else if (command !== undefined) {
          const fill = slashCommandFill(command);
          setEdit({ value: fill, cursor: fill.length });
        }
        return;
      }
    }

    // --- normal input ---------------------------------------------------------
    if (key.ctrl && input === "c") {
      if (snapshot.busy) {
        try {
          props.onCancel();
        } catch {
          // Guard against abort exceptions
        }
      } else {
        props.onExit();
      }
      return;
    }
    if (key.escape && snapshot.busy) {
      try {
        props.onCancel();
      } catch {
        // Guard against abort exceptions
      }
      return;
    }
    if (key.return) {
      const text = value.trim();
      if (text.length > 0) {
        submitInput(text);
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      const next = navigateHistory(history, historyCursor, value, key.upArrow ? "up" : "down");
      setHistoryCursor(next.cursor);
      setEdit({ value: next.value, cursor: next.value.length });
      return;
    }
    if (key.ctrl && input === "a") {
      setEdit(cursorToStart);
      return;
    }
    if (key.ctrl && input === "e") {
      setEdit(cursorToEnd);
      return;
    }
    if (key.ctrl && input === "u") {
      setEdit(killToStart);
      return;
    }
    if (key.ctrl && input === "k") {
      setEdit(killToEnd);
      return;
    }
    if (key.ctrl && input === "j") {
      setEdit(insertNewline);
      return;
    }
    if (key.leftArrow) {
      setEdit((current) => moveCursor(current, -1));
      return;
    }
    if (key.rightArrow) {
      setEdit((current) => moveCursor(current, 1));
      return;
    }
    if (key.home) {
      setEdit(cursorToStart);
      return;
    }
    if (key.end) {
      setEdit(cursorToEnd);
      return;
    }
    if (key.backspace) {
      setEdit(backspace);
      return;
    }
    if (key.delete) {
      setEdit(deleteAtCursor);
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      // Multi-character input (paste) inserts wholesale at the cursor.
      setEdit((current) => insertText(current, input));
    }
  });

  const boot = snapshot.boot;
  const showHero = snapshot.state.items.length === 0 && !snapshot.busy;
  const modelRef = boot?.model;
  const modelFree = modelRef !== undefined && modelRef.endsWith(":free");

  return (
    <Box flexDirection="column">
      <Transcript items={snapshot.state.items} />
      <LiveArea
        text={snapshot.state.live.text}
        thinking={snapshot.state.live.thinking}
        thinkingStartedAt={snapshot.state.live.thinkingStartedAt}
        busy={snapshot.busy}
        toolName={snapshot.state.live.toolName}
      />
      {showHero ? <Hero modelLabel={modelRef} /> : null}
      {snapshot.pendingAsk !== undefined ? (
        <PermissionDialog request={snapshot.pendingAsk} selected={askIndex} />
      ) : null}
      {pendingPicker !== undefined ? (
        <ModelPicker
          status={pendingPicker.status}
          groups={pendingPicker.status === "ready" ? pendingPicker.groups : []}
          recents={pendingPicker.status === "ready" ? pendingPicker.recents : []}
          currentRef={
            pendingPicker.status === "ready" ? pendingPicker.currentRef : (modelRef ?? "")
          }
          query={pickerQuery}
          cursor={pickerCursor}
          providerFilter={pendingPicker.providerFilter}
        />
      ) : null}
      {pendingConnect !== undefined ? (
        <ConnectDialog
          stage={pendingConnect.stage}
          providerIndex={pendingConnect.stage === "provider" ? pendingConnect.index : 0}
          providerName={pendingConnect.stage === "key" ? pendingConnect.providerName : ""}
          keyValue={pendingConnect.stage === "key" ? pendingConnect.value : ""}
        />
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {menuOpen ? <CommandMenu commands={menuCommands} cursor={menuAt} /> : null}
        <InputBox value={value} cursor={edit.cursor} disabled={false} busy={snapshot.busy} />
        <ContextRow
          model={modelRef}
          modelFree={modelFree}
          contextPct={snapshot.contextPct}
          sessionName={boot !== undefined ? basename(boot.sessionPath) : undefined}
          busy={snapshot.busy}
        />
      </Box>
    </Box>
  );
}
