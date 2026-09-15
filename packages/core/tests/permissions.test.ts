import { describe, expect, it } from "vitest";
import { AllowAllGate, InteractiveGate } from "@harness/core";
import type { AskDecision, PermissionRequest } from "@harness/core";

function writeRequest(): PermissionRequest {
  return { tool: "write_file", risk: "write", input: { path: "a.txt" } };
}

function readRequest(): PermissionRequest {
  return { tool: "read_file", risk: "read", input: { path: "a.txt" } };
}

describe("AllowAllGate", () => {
  it("allows everything", async () => {
    const gate = new AllowAllGate();
    expect((await gate.decide(writeRequest())).allowed).toBe(true);
    expect((await gate.decide(readRequest())).allowed).toBe(true);
  });
});

describe("InteractiveGate", () => {
  it("auto-allows reads by default without asking", async () => {
    let asked = 0;
    const gate = new InteractiveGate({
      onAsk: () => {
        asked += 1;
        return { action: "deny" };
      },
    });
    const decision = await gate.decide(readRequest());
    expect(decision.allowed).toBe(true);
    expect(asked).toBe(0);
  });

  it("can be configured to ask even for reads", async () => {
    let asked = 0;
    const gate = new InteractiveGate({
      autoAllowReads: false,
      onAsk: () => {
        asked += 1;
        return { action: "allow" };
      },
    });
    expect((await gate.decide(readRequest())).allowed).toBe(true);
    expect(asked).toBe(1);
  });

  it("asks for write-risk tools and honours the answer", async () => {
    const asks: string[] = [];
    const gate = new InteractiveGate({
      onAsk: (request) => {
        asks.push(request.tool);
        return { action: "allow" } satisfies AskDecision;
      },
    });
    const decision = await gate.decide(writeRequest());
    expect(decision.allowed).toBe(true);
    expect(asks).toEqual(["write_file"]);
  });

  it("remembers 'always' answers for the rest of the session", async () => {
    let asked = 0;
    const gate = new InteractiveGate({
      onAsk: () => {
        asked += 1;
        return { action: "always" };
      },
    });
    expect((await gate.decide(writeRequest())).allowed).toBe(true);
    expect((await gate.decide(writeRequest())).allowed).toBe(true);
    expect(asked).toBe(1);
  });

  it("denies when the user declines", async () => {
    const gate = new InteractiveGate({
      onAsk: () => ({ action: "deny", reason: "not now" }),
    });
    const decision = await gate.decide(writeRequest());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("not now");
  });

  it("supports shared session grants", async () => {
    const grants = new Set<string>(["write_file"]);
    const gate = new InteractiveGate({
      sessionGrants: grants,
      onAsk: () => {
        throw new Error("should not ask");
      },
    });
    expect((await gate.decide(writeRequest())).allowed).toBe(true);
  });
});
