import {
  runAgent,
  AllowAllGate,
  EventBus,
  ReadTracker,
  asAbsolutePath,
  createTruncator,
} from "@harness/core";
import type { HarnessEvent } from "@harness/core";
import { parseHarnessEnv, resolveModel } from "@harness/providers";
import { tools } from "@harness/tools";

/**
 * Scheduled real-model smoke test (see .github/workflows/ci.yml `smoke` job).
 * Requires OPENROUTER_API_KEY. Catches provider/API drift without making
 * normal CI dependent on external services.
 */

const env = parseHarnessEnv(process.env);
const modelRef = env.HARNESS_SMOKE_MODEL ?? "openrouter:openai/gpt-4.1-mini";
const prompt = env.HARNESS_SMOKE_PROMPT ?? "Reply with exactly one word: pong";

const events = new EventBus<HarnessEvent>();
let sawText = false;
events.onAny((event) => {
  switch (event.type) {
    case "text:delta": {
      sawText = true;
      process.stdout.write(event.text);
      break;
    }
    case "tool:call": {
      process.stdout.write(`\n[tool] ${event.name}\n`);
      break;
    }
    case "usage": {
      process.stdout.write(`\n[usage] ${event.inputTokens} in / ${event.outputTokens} out\n`);
      break;
    }
    default:
      break;
  }
});

const result = await runAgent({
  model: resolveModel(modelRef, { env }),
  system: "You are a smoke test. Answer with a single word.",
  messages: [{ role: "user", content: prompt }],
  tools,
  permissions: new AllowAllGate(),
  events,
  toolContext: {
    cwd: asAbsolutePath(process.cwd()),
    readTracker: new ReadTracker(),
    truncator: createTruncator({ maxChars: 10_000 }),
  },
  budget: { maxSteps: 3 },
});

console.log(`\n[smoke] model=${modelRef} stopReason=${result.stopReason} steps=${result.steps}`);
if (!sawText || result.stopReason === "error") {
  console.error("[smoke] FAILED — no text produced or run errored");
  process.exit(1);
}
console.log("[smoke] OK");
