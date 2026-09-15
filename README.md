# harness

A multi-model coding agent for the terminal — an LLM-driven loop with tools
(`read_file` / `write_file` / `edit_file` / `bash` / `grep` / `glob` /
`list_dir`), MCP-server tools, permission gates, and persistent sessions,
built on a typed, event-driven core with three interchangeable frontends: an
interactive REPL, a headless CI runner, and a programmatic SDK.

## Status: Phase 0–8 complete

| Layer | Package | Purpose |
| --- | --- | --- |
| Engine | `@harness/core` | Agent loop, event bus, MCP stdio client, context/truncation/permission primitives, JSONL sessions — **zero CLI dependencies** |
| Tools | `@harness/tools` | Builtin tool implementations and the typed registry |
| Providers | `@harness/providers` | Model-ref parsing, env validation, OpenRouter + OpenAI + Anthropic + Google adapters, model catalog |
| SDK | `@harness/sdk` | `createHarness()` — batteries-included programmatic API (model, tools, MCP, permissions, compaction, sessions) |
| Frontend | `@harness/cli` | Commander entry, layered config loader, chat REPL (Ink TUI + plain), headless `run` command |

**Dependency direction (enforced by convention):** `cli → sdk →
{tools, providers} → core`. `core` never imports from higher layers — that
boundary is what lets the same engine power the REPL, CI runs, and embedders.

## Installation

