import type { AskDecision, HarnessEvent, PermissionRequest } from "@harness/core";
import { initialTuiState, pushInfo, pushSummary, pushUser, reduceEvent } from "./transcript.ts";
import type { TuiState } from "./transcript.ts";
import type { PickerProviderGroup } from "./picker.ts";

/**
 * The bridge is the single reactive store between the agent engine and the
 * Ink app. The engine pushes events and answers through it; React reads it
 * with useSyncExternalStore. Snapshots are immutable and replaced on every
 * change so React can bail out cheaply between updates.
 *
 * Permission asks travel the other way: the gate's onAsk callback parks a
 * pending request here and returns a promise that the dialog resolves.
 */

export interface BootInfo {
  model: string;
  window: number;
  windowAssumed: boolean;
  sessionPath: string;
  continued: boolean;
  replayedMessages: number;
  yolo: boolean;
}

export interface TuiSnapshot {
  state: TuiState;
  boot: BootInfo | undefined;
  /** Permission request awaiting a decision (rendered as a dialog). */
  pendingAsk: PermissionRequest | undefined;
  /** Model picker modal state (undefined = closed). */
  pendingPicker:
    | { status: "loading"; providerFilter?: string | undefined }
    | {
        status: "ready";
        groups: PickerProviderGroup[];
        recents: string[];
        currentRef: string;
        providerFilter?: string | undefined;
      }
    | undefined;
  /** Provider connect dialog state (undefined = closed). */
  pendingConnect:
    | { stage: "provider"; index: number }
    | { stage: "key"; providerId: string; providerName: string; value: string }
    | undefined;
  /** True while an agent turn is in flight (drives status + cancel hint). */
  busy: boolean;
  /** Observed context usage after the last turn, in percent of the window. */
  contextPct: number | undefined;
  /** Set once the REPL core wants the app to unmount. */
  exitRequested: boolean;
}

interface AskTicket {
  request: PermissionRequest;
  resolve: (decision: AskDecision) => void;
}

function rotateIndex(index: number, delta: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return (((index + delta) % length) + length) % length;
}

export class TuiBridge {
  private listeners: ReadonlyArray<() => void> = [];
  private current: TuiSnapshot;

  private askQueue: AskTicket[] = [];

  constructor() {
    this.current = {
      state: initialTuiState(),
      boot: undefined,
      pendingAsk: undefined,
      pendingPicker: undefined,
      pendingConnect: undefined,
      busy: false,
      contextPct: undefined,
      exitRequested: false,
    };
  }

  // --- React store contract -------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  };

  getSnapshot = (): TuiSnapshot => {
    return this.current;
  };

  private notify(next: TuiSnapshot): void {
    this.current = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- engine -> UI ----------------------------------------------------------

  setBoot(info: BootInfo): void {
    this.notify({ ...this.current, boot: info });
  }

  /** Feed one engine event through the transcript reducer. */
  emit(event: HarnessEvent): void {
    const state = reduceEvent(this.current.state, event);
    if (state === this.current.state) {
      return;
    }
    this.notify({ ...this.current, state, busy: state.busy });
  }

  pushUser(text: string): void {
    this.notify({ ...this.current, state: pushUser(this.current.state, text) });
  }

  pushInfo(text: string): void {
    this.notify({ ...this.current, state: pushInfo(this.current.state, text) });
  }

  pushSummary(text: string): void {
    this.notify({ ...this.current, state: pushSummary(this.current.state, text) });
  }

  /** /clear — drop every transcript item and the live tail; context % stays. */
  clearTranscript(): void {
    this.notify({ ...this.current, state: initialTuiState() });
  }

  setContextPct(pct: number): void {
    this.notify({ ...this.current, contextPct: pct });
  }

  /** Ask the React app to unmount (safe to call from outside the tree). */
  requestExit(): void {
    this.notify({ ...this.current, exitRequested: true });
  }

  // --- model picker modal -----------------------------------------------------

  openPickerLoading(providerFilter?: string): void {
    this.notify({ ...this.current, pendingPicker: { status: "loading", providerFilter } });
  }

  setPickerReady(
    groups: PickerProviderGroup[],
    recents: string[],
    currentRef: string,
    providerFilter?: string,
  ): void {
    this.notify({
      ...this.current,
      pendingPicker: { status: "ready", groups, recents, currentRef, providerFilter },
    });
  }

  setPickerProviderFilter(providerFilter?: string): void {
    if (this.current.pendingPicker === undefined || this.current.pendingPicker.status !== "ready") {
      return;
    }
    this.notify({
      ...this.current,
      pendingPicker: {
        ...this.current.pendingPicker,
        providerFilter,
      },
    });
  }

  closePicker(): void {
    if (this.current.pendingPicker === undefined) {
      return;
    }
    this.notify({ ...this.current, pendingPicker: undefined });
  }

  // --- connect dialog ---------------------------------------------------------

  openConnect(): void {
    this.notify({ ...this.current, pendingConnect: { stage: "provider", index: 0 } });
  }

  moveConnectProvider(delta: number, length: number): void {
    const current = this.current.pendingConnect;
    if (current === undefined || current.stage !== "provider" || length <= 0) {
      return;
    }
    this.notify({
      ...this.current,
      pendingConnect: { stage: "provider", index: rotateIndex(current.index, delta, length) },
    });
  }

  setConnectKeyStage(providerId: string, providerName: string): void {
    this.notify({
      ...this.current,
      pendingConnect: { stage: "key", providerId, providerName, value: "" },
    });
  }

  appendConnectKey(text: string): void {
    const current = this.current.pendingConnect;
    if (current === undefined || current.stage !== "key") {
      return;
    }
    this.notify({
      ...this.current,
      pendingConnect: { ...current, value: current.value + text },
    });
  }

  backspaceConnectKey(): void {
    const current = this.current.pendingConnect;
    if (current === undefined || current.stage !== "key") {
      return;
    }
    this.notify({
      ...this.current,
      pendingConnect: {
        ...current,
        value: current.value.slice(0, Math.max(0, current.value.length - 1)),
      },
    });
  }

  closeConnect(): void {
    if (this.current.pendingConnect === undefined) {
      return;
    }
    this.notify({ ...this.current, pendingConnect: undefined });
  }

  // --- UI -> engine (permission dialog) --------------------------------------

  /**
   * Park a permission request and wait for the dialog's answer. Requests are
   * answered strictly in arrival order (the gate asks sequentially).
   */
  askPermission(request: PermissionRequest): Promise<AskDecision> {
    return new Promise<AskDecision>((resolve) => {
      this.askQueue = [...this.askQueue, { request, resolve }];
      this.notify({ ...this.current, pendingAsk: request });
    });
  }

  /** Resolve the head pending request (the one the dialog shows). */
  resolveAsk(decision: AskDecision): void {
    const [head, ...rest] = this.askQueue;
    if (head === undefined) {
      return;
    }
    this.askQueue = rest;
    const nextPending = rest[0]?.request;
    head.resolve(decision);
    this.notify({ ...this.current, pendingAsk: nextPending });
  }

  /** Deny everything pending (used on app exit while a dialog is open). */
  denyAllPending(reason: string): void {
    for (const ticket of this.askQueue) {
      ticket.resolve({ action: "deny", reason });
    }
    this.askQueue = [];
    if (this.current.pendingAsk !== undefined) {
      this.notify({ ...this.current, pendingAsk: undefined });
    }
  }
}
