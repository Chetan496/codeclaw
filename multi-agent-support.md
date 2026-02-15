# Multi-Agent Support: Supporting Non-SDK CLI Tools

## Current Architecture

CodeClaw currently integrates with Claude Code via its programmatic SDK (`@anthropic-ai/claude-agent-sdk`). The SDK provides:

- A `query()` function returning an async iterator of structured events
- A `canUseTool(toolName, input, options)` callback for permission handling
- Typed results with metadata (cost, turns, session ID)

This is implemented in `claude-handler.js`. The permission flow works through a promise-bridge pattern: the SDK fires `canUseTool`, we send a WhatsApp message, and resolve the promise when the user quotes-replies with yes/no/always.

## The Problem

Other AI coding tools (Kiro CLI, Amazon Q, etc.) don't provide an SDK with structured events. They're interactive CLI processes that write prompts to stdout and read responses from stdin. There's no `canUseTool` callback — just terminal output.

## Code Rendering: Freeze vs carbon-now-cli

For rendering code screenshots sent to users, the project uses [Freeze](https://github.com/charmbracelet/freeze) (Charm). We evaluated carbon-now-cli as an alternative.

| Criterion | Freeze | carbon-now-cli |
|---|---|---|
| Runtime | Single Go binary | Node.js + Playwright (headless browser) |
| Install size | ~15 MB | ~200-500 MB |
| Speed | Near-instant | 2-5s (browser spin-up) |
| Output formats | SVG, PNG, WebP | PNG, SVG |
| Terminal capture | Yes (`--execute`) | No |
| Dependencies | None | Chromium/Firefox/WebKit |
| Docker/CI friendly | Excellent | Difficult |

**Decision: Stay with Freeze.** It's faster, lighter, has zero runtime dependencies, and is a better fit for on-the-fly screenshot generation in a WhatsApp bot context. The only advantage of carbon-now-cli is Carbon's visual aesthetic, which doesn't justify the 200-500MB browser dependency and multi-second latency per screenshot.

## Proposed Architecture for Multi-Agent Support

```
index.js (router)
    │
    ▼
AgentHandler (interface)
    │
    ├── ClaudeHandler     — uses SDK (structured events, canUseTool callback)
    ├── KiroHandler       — uses PTY (terminal scraping, pattern matching)
    └── AmazonQHandler    — uses PTY (terminal scraping, pattern matching)
```

### Common Interface

All agent backends would implement the same contract that `index.js` talks to:

```js
class AgentHandler {
  async execute(chatId, prompt, sendFn, opts) { }
  resolvePermission(stanzaId, decision) { }
  abort(chatId) { }
  clearSession(chatId) { }
  get activeCount() { }
  get pendingPermCount() { }
}
```

`ClaudeHandler` already matches this shape. The refactor is just formalizing it.

### PTY Adapter for Non-SDK Tools

For CLI-only tools, the adapter would use `node-pty` to spawn the process in a pseudo-terminal:

```js
import { spawn } from "node-pty";

class PtyAgentHandler extends AgentHandler {
  async execute(chatId, prompt, sendFn, opts) {
    const pty = spawn("kiro", [prompt], { cwd: opts.workingDir });

    pty.onData((data) => {
      // 1. Strip ANSI escape codes
      // 2. Detect permission prompts via regex
      // 3. Buffer and forward output to sendFn
      // 4. Detect completion (process exit)
    });
  }
}
```

### Hard Problems with PTY Approach

- **Permission detection is fragile.** Regex-matching terminal output for prompts like "Allow edit to foo.js? [y/n]" is brittle and breaks when tools update their output format.
- **No structured results.** No cost, turn count, or typed result objects — just raw text.
- **ANSI escape codes.** Color codes, cursor movement, and spinners must be stripped/parsed. Libraries like `strip-ansi` help, but TUI-heavy tools are harder.
- **Timing.** The PTY blocks on stdin when asking for permission. You write back `y\n` when the user replies via WhatsApp. Timeout handling needs care.

### Why Not tmux?

We considered spawning tools inside tmux sessions for session persistence (surviving Node.js restarts). The tradeoff:

**Pros:**
- Session survives bot restarts
- Manual attach for debugging (`tmux attach -t session`)
- Clean session management via tmux commands

**Cons:**
- **Polling-based.** tmux has no push mechanism — you must poll `capture-pane` to detect new output, adding latency or CPU waste.
- **Lost state anyway.** Even if the tmux session survives a restart, the in-memory `pendingPerms` Map is gone, so you can't reconstruct which permission prompt was pending.
- **Extra layer.** Managing tmux sessions, log files, and cleanup adds complexity over in-process node-pty.

A hybrid (tmux for persistence + tee to a log file + `fs.watch` for real-time events) is possible but over-engineered for a single-user bot.

**Decision: Use node-pty directly.** It's event-driven, in-process, and simpler. tmux would make sense for a multi-user system where sessions must outlive the controlling process by design.

## Recommended Next Steps

1. **Extract the interface** — formalize the `AgentHandler` contract so `index.js` is decoupled from `ClaudeHandler` specifics. Small refactor, worth doing now.
2. **Wait for SDKs** — Amazon Q and Kiro are both trending toward programmatic APIs. A PTY scraper built today means maintaining regex patterns against every CLI update.
3. **If needed now, build specific adapters** — a `KiroHandler` with hardcoded knowledge of Kiro's prompt patterns, rather than a generic PTY framework. Each tool's output format is different enough that a generic solution is premature.