Install `thakurcode` in one command (macOS and Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.sh | bash
```

Or on Windows PowerShell:

```powershell
powershell -c "irm https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.ps1 | iex"
```

Once installed, launch the agent from anywhere with:

```sh
thakurcode
```

## Getting started (development)

Requires [Bun](https://bun.sh) **1.4.2** (pinned).

```sh
bun install          # link the workspace
bun run verify       # typecheck + lint + format:check + test — the CI gate
bun run dev          # start the chat REPL in the current repository
```

On first run the CLI needs model access. The friendliest way is the **stored
credential vault** — keys saved to `~/.harness/auth.json` survive double-clicks
and fresh terminals, no shell setup required:

```sh
bun run dev -- auth openrouter sk-or-...   # stored once, works everywhere
bun run dev                                # starts the chat REPL

# Or use environment variables like classic CLIs (env vars win over the vault):
export OPENROUTER_API_KEY="sk-or-..."      # https://openrouter.ai/keys
bun run dev -- --model "openrouter:nex-agi/nex-n2.5-pro:free"

# Direct providers work the same way — no middleman:
export ANTHROPIC_API_KEY="sk-ant-..."
bun run dev -- --model "anthropic:claude-sonnet-4-5"

bun run dev -- auth        # credential status per provider (env/stored/missing)
bun run dev -- models      # providers, credential status, catalog + prices
bun run dev -- --continue  # resume the most recent session in this directory
```

With **zero keys configured**, the app still opens — setup happens *inside*
it, the way claude-code and opencode do it: the TUI boots straight into its
**Connect provider** dialog (pick provider → paste key → stored), then flows
into the **/models** picker so first run ends on a working model. The plain
REPL opens with a `/connect` hint instead. Only a non-interactive boot (piped
stdin) prints these instructions, because there is nobody to prompt.

`harness auth` (below) remains the no-terminal way to pre-provision keys —
useful for CI and dotfiles.

`--model` accepts `provider:model` (split on the **first** colon only) or a
bare OpenRouter catalog id. Without a colon, the `openrouter:` provider is
assumed. Supported providers: `openrouter`, `openai`, `anthropic`, `google`.

### Chat frontends — TUI & plain

The REPL ships two frontends over the same engine (`ChatCore`):

| Mode | When | Look & feel |
| --- | --- | --- |
| **TUI** (default) | interactive terminals (`ui: "auto"`) | Full-screen [Ink](https://github.com/vadimdemedes/ink) app — live transcript, permission dialogs, status bar |
| **Plain** | pipes/CI, `--ui plain`, `ui: "plain"`, `TERM=dumb` | Readline loop with the ANSI renderer described below |

TUI keys: **Enter** submit · **↑/↓** input history · **Esc** interrupt the
running turn (or close a modal) · **Ctrl+C** interrupt while busy, exit when
idle. The welcome hero (logo, tip line) shows until the first message; the
input is a bordered box with a placeholder, and the rows under it show the
active model (+ `(free)` when applicable), context usage and the session file.
Tool lines are claude-code style with per-tool accent colors (`Read(path)`,
`Bash(cmd)` + one dim `⎿ result (12ms)` line), errors render as red cards with
hints. Both frontends share sessions, compaction, permission gates and MCP
provisioning — switching with `--ui` changes presentation only.

## Model picker & live catalogs — `/models`

`/models` (in the REPL) or `/connect` (to add a provider key) work in both
frontends:

- **TUI**: a searchable modal — type to filter, ↑/↓ to navigate, Enter to
  switch. Models are grouped per configured provider, free models carry a
  cyan **Free** badge, context sizes are listed on the right, the current
  model is dot-marked, and a **Recent** section lists your last used models.
- **Plain**: a clack select with the same data (15 visible, scrollable).

Lists are fetched live from each provider's models endpoint
(`openrouter.ai/api/v1/models`, `api.openai.com/v1/models`,
`api.anthropic.com/v1/models`, `generativelanguage.googleapis.com/v1beta/models`),
cached per session for 10 minutes. Free detection is OpenRouter-specific:
an `:free` id suffix or zero listed price for both directions.

## REPL commands

| Input | Effect |
| --- | --- |
| anything else | Send the task to the agent |
| `/models` | Live model picker across your configured providers (search, Free badges, recents) |
| `/model` | Show the current model |
| `/model <provider:model>` | Switch models mid-session (window + compaction recalibrate; token counters reset) |
| `/connect` | Store an API key for a provider (`~/.harness/auth.json`) — no restart needed |
| `/clear` (TUI) | Clear the transcript view and start fresh (context and session stay) |
| `/help` | Show commands |
| `/exit`, `/quit` | End the session (transcript is already saved) |
| `Ctrl+C` while running | Abort the current run; the session stays usable |

### Typing in the input box

The prompt behaves like a modern TUI editor, not a dumb one-liner:

- **Blinking block cursor at the real edit position** — at the start of the
  placeholder when the box is empty (never trailing it), mid-text while you
  fix a typo with `←`/`→`, `Home`/`End` or `Ctrl+A`/`Ctrl+E`.
- **`/` command menu** — type `/` and a filtered list of commands appears
  above the box with descriptions (claude-code style): keep typing to filter,
  ↑/↓ to select, `Tab` completes args-taking commands like `/model`, `Enter`
  runs argless ones, `Esc` dismisses.
- **Readline habits work**: `Ctrl+U` kills to the cursor, `Ctrl+K` to the
  end, `Ctrl+J` inserts a newline for multi-line prompts, `↑`/`↓` walk your
  input history.
- **Plain frontend**: `Tab` completes slash commands (same registry), `Ctrl+D`
  ends the session cleanly.

Every mutating tool call (`write_file`, `edit_file`, `bash`) asks for
permission: **allow once / always this session / deny**. Reads are auto-allowed
by default (`grep`, `glob`, `list_dir` included). Sessions are appended to
`.harness/sessions/<uuid>.jsonl` and contain **no secrets** — only metadata,
messages, and token usage.

### Terminal output (plain renderer)

The plain renderer produces claude-code/opencode-style output: one header line per tool call
with its most useful arguments, one dim result line under it, streamed
assistant text, a thinking spinner while the model works, and a compact
per-turn summary:

```text
● Grep(.*, packages)
  ⎿ 42 lines (126ms)
  Reading the failing tests…
  ⎿ done (stop)
› 4 steps · 124k in / 1.2k out · context ~47% of 262k · ~$0.0042 · stop
```

Failures are a single red sentence (`✗ …`) with an actionable hint — never a
stack trace. Pass `--debug` when filing bugs. MCP tools appear as
`server/tool` in the display (`mcp__server__tool` internally).

## Headless runs — scripts & CI

`harness run` is the non-interactive front door: one prompt, one exit code.
There is no human to approve tool calls mid-run, so calls not covered by
config allow rules are **denied by default** — `--yolo` is the explicit
escape hatch for sandboxed environments.

```sh
# As an argument:
harness run "fix the failing test in src/auth and run the suite"

# Piped in (like `cat`):
echo "summarize the diff on this branch" | harness run

# Machine-readable output — a single JSON result:
harness run --format json "list files changed last week"

# Continue the directory's latest session (same semantics as the REPL):
harness run --continue "now write the changelog"
```

Exit codes: `0` success · `1` run error · `130` aborted. `--format json`
prints one object with `ok`, `stopReason`, `steps`, `usage`, `contextTokens`,
`contextWindow`, `costUsd`, `text`, `sessionPath`, and `mcpErrors` — pipe it
to `jq` or parse it in CI scripts:

```yaml
# GitHub Actions example
- run: bunx harness run --format json "${{ inputs.task }}" > result.json
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

## MCP servers (Model Context Protocol)

The harness speaks MCP over stdio with a **zero-dependency client** (JSON-RPC
2.0, initialize handshake, `tools/list`, `tools/call`). Configure servers in
any config layer; every tool a server advertises joins the registry as
`mcp__<server>__<tool>` and flows through the same permission gate, event
bus, renderer, and compaction pipeline as builtin tools — there is no side
door.

```json
{
  "mcpServers": {
    "fs":    { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fs", "/tmp"] },
    "my-db": { "command": "bun",  "args": ["run", "tools/db-server.ts"], "env": { "DB_URL": "postgres://…" } }
  }
}
```

- Server names may contain letters, digits, `-`, `_`; servers are validated
  at boot and a broken server is a **warning, not a boot failure** (the rest
  of the fleet still connects).
- MCP tools are classified `write` risk — interactive mode asks once per
  tool; headless runs deny unless a rule allows. Tool-name wildcards work:
  `"allow": ["mcp__fs__*"]`, `"deny": ["mcp__my-db__*"]`.
- Input validation is the server's job (JSON Schema is passed through to the
  model verbatim); harness treats arguments as untrusted data.
