<div align="center">

# thakurcode

**A fast, autonomous, multi-model AI coding agent for your terminal.**

[![Release](https://img.shields.io/github/v/release/thakurdotdev/thakur-cli?color=00d26a&label=release)](https://github.com/thakurdotdev/thakur-cli/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/thakurdotdev/thakur-cli/releases)

`thakurcode` brings an intelligent coding assistant directly into your terminal. It reads, writes, and edits files, executes shell commands, runs tests, and integrates with custom MCP tools — while keeping you in full control with interactive permission approval gates.

[Installation](#installation) • [Quick Start](#quick-start) • [Interactive TUI](#interactive-tui-experience) • [Commands](#slash-commands) • [Headless Mode](#headless--scripting-mode) • [MCP Extensibility](#mcp-extensibility)

---

</div>

## Features

- **Terminal UI (TUI)**: Fast, responsive terminal interface with streaming model responses, real-time tool logs, and live context tracking.
- **Universal Model Support**: Connect to **Anthropic** (Claude 3.7 Sonnet / 3.5 Sonnet), **OpenAI** (GPT-4o / o3-mini), **Google** (Gemini 2.5 Pro / Flash), or **OpenRouter** (DeepSeek, Llama 3, and 200+ models).
- **Full Coding Capabilities**: Inspects files, performs fast regex searches via ripgrep, edits code surgically, and runs bash commands.
- **Permission Safety First**: Every file modification and command execution requires your explicit approval (`Allow once`, `Always this session`, `Deny`).
- **Model Context Protocol (MCP)**: Easily plug in external tools like databases, browser automation, and custom scripts via stdio MCP.
- **Context Awareness & Resume**: Smart memory management with auto-compaction and seamless session resuming (`--continue`).
- **Headless Automation**: Run automated tasks, CI reviews, and batch edits via `thakurcode run "..."`.
- **Single-Binary Zero Setup**: Pre-compiled standalone binaries with no runtime or package dependencies required.

---

## Installation

### macOS and Linux

Install or update `thakurcode` with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.sh | bash
```

### Windows (PowerShell)

Run in PowerShell:

```powershell
powershell -c "irm https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.ps1 | iex"
```

### Standalone Executables

You can also download pre-built binaries directly from [GitHub Releases](https://github.com/thakurdotdev/thakur-cli/releases):

| Platform | Executable Asset |
| :--- | :--- |
| **macOS (Apple Silicon)** | `thakurcode-darwin-arm64` |
| **macOS (Intel)** | `thakurcode-darwin-x64` |
| **Linux (x86_64)** | `thakurcode-linux-x64` |
| **Linux (ARM64)** | `thakurcode-linux-arm64` |
| **Windows (x64)** | `thakurcode-windows-x64.exe` |

---

## Quick Start

### 1. Start the CLI

Open your terminal in any project directory and run:

```bash
thakurcode
```

### 2. Connect Your API Key

#### Option A: In-App Dialog (Easiest)
If no key is configured on first launch, `thakurcode` opens an interactive setup prompt. Select your provider, paste your API key, and you're ready to go.

#### Option B: Terminal Command
Store your keys once from the terminal:

```bash
# OpenRouter (Access 200+ models with one key — recommended)
thakurcode auth openrouter sk-or-...

# Anthropic (Claude 3.7 Sonnet, Claude 3.5 Sonnet)
thakurcode auth anthropic sk-ant-...

# OpenAI (GPT-4o, o3-mini)
thakurcode auth openai sk-proj-...

# Google Gemini (Gemini 2.5 Pro, Flash)
thakurcode auth google AIza...
```

#### Option C: Environment Variables
You can also use standard environment variables:

```bash
export OPENROUTER_API_KEY="sk-or-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-proj-..."
export GOOGLE_GENERATIVE_AI_API_KEY="AIza..."
```

Check your connection status at any time:

```bash
thakurcode auth
```

---

## Interactive TUI Experience

Once running, type your instructions naturally in the prompt. `thakurcode` investigates your codebase, proposes changes, and asks for confirmation before executing actions.

### Slash Commands

Type `/` at the prompt to access built-in commands:

| Command | Action |
| :--- | :--- |
| `/models` | Open the interactive model picker (browse live catalog, search, filter free models, recents) |
| `/model` | Show current model, provider, and context window utilization |
| `/model <provider:model>` | Switch models instantly (e.g. `/model anthropic:claude-sonnet-4-5`) |
| `/connect` | Add or update provider API keys without leaving your chat |
| `/clear` | Clear the visual terminal screen while preserving session context |
| `/help` | Display quick help and shortcuts |
| `/exit`, `/quit` | Exit `thakurcode` (sessions are saved automatically) |

### Keyboard Shortcuts

- **`Enter`**: Submit prompt or confirm selection
- **`↑` / `↓`**: Cycle through command history or navigate menus
- **`Tab`**: Autocomplete slash commands and model names
- **`Ctrl+J`**: Insert a line break for multi-line instructions
- **`Esc`**: Close open dialogs or interrupt generation
- **`Ctrl+C`**: Stop current tool execution; exit when idle

---

## Safety & Permission Controls

`thakurcode` is designed to be safe on your local machine:

- **Safe Inspection**: Read operations (`read_file`, `grep`, `glob`, `list_dir`) are safe and run automatically.
- **Confirmation Prompts**: Any action that modifies files (`write_file`, `edit_file`) or executes shell commands (`bash`) requests your permission:
  - **Allow once** (`y`): Approve this execution.
  - **Always this session** (`a`): Approve this command or tool for the entire session.
  - **Deny** (`d`): Reject the execution with feedback sent to the model.
- **Secret Protection**: Sensitive environment variables matching passwords, keys, and tokens are automatically masked (`***REDACTED***`).
- **Sandbox Mode**: For CI or disposable docker environments, pass `--yolo` to bypass prompts (`thakurcode --yolo`).

---

## Headless & Scripting Mode

Use `thakurcode run` for non-interactive automation, CI/CD checks, and terminal pipelines:

```bash
# Run a single task
thakurcode run "Fix type errors across src/ and run the test suite"

# Pipe input via stdin
git diff main | thakurcode run "Summarize these changes into clean commit notes"

# Resume previous session in headless mode
thakurcode run --continue "Now generate documentation for the changes you made"

# Output structured JSON for automation
thakurcode run --format json "Audit package dependencies" > report.json
```

### GitHub Actions Integration

```yaml
name: Code Review Agent
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install thakurcode
        run: curl -fsSL https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.sh | bash
      - name: Run Review
        run: |
          ~/.thakurcode/bin/thakurcode run --yolo "Review git diff origin/main...HEAD and identify potential bugs"
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

---

## MCP Extensibility

Extend `thakurcode` with custom tools using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Configure your servers in `.harness.json` in your repository root:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432/mydb"]
    }
  }
}
```

Connected tools are automatically discovered and become available to the agent with the same permission gates as built-in tools.

---

## License

This project is licensed under the [MIT License](LICENSE).
