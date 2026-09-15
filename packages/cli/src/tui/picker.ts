import type { ProviderInfo, ProviderModelInfo } from "@harness/providers";

/**
 * Pure model-picker state: flattening, filtering, cursor math. No React, no
 * I/O — the trickiest picker logic is unit-testable without mounting Ink.
 */

export interface PickerProviderGroup {
  provider: ProviderInfo;
  models: ProviderModelInfo[];
  /** Set when the live fetch failed — rendered as a dim warning row. */
  error?: string;
}

export interface PickerModelRow {
  kind: "model";
  /** Fully-qualified ref, e.g. "openrouter:anthropic/claude-sonnet-4.5". */
  ref: string;
  name: string;
  free: boolean;
  contextLength: number | undefined;
  /** The model currently active in the session (dot marker, like opencode). */
  current: boolean;
}

export interface PickerHeaderRow {
  kind: "header";
  label: string;
}

export type PickerRow = PickerHeaderRow | PickerModelRow;

export interface PickerFlatRow {
  row: PickerRow;
  /** Index among selectable model rows (headers excluded) — the cursor space. */
  selectableIndex: number | undefined;
}

/** Build the full row list: Recent section first, then provider groups. */
export function flattenPickerRows(options: {
  groups: PickerProviderGroup[];
  recents: ReadonlyArray<string>;
  currentRef: string;
  query: string;
  providerFilter?: string | undefined;
}): PickerFlatRow[] {
  const query = options.query.trim().toLowerCase();
  const matches = (text: string): boolean =>
    query.length === 0 || text.toLowerCase().includes(query);

  const activeGroups =
    options.providerFilter !== undefined
      ? options.groups.filter((g) => g.provider.id === options.providerFilter)
      : options.groups;

  const activeRecents =
    options.providerFilter !== undefined
      ? options.recents.filter((ref) => ref.startsWith(`${options.providerFilter}:`))
      : options.recents;

  const rows: PickerFlatRow[] = [];
  let selectable = 0;

  const pushModel = (model: PickerModelRow): void => {
    rows.push({ row: model, selectableIndex: selectable });
    selectable += 1;
  };

  if (query.length === 0 && activeRecents.length > 0) {
    rows.push({ row: { kind: "header", label: "Recent" }, selectableIndex: undefined });
    for (const ref of activeRecents) {
      const separator = ref.indexOf(":");
      const providerId = separator > 0 ? ref.slice(0, separator) : "";
      const id = separator > 0 ? ref.slice(separator + 1) : ref;
      pushModel({
        kind: "model",
        ref,
        name: id,
        free: id.endsWith(":free"),
        contextLength: undefined,
        current: ref === options.currentRef,
      });
      void providerId;
    }
  }

  for (const group of activeGroups) {
    const filtered = group.models.filter((model) => matches(model.id) || matches(model.name));
    if (filtered.length === 0 && group.error === undefined) {
      continue;
    }
    rows.push({
      row: { kind: "header", label: group.provider.name },
      selectableIndex: undefined,
    });
    if (group.error !== undefined) {
      rows.push({
        row: { kind: "header", label: `⚠ ${group.error}` },
        selectableIndex: undefined,
      });
    }
    for (const model of filtered) {
      pushModel({
        kind: "model",
        ref: `${group.provider.id}:${model.id}`,
        name: model.name,
        free: model.free,
        contextLength: model.contextLength,
        current: `${group.provider.id}:${model.id}` === options.currentRef,
      });
    }
  }

  return rows;
}

/** Cycle through available provider filters (undefined means 'All'). */
export function cycleProviderFilter(
  availableProviders: readonly string[],
  current?: string,
): string | undefined {
  if (availableProviders.length <= 1) {
    return availableProviders[0];
  }
  const options: (string | undefined)[] = [undefined, ...availableProviders];
  const idx = options.indexOf(current);
  const nextIdx = (idx + 1) % options.length;
  return options[nextIdx];
}

/** The indices a cursor may land on (model rows only). */
export function selectableIndices(rows: ReadonlyArray<PickerFlatRow>): number[] {
  const indices: number[] = [];
  for (const entry of rows) {
    if (entry.selectableIndex !== undefined) {
      indices.push(entry.selectableIndex);
    }
  }
  return indices;
}

/** Move the cursor by ±delta within the selectable space (wraps neither — clamps). */
export function moveCursor(indices: ReadonlyArray<number>, current: number, delta: number): number {
  if (indices.length === 0) {
    return 0;
  }
  const position = indices.indexOf(current);
  if (position === -1) {
    return indices[0] ?? 0;
  }
  const next = Math.min(indices.length - 1, Math.max(0, position + delta));
  return indices[next] ?? current;
}

/** Which selectable index should the cursor start on? The current model, else first. */
export function initialCursor(rows: ReadonlyArray<PickerFlatRow>): number {
  for (const entry of rows) {
    if (entry.selectableIndex !== undefined && entry.row.kind === "model" && entry.row.current) {
      return entry.selectableIndex;
    }
  }
  return selectableIndices(rows)[0] ?? 0;
}

/** Window of rows to render around the cursor (headers ride along). */
export function visibleWindow<T>(
  entries: ReadonlyArray<T>,
  center: number,
  maxVisible: number,
): Array<T> {
  if (entries.length <= maxVisible) {
    return [...entries];
  }
  const half = Math.floor(maxVisible / 2);
  const start = Math.min(Math.max(0, center - half), entries.length - maxVisible);
  return entries.slice(start, start + maxVisible);
}