- Startup timeout 15s, per-call timeout 60s, servers are shut down cleanly
  on exit (`SIGTERM`, then `SIGKILL`).

## SDK — `createHarness()`

`@harness/sdk` exposes the exact wiring the CLI uses, as one object:

```ts
import { createHarness } from "@harness/sdk";

const harness = await createHarness({
  modelRef: "openrouter:nex-agi/nex-n2.5-pro:free",
  cwd: process.cwd(),
  permissionRules: { allow: ["bash:npm *"], deny: ["bash:rm *"] },
  mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-fs"] } },
  onPermissionAsk: (request) => ({ action: "deny", reason: "read-only bot" }),
});

harness.events.onAny((event) => {
  if (event.type === "text:delta") process.stdout.write(event.text);
});

const result = await harness.run("review the diff and summarize");
console.log(result.text, result.usage.totalTokens);
await harness.close(); // shut down MCP servers
```

- **Safe by default:** with no `onPermissionAsk` and no allow rules, tool
  calls are denied with an actionable reason.
- `session: true | "continue" | false` controls transcript persistence
  (default `true`, same `.harness/sessions` layout as the CLI).
- Any AI SDK `LanguageModel` can be passed via `model:` — custom adapters and
  tests plug straight in.
- `switchModel(ref)` swaps models mid-conversation; `mcpErrors` reports
  servers that failed to connect.

## Providers & models

Four providers ship, all behind one `provider:model` syntax:

