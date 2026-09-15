import { describe, expect, it, vi, afterEach } from "vitest";
import { EventBus } from "@harness/core";
import type { HarnessEvent } from "@harness/core";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBus", () => {
  const bus = () => new EventBus<HarnessEvent>();

  it("delivers typed events to per-type subscribers", () => {
    const b = bus();
    const seen: string[] = [];
    b.on("done", (event) => seen.push(event.stopReason));
    b.emit({ type: "done", stopReason: "stop" });
    expect(seen).toEqual(["stop"]);
  });

  it("delivers every event to onAny subscribers", () => {
    const b = bus();
    const types: string[] = [];
    b.onAny((event) => types.push(event.type));
    b.emit({ type: "step:start", step: 0 });
    b.emit({ type: "done", stopReason: "stop" });
    expect(types).toEqual(["step:start", "done"]);
  });

  it("unsubscribe stops delivery", () => {
    const b = bus();
    let calls = 0;
    const off = b.on("done", () => {
      calls += 1;
    });
    b.emit({ type: "done", stopReason: "stop" });
    off();
    b.emit({ type: "done", stopReason: "stop" });
    expect(calls).toBe(1);
  });

  it("isolates handler exceptions so one bad renderer cannot break others", () => {
    const b = bus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let goodCalls = 0;
    b.on("done", () => {
      throw new Error("renderer exploded");
    });
    b.on("done", () => {
      goodCalls += 1;
    });
    expect(() => b.emit({ type: "done", stopReason: "stop" })).not.toThrow();
    expect(goodCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("clear removes all subscriptions", () => {
    const b = bus();
    let calls = 0;
    b.onAny(() => {
      calls += 1;
    });
    b.on("done", () => {
      calls += 1;
    });
    b.clear();
    b.emit({ type: "done", stopReason: "stop" });
    expect(calls).toBe(0);
  });
});
