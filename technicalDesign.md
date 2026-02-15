# CodeClaw

**A WhatsApp Interface for Claude Code**

CodeClaw lets you control Claude Code from WhatsApp. Send a message describing a coding task, approve tool permissions by quoting and replying, browse your project files with numbered menus. 818 lines of code across 4 files.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Permission Flow](#permission-flow)
- [Message Routing](#message-routing)
- [File Reference](#file-reference)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Error Handling](#error-handling)
- [Troubleshooting](#troubleshooting)

---

## How It Works

1. You send a WhatsApp message to the bot (e.g. "Fix the login bug in auth.js")
2. CodeClaw passes it to the Claude Agent SDK's `query()` function
3. When Claude needs to use a tool (edit a file, run a command), the SDK invokes a `canUseTool` callback
4. CodeClaw sends you a WhatsApp message asking for permission
5. You quote that message and reply `yes`, `no`, or `always`
6. CodeClaw resolves the callback, Claude proceeds (or stops)
7. When done, the final result is sent back to you as a WhatsApp message

There are no WhatsApp buttons. The deprecated buttons API is not used. Everything is plain text with message quoting.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   WhatsApp                       │
│         (baileys WhatsApp Web protocol)          │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│              index.js — Router                   │
│                                                  │
│  1. Auth check (ALLOWED_USERS)                   │
│  2. Quoted reply? → resolve pending permission   │
│  3. Number reply? → file browser selection       │
│  4. /command?     → built-in or forward to Claude│
│  5. "browse/ls/show/cat"? → file browser         │
│  6. Default       → Claude Code query            │
└──────┬───────────────────┬───────────────────────┘
       │                   │
       ▼                   ▼
┌──────────────┐   ┌──────────────────────────────┐
│ file-browser │   │       claude-handler          │
│              │   │                               │
│ Numbered dir │   │ query() from Agent SDK        │
│ listings,    │   │ canUseTool → WhatsApp prompt  │
│ file viewer  │   │ → user quotes reply           │
│              │   │ → resolve Promise              │
│              │   │ → SDK continues               │
└──────────────┘   └──────────────────────────────┘
```

### Core Components

| File | Lines | Responsibility |
|------|-------|---------------|
| `index.js` | 205 | Entry point, env config, auth, message routing, graceful shutdown |
| `whatsapp.js` | 191 | Baileys connection, auto-reconnect, send text/image/chunked, quote detection |
| `claude-handler.js` | 250 | Agent SDK `query()`, `canUseTool` permission bridge, abort, screenshots |
| `file-browser.js` | 172 | Numbered text directory listings, file viewing, path traversal guard |

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Programmatic access to Claude Code (query, tool approval callbacks) |
| `@whiskeysockets/baileys` | WhatsApp Web protocol (connect, send/receive messages) |
| `dotenv` | Load `.env` configuration |
| `zod` | Peer dependency of the Agent SDK |

---

## Permission Flow

This is the core mechanism. The Claude Agent SDK provides a `canUseTool` callback that is invoked before every tool execution. CodeClaw bridges this callback to WhatsApp:

```
Claude decides to use Edit on src/auth.js
         │
         ▼
SDK calls canUseTool("Edit", { file_path: "src/auth.js" }, options)
         │
         ▼
claude-handler checks alwaysAllowed set
  ├─ Found → return { behavior: "allow" } immediately
  └─ Not found → continue below
         │
         ▼
Format permission prompt, send via WhatsApp:
  ┌─────────────────────────────────┐
  │ 🔧 Permission needed           │
  │                                 │
  │ Tool: Edit                      │
  │ File: src/auth.js               │
  │                                 │
  │ Quote this message and reply:   │
  │   yes - approve once            │
  │   always - always approve this  │
  │   no - deny                     │
  └─────────────────────────────────┘
         │
         ▼
Store { resolve, timer } in pendingPerms map, keyed by sent message ID
Return a Promise (SDK blocks here)
         │
    ┌────┴────────────────────┐
    │  120s timeout           │
    │  auto-deny if no reply  │
    └─────────────────────────┘
         │
         ▼
User long-presses the message, quotes it, types "yes"
         │
         ▼
WhatsApp delivers message with contextInfo.stanzaId matching the prompt
         │
         ▼
index.js sees quotedStanzaId, calls claude.resolvePermission(stanzaId, "yes")
         │
         ▼
claude-handler looks up pendingPerms[stanzaId], clears timer, resolves Promise:
  ├─ "yes"/"y"     → { behavior: "allow" }
  ├─ "always"/"a"  → { behavior: "allow" } + add tool to alwaysAllowed set
  └─ anything else → { behavior: "deny", message: "User denied" }
         │
         ▼
SDK receives the result, proceeds (or skips) the tool
```

### The Promise Bridge

The key pattern is that `canUseTool` returns a `Promise<PermissionResult>`. The Promise is stored in a Map keyed by the WhatsApp message ID. When the user's quoted reply arrives (potentially seconds or minutes later), the Promise is resolved. This bridges the synchronous SDK callback to the async WhatsApp conversation.

```javascript
// In canUseTool callback
const msgId = await sendFn(promptText);

return new Promise((resolve) => {
  const timer = setTimeout(() => {
    this.pendingPerms.delete(msgId);
    resolve({ behavior: "deny", message: "Permission timed out" });
  }, 120_000);

  this.pendingPerms.set(msgId, { resolve, timer, toolName, input });
});
```

```javascript
// When user's quoted reply arrives
resolvePermission(stanzaId, decision) {
  const perm = this.pendingPerms.get(stanzaId);
  if (!perm) return false;

  clearTimeout(perm.timer);
  this.pendingPerms.delete(stanzaId);

  if (decision === "yes") perm.resolve({ behavior: "allow" });
  else if (decision === "always") {
    this.alwaysAllowed.add(perm.toolName);
    perm.resolve({ behavior: "allow" });
  }
  else perm.resolve({ behavior: "deny", message: "User denied" });

  return true;
}
```

---

## Message Routing

All incoming messages go through `handleMessage` in `index.js`. Priority order:

```
1. AUTH CHECK
   sender JID not in ALLOWED_USERS? → ignore silently

2. QUOTED REPLY
   has quotedStanzaId? → try resolvePermission()
   if matched → done, don't route further
   if not matched → fall through (it's a normal quoted message)

3. NUMERIC REPLY
   text is a number AND file browser has an active session?
   → handleNumberReply(chatId, number)

4. SLASH COMMANDS
   /help    → send help text
   /status  → active queries, pending perms, working dir
   /abort   → abort current query for this chat
   /browse  → file browser
   /show    → file viewer
   /ls      → alias for browse
   /cat     → alias for show
   other /  → forward to Claude (handles /commit, /search, etc.)

5. PLAIN TEXT SHORTCUTS
   "browse src/" or "ls src/" → file browser
   "show index.js" or "cat index.js" → file viewer

6. DEFAULT
   → claude.execute(chatId, text, sendFn)
```

---

## File Reference

### `whatsapp.js` — WhatsApp Connection Layer

**Class: `WhatsAppClient`**

Wraps `@whiskeysockets/baileys` for connection management and messaging.

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to WhatsApp, print QR for pairing. Resolves on `connection: open`. Auto-reconnects on disconnect with exponential backoff (1s, 2s, 4s... up to 30s). Rejects only on `loggedOut`. |
| `onMessage(callback)` | `void` | Register handler: `(jid, text, quotedStanzaId, rawMsg) => void`. Filters: skips `fromMe`, skips non-text messages. Extracts `quotedStanzaId` from `contextInfo`. |
| `sendText(jid, text)` | `Promise<string>` | Send plain text. Returns the sent message's `key.id` (used for quote matching). |
| `sendImage(jid, buffer, caption)` | `Promise<string>` | Send an image with caption. Returns message ID. |
| `sendChunked(jid, text, maxLen?)` | `Promise<string[]>` | Split text at ~4000 char boundaries (prefers newline breaks), send sequentially. Returns array of message IDs. |
| `disconnect()` | `void` | Clean shutdown via `sock.end()`. |

**Auth persistence:** Credentials stored in `auth/` directory via `useMultiFileAuthState`. After first QR scan, subsequent starts reconnect automatically.

**Reconnection:** On disconnect, checks `DisconnectReason`. If `loggedOut`, stops (user must delete `auth/` and re-scan). Otherwise, reconnects with exponential backoff.

---

### `claude-handler.js` — Claude Agent SDK Integration

**Class: `ClaudeHandler`**

Manages Claude Code queries via the Agent SDK and bridges tool permissions to WhatsApp.

**State:**

| Property | Type | Description |
|----------|------|-------------|
| `workingDir` | `string` | cwd passed to every `query()` call |
| `activeQueries` | `Map<chatId, AbortController>` | One active query per chat. Rejects concurrent requests. |
| `pendingPerms` | `Map<msgId, PermEntry>` | Pending permission Promises keyed by WhatsApp message ID |
| `alwaysAllowed` | `Set<string>` | Tool names auto-approved for the session (populated by "always" replies) |

**Methods:**

| Method | Description |
|--------|-------------|
| `execute(chatId, prompt, sendFn)` | Run a Claude Code query. Sends "Working on it..." first. Iterates the SDK async generator. On `SDKResultMessage`, sends the result text (with cost footer) back via `sendFn`. Rejects if a query is already active for this chat. |
| `resolvePermission(stanzaId, decision)` | Match a quoted reply to a pending permission. Returns `true` if matched. |
| `generateScreenshot(code, language)` | Run Freeze CLI to produce a PNG. Returns `Buffer` or `null` if Freeze is unavailable. Cleans up temp files. |
| `abort(chatId)` | Abort the active query for a chat. |
| `abortAll()` | Abort all queries and deny all pending permissions. Used during shutdown. |

**SDK query options used:**

```javascript
query({
  prompt,
  options: {
    cwd: this.workingDir,
    permissionMode: "default",
    canUseTool,          // permission bridge callback
    abortController: ac, // for cancellation
  },
})
```

**Tool description formatting:** The `_formatToolDescription` method produces readable summaries for each tool type:

| Tool | Format |
|------|--------|
| Edit, Write, Read | `File: <path>` |
| Bash | `Command: <command>` |
| Glob, Grep | `Pattern: <pattern>` |
| WebFetch | `URL: <url>` |
| WebSearch | `Query: <query>` |
| Other | `Input: <truncated JSON>` |

---

### `file-browser.js` — File Navigation

**Class: `FileBrowser`**

Provides directory browsing and file viewing using numbered text menus.

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `browse(chatId, dirPath)` | `{ text }` | List directory contents as a numbered menu. Stores listing in session for number-reply resolution. Filters hidden files, sorts dirs first. |
| `handleNumberReply(chatId, number)` | `{ type, text }` | Resolve a numeric reply against the stored listing. If dir, recursively browse. If file, view it. |
| `viewFile(filePath)` | `{ text, content?, language? }` | Read a file, return with syntax-highlighted markdown code block. Truncates at 200 lines. |
| `hasActiveSession(chatId)` | `boolean` | Check if a browse session exists for this chat. |

**Security:** All paths are resolved against `rootDir` and validated to not escape it. `path.resolve()` + `startsWith()` check prevents traversal attacks.

**Browse output example:**

```
📁 src (5 items)

1. 📁 components/
2. 📁 utils/
3. 📄 app.js
4. 📄 index.js
5. 📄 router.js

Reply with a number to open.
```

---

### `index.js` — Entry Point

**Responsibilities:**

- Load `.env` config via `dotenv/config`
- Parse `ALLOWED_USERS` into a `Set` of JIDs
- Instantiate `WhatsAppClient`, `ClaudeHandler`, `FileBrowser`
- Register `handleMessage` as the WhatsApp message callback
- Handle SIGINT/SIGTERM for graceful shutdown

**Auth:** If `ALLOWED_USERS` is empty, all senders are allowed. Otherwise, sender JID must be in the set. Phone numbers without `@` are auto-suffixed with `@s.whatsapp.net`.

**sendFn pattern:** Each message handler call creates a `sendFn` closure bound to the sender's JID. This closure auto-chunks messages over 4000 characters and always returns the sent message ID (needed for permission quote matching).

---

## Installation

### Prerequisites

- Node.js 20+
- An active WhatsApp account
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`) and authenticated

### Setup

```bash
git clone <repo-url> codeclaw
cd codeclaw
npm install
```

Copy and edit the environment file:

```bash
cp .env.example .env
```

```bash
# .env
WORKING_DIR=/path/to/your/project
ALLOWED_USERS=1234567890
```

### Optional: Install Freeze (code screenshots)

```bash
# Ubuntu/Debian
sudo snap install charm-freeze

# Or via Go
go install github.com/charmbracelet/freeze@latest

# Or via Homebrew (macOS)
brew install charmbracelet/tap/freeze
```

Freeze is optional. If not installed, screenshots are skipped and code is sent as text.

### Run

```bash
node index.js
```

On first run, a QR code appears in the terminal. Scan it with WhatsApp: **Settings > Linked Devices > Link a Device**. After the first scan, the session persists in the `auth/` directory and reconnects automatically.

---

## Usage

### Coding Tasks

Send any text message and it goes straight to Claude Code:

```
You: Fix the null pointer in src/auth.js

Bot: Working on it...

Bot: 🔧 Permission needed
     Tool: Edit
     File: src/auth.js
     Quote this message and reply:
       yes - approve once
       always - always approve this tool
       no - deny

You: [quote the message] yes

Bot: Fixed the null pointer bug in src/auth.js.
     Added a null check before accessing user.token on line 42.
     ---
     $0.0312 | 3 turns
```

### Browsing Files

```
You: browse src

Bot: 📁 src (5 items)

     1. 📁 components/
     2. 📁 utils/
     3. 📄 app.js
     4. 📄 index.js
     5. 📄 router.js

     Reply with a number to open.

You: 3

Bot: 📄 src/app.js (42 lines, javascript)
     ```javascript
     import express from 'express';
     ...
     ```
```

### Commands

```
/help               Show command reference
/status             Active queries, pending permissions, working dir
/abort              Cancel the current Claude Code task
/browse <dir>       Browse a directory
/show <file>        View a file
/ls <dir>           Alias for browse
/cat <file>         Alias for show
```

Slash commands not listed above (e.g. `/commit`, `/search`) are forwarded directly to Claude Code.

### Permission Replies

When Claude needs tool approval, it sends a permission message. To respond:

1. **Long-press** the permission message in WhatsApp
2. Tap **Reply**
3. Type one of:
   - `yes` or `y` — approve this one use
   - `always` or `a` — approve this tool for the rest of the session
   - `no` or `n` (or anything else) — deny

If you don't reply within 2 minutes, the tool is automatically denied.

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKING_DIR` | No | Absolute path to your project. Defaults to `process.cwd()`. |
| `ALLOWED_USERS` | No | Comma-separated phone numbers (country code, no `+`). Empty = allow all. |

### Claude Code Settings

CodeClaw uses the standard Claude Code permission system. Pre-approve safe operations in `~/.claude/settings.json` to reduce permission prompts:

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git status)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)"
    ]
  }
}
```

Tools in the `allow` list will never trigger a WhatsApp permission prompt. Tools in `deny` will be blocked without asking. Everything else goes through the `canUseTool` callback (i.e. WhatsApp prompt).

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| WhatsApp disconnects | Auto-reconnect with exponential backoff (1s to 30s) |
| WhatsApp logged out | Fatal error, requires deleting `auth/` and re-scanning QR |
| Permission timeout (120s) | Auto-deny, Claude receives `{ behavior: "deny" }` |
| Concurrent query on same chat | Rejected with "A task is already running. Send /abort to cancel." |
| SDK query error | Error message sent to user |
| Abort (`/abort`) | `AbortController.abort()` called, user gets "Stopped." |
| SIGINT/SIGTERM | All queries aborted, all pending permissions denied, WhatsApp disconnected |
| Freeze not installed | `generateScreenshot` returns `null`, caller falls back to text |
| Path traversal attempt | "Cannot navigate outside the project directory." |
| File not found | "File not found: `<path>`" |
| Message > 4000 chars | Auto-chunked at newline boundaries |

---

## Troubleshooting

### QR code won't scan

Delete the stored auth and restart:

```bash
rm -rf auth/
node index.js
```

### "Logged out" error

WhatsApp unlinked the device. Delete `auth/` and re-scan:

```bash
rm -rf auth/
node index.js
```

### Permission prompts not matching replies

Make sure you're **quoting** (long-press > Reply) the specific permission message, not just sending a standalone "yes". The quote matching relies on WhatsApp's `contextInfo.stanzaId`.

### Claude Code not authenticated

Make sure the CLI is authenticated first:

```bash
claude --version   # should print version
claude              # opens interactive mode, will prompt auth if needed
```

### Long output gets cut off

WhatsApp has a ~65KB message limit. CodeClaw chunks at 4000 characters to stay well under this. If output is extremely long, you'll receive multiple messages.

### Module not found errors

```bash
rm -rf node_modules
npm install
```