| Provider | Ref | API key env | Notes |
| --- | --- | --- | --- |
| OpenRouter | `openrouter:anthropic/claude-sonnet-4.5` | `OPENROUTER_API_KEY` | One key, hundreds of models (default provider) |
| OpenAI | `openai:gpt-4.1` | `OPENAI_API_KEY` | Chat Completions API |
| Anthropic | `anthropic:claude-sonnet-4-5` | `ANTHROPIC_API_KEY` | Accepts both `claude-sonnet-4.5` and `claude-sonnet-4-5` spellings |
| Google Gemini | `google:gemini-2.5-pro` | `GOOGLE_GENERATIVE_AI_API_KEY` (or `GOOGLE_API_KEY`) | |

Missing keys fail fast with an actionable hint (which env var, where to get
a key). Self-hosted and proxied endpoints: `OPENAI_BASE_URL`,
`ANTHROPIC_BASE_URL`, `GOOGLE_BASE_URL` override the API endpoints.

`harness models` prints the whole picture — providers with credential
status, direct-provider model ids, and the catalog (context windows,
advertised \$/Mtok prices):

```sh
bun run dev -- models
```

The engine consumes the AI SDK `LanguageModel` abstraction, so the loop,
compaction, permissions, and sessions are provider-agnostic — the same run
works identically over OpenRouter or a direct key.

### Permission policy rules

Config layers (including `.harness.json`) can declare allow/deny rules that
are evaluated **before** any prompt — deny always wins, even under `--yolo`:

```json
{
  "permissions": {
    "allow": ["bash:npm *", "bash:git status"],
    "deny": ["bash:rm *", "read_file:.secrets/**"]
  }
}
```

Rules are `tool` or `tool:pattern`. Bash patterns are full-string wildcards
(`*` crosses `/`, so `rm *` matches `rm -rf /`); file-tool patterns are real
globs over paths (`**` crosses segments, dotfiles included). The tool part
may itself contain wildcards (`mcp__fs__*`) for tools whose names are only
known at runtime. Unknown rules are rejected at boot, never mid-session.

### Secret redaction

Before bash output reaches the model, values of environment variables whose
names look secret-bearing (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
`*PASSPHRASE*`, `*CREDENTIAL*`, length ≥ 8) are replaced with
`***REDACTED***` — so `env`, `printenv`, or a stray config dump cannot leak
credentials into model context.

### YOLO mode

`--yolo` skips every prompt (AllowAllGate) after printing an explicit warning.
It is intended for sandboxed or throwaway environments; deny rules still apply.

### Continuing sessions

Every turn is appended to `.harness/sessions/<uuid>.jsonl`. `--continue`
reopens the most recent transcript **for the current directory** and replays
its history into a live conversation; new turns append to the same file.
Interrupted runs leave half-finished tails (a dangling user prompt, or an
assistant tool-call whose result never landed) — resume cuts the history back
to the last *closed* boundary, so the provider always receives a protocol-valid
conversation. The dropped tail stays on disk; nothing is deleted.

### Context compaction & retries

The harness knows each catalog model's real context window. When the context
crosses `compaction.triggerRatio` of the window, the oldest turns are replaced
by a model-written handoff note (goal, file paths, command outcomes, decisions,
next steps) and the newest `compaction.keepRecentMessages` are kept verbatim.
Compaction is best-effort: if the summarization call fails, the run proceeds
uncompacted rather than aborting your task. The renderer prints
`⟳ compacted context: N → M tokens`, and the post-run summary shows
`context ~X% of 262k`.

Models **not** in the catalog get a conservative assumed window (131k) so
compaction still works — with a hint to set `contextWindow` if you know
better. Two signals keep the estimate honest:

- **Provider telemetry wins.** The char-based estimator can drift up to ~3x
  low on tool-output-heavy histories. The last step's provider-reported input
  tokens are remembered across turns and override the estimate for compaction
  decisions and the context-usage display.
