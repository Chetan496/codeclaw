# CodeClaw

Control [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from WhatsApp. Send a message describing a coding task, approve tool permissions inline, and browse your project files — all from your phone.

## Usage

### Sending coding tasks

Any plain text message is forwarded to Claude Code:

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

You: [quote the permission message] yes

Bot: Fixed the null pointer bug in src/auth.js.
     Added a null check before accessing user.token on line 42.
     ---
     $0.0312 | 3 turns
```

### Approving permissions

When Claude needs to use a tool (edit a file, run a shell command, etc.), CodeClaw sends a permission prompt. To respond:

1. **Long-press** the permission message in WhatsApp
2. Tap **Reply**
3. Type one of:
   - `yes` / `y` — approve this one use
   - `always` / `a` — approve this tool for the rest of the session
   - `no` / `n` — deny

Permissions time out after 2 minutes if unanswered (auto-denied).

### Browsing files

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

| Command | Description |
|---------|-------------|
| `/help` | Show command reference |
| `/status` | Active queries, pending permissions, working directory |
| `/cd <path>` | Change working directory |
| `/pwd` | Show current working directory |
| `/new` | Start a fresh conversation |
| `/abort` | Cancel the current Claude Code task |
| `/browse <dir>` or `/ls <dir>` | Browse a directory |
| `/show <file>` or `/cat <file>` | View a file |

Slash commands not listed above (e.g. `/commit`, `/search`) are forwarded directly to Claude Code.

Plain text shortcuts also work: `browse src/`, `ls src/`, `show index.js`, `cat index.js`.

---

## Setup

### Prerequisites

- Node.js 20+
- An active WhatsApp account
- Claude Code CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)

### Install

```bash
git clone <repo-url> codeclaw
cd codeclaw
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Absolute path to the project you want Claude to work on
WORKING_DIR=/path/to/your/project

# Comma-separated WhatsApp numbers (country code, no +)
# Leave empty to allow all senders
ALLOWED_USERS=1234567890
```

### Run

```bash
node index.js
```

On first run, a QR code appears in the terminal. Scan it with WhatsApp (**Settings > Linked Devices > Link a Device**). After the first scan, the session persists in the `auth/` directory and reconnects automatically on subsequent starts.

### Reducing permission prompts

Pre-approve safe operations in `~/.claude/settings.json` so they don't trigger WhatsApp prompts:

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
    ]
  }
}
```

---

## How it works

1. You send a WhatsApp message (e.g. "Fix the login bug in auth.js")
2. CodeClaw passes it to the Claude Agent SDK's `query()` function
3. When Claude needs to use a tool, the SDK invokes a `canUseTool` callback
4. CodeClaw sends you a WhatsApp permission prompt
5. You quote-reply with `yes`, `no`, or `always`
6. The callback resolves, Claude proceeds (or stops)
7. The final result is sent back as a WhatsApp message

### Architecture

```
WhatsApp (baileys)
       │
       ▼
  index.js — Message Router
  ├── Auth check (ALLOWED_USERS)
  ├── Quoted reply → resolve pending permission
  ├── Number reply → file browser selection
  ├── /command → built-in or forward to Claude
  └── Default → Claude Code query
       │                │
       ▼                ▼
  file-browser     claude-handler
  (dir listings,   (Agent SDK query,
   file viewer)     permission bridge)
```

| File | Role |
|------|------|
| `index.js` | Entry point, env config, auth, message routing, graceful shutdown |
| `whatsapp.js` | Baileys connection, auto-reconnect, send text/image/chunked messages |
| `claude-handler.js` | Agent SDK `query()`, permission bridge via WhatsApp quote-replies |
| `file-browser.js` | Numbered directory listings, file viewing, path traversal protection |

### Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Programmatic access to Claude Code |
| `@whiskeysockets/baileys` | WhatsApp Web protocol |
| `dotenv` | `.env` configuration |
| `qrcode-terminal` | QR code display for WhatsApp pairing |
| `zod` | Peer dependency of the Agent SDK |

---

## Troubleshooting

**QR code won't scan / "Logged out" error** — Delete `auth/` and restart:
```bash
rm -rf auth/
node index.js
```

**Permission replies not matching** — Make sure you're *quoting* (long-press > Reply) the specific permission message, not sending a standalone "yes".

**Claude Code not authenticated** — Ensure the CLI works first:
```bash
claude --version
```

**Module not found errors** — Reinstall dependencies:
```bash
rm -rf node_modules && npm install
```

**Long output gets cut off** — CodeClaw auto-chunks messages at 4000 characters. Very long output arrives as multiple messages.

## License

MIT
