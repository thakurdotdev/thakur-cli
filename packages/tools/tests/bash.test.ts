import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadTracker, asAbsolutePath, createTruncator } from "@harness/core";
import type { ToolContext } from "@harness/core";
import { bash, tools } from "@harness/tools";
import type { BashOutput } from "@harness/tools";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-bash-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Windows file locks from child processes can delay cleanup
  }
});

function makeContext(): ToolContext {
  return {
    cwd: asAbsolutePath(realpathSync(dir)),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 50_000 }),
  };
}

// Portable command fixtures: node is guaranteed on dev machines and CI.
const node = JSON.stringify(process.execPath);

describe("bash tool", () => {
  it("captures stdout and stderr", async () => {
    const result = await bash.execute(
      {
        command: `${node} -e "console.log('harness-stdout'); console.error('harness-stderr')"`,
      },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as BashOutput;
      expect(data.stdout).toContain("harness-stdout");
      expect(data.stderr).toContain("harness-stderr");
      expect(data.exitCode).toBe(0);
      expect(data.timedOut).toBe(false);
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports non-zero exit codes", async () => {
    const result = await bash.execute({ command: `${node} -e "process.exit(3)"` }, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as BashOutput;
      expect(data.exitCode).toBe(3);
    }
  });

  it("runs inside the tool context cwd", async () => {
    const result = await bash.execute(
      {
        command: `${node} -e "require('fs').writeFileSync('marker.txt', 'here')"`,
      },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("here");
  });

  it("kills commands that exceed the timeout", async () => {
    const result = await bash.execute(
      {
        command: `${node} -e "setTimeout(() => {}, 30_000)"`,
        timeout_ms: 300,
      },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as BashOutput;
      expect(data.timedOut).toBe(true);
      expect(data.durationMs).toBeLessThan(10_000);
    }
  }, 15_000);

  it("aborts with the context signal", async () => {
    const controller = new AbortController();
    const run = bash.execute(
      { command: `${node} -e "setTimeout(() => {}, 30_000)"` },
      { ...makeContext(), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150);
    const result = await run;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as BashOutput;
      // Killed via abort — reported through timedOut/signal path, process is gone either way.
      expect(data.timedOut).toBe(false);
    }
  }, 15_000);

  it("redacts secret-shaped env values from stdout and stderr", async () => {
    const secret = "harness-secret-value-9f2c";
    const previous = process.env["HARNESS_TEST_API_TOKEN"];
    process.env["HARNESS_TEST_API_TOKEN"] = secret;
    try {
      const result = await bash.execute(
        {
          command: `${node} -e "console.log('token=' + process.env.HARNESS_TEST_API_TOKEN); console.error(process.env.HARNESS_TEST_API_TOKEN)"`,
        },
        makeContext(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as BashOutput;
        expect(data.stdout).toContain("***REDACTED***");
        expect(data.stderr).toContain("***REDACTED***");
        expect(data.stdout).not.toContain(secret);
        expect(data.stderr).not.toContain(secret);
      }
    } finally {
      if (previous === undefined) {
        delete process.env["HARNESS_TEST_API_TOKEN"];
      } else {
        process.env["HARNESS_TEST_API_TOKEN"] = previous;
      }
    }
  }, 15_000);
});

describe("tool registry", () => {
  it("exposes the builtin surface with correct risk classes", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      "edit_file",
      "glob",
      "grep",
      "list_dir",
      "read_file",
      "write_file",
    ]);
    expect(tools["read_file"]?.risk).toBe("read");
    expect(tools["grep"]?.risk).toBe("read");
    expect(tools["glob"]?.risk).toBe("read");
    expect(tools["list_dir"]?.risk).toBe("read");
    expect(tools["write_file"]?.risk).toBe("write");
    expect(tools["edit_file"]?.risk).toBe("write");
    expect(tools["bash"]?.risk).toBe("execute");
  });

  it("validates input at the boundary and returns errors as data", async () => {
    const result = await bash.execute({ command: 42 as unknown as string }, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid input for tool "bash"');
      expect(result.hint).toBeDefined();
    }
  });

  it("accepts an optional description explaining the command intent", async () => {
    const result = await bash.execute(
      { command: `${node} -e "console.log('intent verified')"`, description: "Check intent" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as BashOutput).stdout).toContain("intent verified");
    }
  });
});