- **In-run overflow recovery.** If the provider rejects a request with
  `context_length_exceeded`, the loop parses the real limit out of the error,
  mechanically truncates the history to 60% of it (a truncation note replaces
  the dropped messages — no model call, because a summarizer would be rejected
  for the same reason), retries once, and adopts the learned window for the
  rest of the session. History sent back to the model may end on the user's
  turn (that is where work resumes); unresolved tool-call exchanges and orphan
  results are always cut.

Transient provider errors (rate limits, 5xx, network blips) are retried with
exponential backoff — `retries.maxAttempts` per model call, default 3,
`0` disables. Non-retryable errors (bad request, auth) fail fast — with a
**clean one-line message**: provider envelopes (OpenRouter's nested
`metadata.raw` JSON, `[Provider] …` prefixes) are unwrapped to the single
sentence that matters, never a stack trace or request dump. `--debug`
(or `HARNESS_DEBUG=1`) restores full detail, including raw provider payloads
and unhandled-rejection dumps.

Each turn the REPL injects a fresh **repository context** into the system
prompt: current branch, pending changes, recent commits, and the top-level
layout — so the model starts oriented instead of probing blindly.

## Configuration

Precedence (later wins), validated with Zod at every boundary:

```text
defaults
  ↓  ~/.harness/config.json
  ↓  .harness.json                (project root)
  ↓  environment                  (HARNESS_MODEL)
  ↓  CLI flags                    (--model)
```

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `openrouter:anthropic/claude-sonnet-4.5` | Model id (`provider:model`) |
| `ui` | `auto` | Chat frontend: `tui`, `plain`, or `auto` (TUI on interactive terminals) |
| `maxSteps` | `25` | Agent-loop step budget |
| `maxTotalTokens` | unlimited | Cumulative input+output token cap per run |
| `contextWindow` | catalog, else 131k assumed | Override the context window used for compaction math |
| `compaction.enabled` | `true` | Summarize old turns as the window fills |
| `compaction.triggerRatio` | `0.8` | Compact above this fraction of the window |
| `compaction.keepRecentMessages` | `6` | Newest messages kept verbatim |
| `retries.maxAttempts` | `3` | Transient-error retries per model call (0 disables) |
| `permissions.autoAllowReads` | `true` | Auto-allow read-classified tools |
| `permissions.allow` / `permissions.deny` | `[]` | Policy rules evaluated before prompts (deny wins; wildcard tool parts like `mcp__fs__*` supported) |
| `mcpServers` | `{}` | MCP stdio servers; tools become `mcp__<server>__<tool>` |
| `truncation.toolOutputMaxChars` | `30000` | Per-tool-output cap before it reaches the model |

Nested config objects (`permissions`, `truncation`, `compaction`, `retries`)
merge **field-by-field** across layers — a project overriding one knob does
not reset the others. Arrays (rule lists) replace wholesale, and
`mcpServers` records merge **per server**: a project defining one server
does not reset the others, while redefining a server replaces it entirely.

## Architecture notes

- **Event bus.** The loop emits a typed `HarnessEvent` union
  (`step:start`, `text:delta`, `tool:call`, `tool:result`, `usage`, `done`, …).
  Renderers switch exhaustively — the compiler flags unhandled event types.
  The plain renderer and the Ink TUI consume the same stream; the TUI pipes it
  through a pure reducer so transcript logic is unit-tested without mounting.
- **Errors as data.** Tool results are `{ ok: true, data } | { ok: false, error, hint }`;
  tools never throw for expected failure modes, so the model always receives
  actionable feedback.
- **Nothing enters unparsed.** Tool inputs, env vars, layered config, and
  session JSONL are all schema-validated (Zod 4.5). Session lines use a
  versioned discriminated union (`v: 1`) so old transcripts stay migratable.
- **Read-before-edit.** `edit_file` and overwriting `write_file` refuse to act
  unless the file was read this session and hasn't changed on disk since.
