import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@harness/providers";
import {
  cycleProviderFilter,
  flattenPickerRows,
  initialCursor,
  moveCursor,
  selectableIndices,
  visibleWindow,
} from "../src/tui/picker.ts";
import type { PickerProviderGroup } from "../src/tui/picker.ts";

/** Pure picker logic — flattening, filtering, cursor math, windows. */

const provider: ProviderInfo = {
  id: "openrouter",
  name: "OpenRouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  keyUrl: "https://openrouter.ai/keys",
  exampleModels: [],
};

function group(models: Parameters<typeof makeGroup>[1]): PickerProviderGroup {
  return makeGroup(provider, models);
}

function makeGroup(
  providerInfo: ProviderInfo,
  models: Array<{
    id: string;
    name: string;
    contextLength?: number;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    free?: boolean;
  }>,
): PickerProviderGroup {
  return {
    provider: providerInfo,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.contextLength,
      inputPricePerMillion: model.inputPricePerMillion,
      outputPricePerMillion: model.outputPricePerMillion,
      free: model.free ?? false,
    })),
  };
}

const demoGroup = group([
  { id: "a/one:free", name: "One Free", free: true, contextLength: 1000 },
  { id: "b/two", name: "Two Paid", contextLength: 2000 },
  { id: "c/three", name: "Three Paid" },
]);

describe("flattenPickerRows", () => {
  it("emits headers + model rows with sequential selectable indices", () => {
    const rows = flattenPickerRows({ groups: [demoGroup], recents: [], currentRef: "", query: "" });
    expect(rows[0]?.row.kind).toBe("header");
    const selectable = selectableIndices(rows);
    expect(selectable).toEqual([0, 1, 2]);
    const first = rows[1];
    if (first?.row.kind === "model") {
      expect(first.row.ref).toBe("openrouter:a/one:free");
    } else {
      expect.unreachable();
    }
  });

  it("recents come first as raw refs, dot-marked when current", () => {
    const rows = flattenPickerRows({
      groups: [demoGroup],
      recents: ["openrouter:b/two"],
      currentRef: "openrouter:b/two",
      query: "",
    });
    expect(rows[0]?.row).toEqual({ kind: "header", label: "Recent" });
    const recent = rows[1];
    if (recent?.row.kind === "model") {
      expect(recent.row.ref).toBe("openrouter:b/two");
      expect(recent.row.current).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it("query filters on id and name, case-insensitively", () => {
    const byId = flattenPickerRows({
      groups: [demoGroup],
      recents: [],
      currentRef: "",
      query: "two",
    });
    expect(selectableIndices(byId)).toEqual([0]);
    const byName = flattenPickerRows({
      groups: [demoGroup],
      recents: [],
      currentRef: "",
      query: "ONE FREE",
    });
    expect(selectableIndices(byName)).toEqual([0]);
    const none = flattenPickerRows({
      groups: [demoGroup],
      recents: ["openrouter:b/two"],
      currentRef: "",
      query: "zzz",
    });
    // Query mode hides the recents section entirely.
    expect(none).toHaveLength(0);
  });

  it("error groups keep their header with the warning row", () => {
    const rows = flattenPickerRows({
      groups: [{ provider, models: [], error: "HTTP 401" }],
      recents: [],
      currentRef: "",
      query: "",
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.row).toMatchObject({ kind: "header", label: "⚠ HTTP 401" });
  });

  it("providerFilter scopes models and recents to the requested provider", () => {
    const googleGroup: PickerProviderGroup = {
      provider: {
        id: "google",
        name: "Google Gemini",
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
        keyUrl: "",
        exampleModels: [],
      },
      models: [
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          free: false,
          contextLength: undefined,
          inputPricePerMillion: undefined,
          outputPricePerMillion: undefined,
        },
      ],
    };
    const rows = flattenPickerRows({
      groups: [demoGroup, googleGroup],
      recents: ["openrouter:b/two", "google:gemini-2.5-pro"],
      currentRef: "",
      query: "",
      providerFilter: "google",
    });
    const modelRefs = rows
      .filter(
        (r): r is typeof r & { row: { kind: "model"; ref: string } } => r.row.kind === "model",
      )
      .map((r) => r.row.ref);
    expect(modelRefs).toEqual(["google:gemini-2.5-pro", "google:gemini-2.5-pro"]);
    expect(rows.some((r) => r.row.kind === "header" && r.row.label === "OpenRouter")).toBe(false);
    expect(rows.some((r) => r.row.kind === "header" && r.row.label === "Google Gemini")).toBe(true);
  });

  it("cycleProviderFilter rotates through available providers and undefined (all)", () => {
    const available = ["google", "openai"];
    expect(cycleProviderFilter(available, undefined)).toBe("google");
    expect(cycleProviderFilter(available, "google")).toBe("openai");
    expect(cycleProviderFilter(available, "openai")).toBe(undefined);
  });
});

describe("cursor + window", () => {
  const rows = flattenPickerRows({ groups: [demoGroup], recents: [], currentRef: "", query: "" });
  const selectable = selectableIndices(rows);

  it("initialCursor lands on the current model when present", () => {
    const withCurrent = flattenPickerRows({
      groups: [demoGroup],
      recents: [],
      currentRef: "openrouter:b/two",
      query: "",
    });
    expect(initialCursor(withCurrent)).toBe(1);
    expect(initialCursor(rows)).toBe(0);
  });

  it("moveCursor clamps at both ends", () => {
    expect(moveCursor(selectable, 0, -1)).toBe(0);
    expect(moveCursor(selectable, 0, 1)).toBe(1);
    expect(moveCursor(selectable, 2, 1)).toBe(2);
    expect(moveCursor([], 0, 1)).toBe(0);
  });

  it("moveCursor recovers when the cursor points at a filtered-out row", () => {
    expect(moveCursor([0, 1, 2], 5, 0)).toBe(0);
  });

  it("visibleWindow returns everything when it fits, else a windowed slice", () => {
    const entries = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(visibleWindow(entries, 0, 14)).toHaveLength(9);
    const windowed = visibleWindow(entries, 4, 3);
    expect(windowed).toEqual([4, 5, 6]);
    const atStart = visibleWindow(entries, 0, 3);
    expect(atStart).toEqual([1, 2, 3]);
    const atEnd = visibleWindow(entries, 8, 3);
    expect(atEnd).toEqual([7, 8, 9]);
  });
});