- **Path containment.** File tools resolve real paths (symlink-aware) and
  refuse anything outside the project root.
- **Safe navigation.** `grep` shells out to vendored ripgrep (JSON-parsed,
  exit-code aware); `glob` uses a bounded, symlink-proof walker; both skip
  `.git`/`node_modules` by default so results stay relevant.
- **Policy engine.** `PolicyGate` composes over any gate: config deny rules
  refuse calls first, allow rules auto-approve, the rest falls through to the
  interactive prompt. Deny beats allow beats fallback — always. Wildcard
  tool parts (`mcp__fs__*`) match runtime-discovered MCP tool names.
- **MCP as first-class tools.** The stdio client is hand-rolled JSON-RPC
  (no SDK, no zod@3 conflict); advertised tools become standard
  `ToolDefinition`s with raw JSON Schema input, validated server-side, and
  ride the same gate/events/truncation as builtins.
- **Cost awareness.** A code-versioned model catalog (context window, max
  output, advertised \$/Mtok prices) powers per-run cost estimates; unknown
  models simply omit the estimate instead of fabricating one.
- **Bounded outputs.** Every tool result passes a head+tail truncator before
  reaching the model; bash spawns are time-capped and killed as a process
  group, including on abort.
- **Stop conditions & compaction.** The loop stops on `stepCountIs(maxSteps)`
  and on a cumulative token budget. Before each run, context is estimated
  (CJK-aware char heuristic) and compacted against the model's real window —
  fail-open, with the event bus reporting `before → after` tokens.

## Testing

- **Unit** — tools against tmp-dir fixtures; pure logic (model-ref parsing,
  config merge, permission decisions, path containment, truncation, tracker,
  session load/migration, event bus) in isolation.
- **Agent-loop integration** — AI SDK `MockLanguageModelV4` scripts
  deterministic tool-call sequences: model → tool call → permission
  evaluation → execution → result → next step → completion. Zero network,
  zero cost.
- **Real-model smoke** — `bun run smoke` runs one inexpensive model call on
  any configured provider (`HARNESS_SMOKE_MODEL`, default OpenRouter);
  wired as a scheduled CI job behind `OPENROUTER_API_KEY` so normal CI never
  touches external services.

## Version pins

Exact pins for the v1 cycle (per the version-pinning policy):

| Package | Version |
| --- | --- |
| bun | 1.4.2 |
| typescript | 7.0.2 |
| ai | 7.0.97 |
| @openrouter/ai-sdk-provider | 3.0.0 |
| @ai-sdk/openai | 4.0.65 |
| @ai-sdk/anthropic | 4.0.52 |
| @ai-sdk/google | 4.0.67 |
| zod | 4.5.4 |
| commander | 15.0.0 |
| @clack/prompts | 1.8.0 |
| ink / react | 7.1.1 / 19.3.0 |
| oxlint / oxfmt | 1.82.0 / 0.67.0 |
| vitest | 5.0.0 |
| @changesets/cli | 3.0.2 |
| @vscode/ripgrep | 1.18.0 |
| picomatch | 4.0.7 |

Dependency updates must pass the full `bun run verify` suite before merging.

## Distribution — standalone binaries & npm publishing

### Standalone executables

```sh
bun run build:bin                    # all five targets → dist/
bun run build:bin bun-windows-x64    # one target only
```

`scripts/build-binaries.sh` wraps `bun build --compile` and cross-compiles
single-file executables that embed the Bun runtime plus the entire workspace
(engine, tools, providers, Ink TUI) — the target machine needs **no Bun
install**:

| Target | Output |
| --- | --- |
| `bun-linux-x64` / `bun-linux-arm64` | `dist/harness-linux-*` |
| `bun-darwin-x64` / `bun-darwin-arm64` | `dist/harness-darwin-*` |
| `bun-windows-x64` | `dist/harness-windows-x64.exe` |

Each binary is ~90–100 MB (it *is* the runtime). The grep tool automatically
degrades to a system `rg` on PATH when the optional `@vscode/ripgrep` platform
binary is not present in the bundle — install ripgrep for the best grep
experience, everything else works out of the box. Bytecode is deliberately
off: Bun bytecode does not support the top-level await in the CLI entry.

### Windows notes — "the exe doesn't open"

A console app launched from Explorer opens a console window that **closes the
instant the process exits** — if boot fails, it looks like the exe "doesn't
open". Harness handles this the OpenCode way:

1. **The exe opens and onboards itself now**: with no key stored, the TUI
   boots straight into its **Connect provider** dialog — pick a provider,
   paste the key (saved to `C:\Users\<you>\.harness\auth.json`), then pick a
   model from the live catalog. You can also pre-provision from any terminal:
   `harness auth openrouter <key>` — from then on the exe works from anywhere
   (Explorer, Win+R, terminals) with no dialog.
2. If something still fails, the CLI **pauses on fatal errors** for bare
   launches ("Press Enter to close…") so you can read the message.
3. Run it from a real terminal for the best experience: Windows Terminal,
   VS Code's terminal, or a plain `cmd`/PowerShell window get the full Ink
   TUI. Inside MSYS/mintty the exe falls back to the plain renderer
   automatically (a native console app cannot enter raw mode through the
   MSYS pty) — use `--ui plain` explicitly if you prefer.
4. If Microsoft Defender or SmartScreen blocks the unsigned exe, unblock it
   via file Properties, or add a Defender exclusion for the file.

### Publishing the packages

The five workspace packages ship as Bun-native TypeScript source (no build
step — `bun` runs `.ts` directly) with `exports` maps, `files` whitelists,
`engines: bun >= 1.4.2`, the MIT `LICENSE`, and a pending changeset. They are
publish-ready; the only decision left is the npm scope:

1. **Pick your scope.** `@harness/*` is a placeholder — rename it to your own
   npm org (find & replace `@harness/` across `packages/*/package.json` and
   all import specifiers, or keep it if you own the org).
2. **Version.** `bun run changeset:version` consumes the pending changeset
   (bumps every package to `0.2.0` in one go) and rewrites workspace ranges.
3. **Publish.** `npm publish -ws --access public` (or per package with
   `npm publish -w @harness/core`) — `npm pack --dry-run` validates the
   tarball first (the CLI packs to ~24 kB, source only).
4. **Install anywhere with Bun:** `npm i -g @harness/cli@latest` then run
   `harness` — the `bin` entry points at the Bun-source script with a
   `#!/usr/bin/env bun` shebang. End users who prefer zero-install should use
   the compiled binaries above.

## Roadmap

- **Phase 2 — Navigation:** `grep` (vendored ripgrep), `glob`, `list_dir`,
  repo-context system prompt, robust model metadata — **done**.
- **Phase 3 — Security & permissions:** policy engine (allow/deny rules),
  env-secret redaction, `--yolo` warnings — **done**.
- **Phase 4 — Context & reliability:** token budgets, compaction,
  `--continue` session resume, transient-error retries — **done**.
- **Phase 5 — Multi-provider:** direct OpenAI/Anthropic/Google adapters,
  `models` command, OpenRouter pricing/metadata cache — **done**.
- **Phase 6 — Extensibility:** MCP stdio bridge, headless `run` command
  (text/JSON/exit codes/CI), `@harness/sdk` `createHarness()` — **done**.
- **Phase 7 — TUI + distribution:** Ink TUI frontend, standalone binaries
  via `bun build --compile`, npm publish readiness — **done**.
- **Phase 8 — UX release:** credential vault (`~/.harness/auth.json`) +
  onboarding so double-clicked exes boot, live `/models` picker with Free
  badges and recents, `/connect`, welcome hero, bordered input, per-tool
  accent colors, TUI→plain fallback, pause-on-fatal for bare launches —
  **done**.
