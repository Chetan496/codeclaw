import "dotenv/config";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WhatsAppClient } from "./whatsapp.js";
import { ClaudeHandler } from "./claude-handler.js";
import { FileBrowser } from "./file-browser.js";

// --- Config ---

const DEFAULT_WORKING_DIR = process.env.WORKING_DIR || process.cwd();
const chatState = new Map(); // jid -> { workingDir: string }

function getWorkingDir(jid) {
  return chatState.get(jid)?.workingDir || DEFAULT_WORKING_DIR;
}

function setWorkingDir(jid, dir) {
  const existing = chatState.get(jid);
  if (existing) {
    existing.workingDir = dir;
  } else {
    chatState.set(jid, { workingDir: dir });
  }
}

const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((num) => (num.includes("@") ? num : `${num}@s.whatsapp.net`))
);

// --- Init ---

const whatsapp = new WhatsAppClient();
const claude = new ClaudeHandler(DEFAULT_WORKING_DIR);
const browser = new FileBrowser(DEFAULT_WORKING_DIR);

// --- Helpers ---

function isAuthorized(jid) {
  if (ALLOWED_USERS.size === 0) return true;
  return ALLOWED_USERS.has(jid);
}

function makeSendFn(jid) {
  return async (text) => {
    if (text.length > 4000) {
      const ids = await whatsapp.sendChunked(jid, text);
      return ids[ids.length - 1];
    }
    return whatsapp.sendText(jid, text);
  };
}

// --- Message Router ---

async function handleMessage(jid, text, quotedStanzaId, rawMsg, fromMe) {
  // Only process messages in the self-chat ("Message Yourself") or from authorized users.
  // Messages sent by the account owner to other chats should be ignored.
  if (fromMe) {
    if (jid !== whatsapp.userJid) return;
  } else if (!isAuthorized(jid)) {
    return;
  }

  const sendFn = makeSendFn(jid);

  // 1. Quoted reply → check if it's a permission response
  if (quotedStanzaId) {
    const resolved = claude.resolvePermission(quotedStanzaId, text);
    if (resolved) return;
    // Not a permission reply — fall through to normal routing
  }

  // 2. Numeric reply → file browser selection
  if (/^\d+$/.test(text.trim()) && browser.hasActiveSession(jid)) {
    try {
      const result = await browser.handleNumberReply(jid, parseInt(text.trim(), 10));
      if (result) {
        await sendFn(result.text);
      }
    } catch (err) {
      await sendFn(`Error: ${err.message}`);
    }
    return;
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 3. Slash commands
  if (trimmed.startsWith("/")) {
    const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
    const cmdLower = cmd.toLowerCase();

    switch (cmdLower) {
      case "help":
        await sendFn(HELP_TEXT);
        return;

      case "status":
        await sendFn(
          [
            "CodeClaw Status",
            "",
            `Active queries: ${claude.activeCount}`,
            `Pending permissions: ${claude.pendingPermCount}`,
            `Working dir: ${getWorkingDir(jid)}`,
          ].join("\n")
        );
        return;

      case "cd": {
        const target = args.join(" ");
        if (!target) {
          await sendFn(`Current directory: ${getWorkingDir(jid)}`);
          return;
        }
        const resolved = path.resolve(getWorkingDir(jid), target);
        try {
          const s = await stat(resolved);
          if (!s.isDirectory()) {
            await sendFn(`Not a directory: ${resolved}`);
            return;
          }
        } catch (err) {
          await sendFn(`Directory not found: ${resolved}`);
          return;
        }
        setWorkingDir(jid, resolved);
        await sendFn(`Working directory changed to: ${resolved}`);
        return;
      }

      case "pwd":
        await sendFn(getWorkingDir(jid));
        return;

      case "new":
        claude.clearSession(jid);
        await sendFn("Session cleared. Next message starts a fresh conversation.");
        return;

      case "abort":
      case "stop":
        if (claude.abort(jid)) {
          await sendFn("Aborting current task...");
        } else {
          await sendFn("No active task to abort.");
        }
        return;

      case "browse":
      case "ls": {
        const result = await browser.browse(jid, args[0] || ".", getWorkingDir(jid));
        await sendFn(result.text);
        return;
      }

      case "show":
      case "cat": {
        const filePath = args.join(" ");
        if (!filePath) {
          await sendFn("Usage: /show <filepath>");
          return;
        }
        const result = await browser.viewFile(filePath, getWorkingDir(jid));
        await sendFn(result.text);
        return;
      }

      default:
        // Forward other slash commands to Claude
        await claude.execute(jid, trimmed, sendFn, { workingDir: getWorkingDir(jid) });
        return;
    }
  }

  // 4. Plain text shortcuts
  if (lower.startsWith("browse ") || lower.startsWith("ls ")) {
    const dir = trimmed.split(/\s+/).slice(1).join(" ") || ".";
    const result = await browser.browse(jid, dir, getWorkingDir(jid));
    await sendFn(result.text);
    return;
  }

  if (lower.startsWith("show ") || lower.startsWith("cat ")) {
    const filePath = trimmed.split(/\s+/).slice(1).join(" ");
    if (!filePath) {
      await sendFn("Usage: show <filepath>");
      return;
    }
    const result = await browser.viewFile(filePath, getWorkingDir(jid));
    await sendFn(result.text);
    return;
  }

  // 5. Default → send to Claude Code
  await claude.execute(jid, trimmed, sendFn, { workingDir: getWorkingDir(jid) });
}

// --- Help Text ---

const HELP_TEXT = `CodeClaw Commands

File Operations:
  browse <dir> - Browse directory
  show <file> - View file contents
  ls <dir> - Alias for browse
  cat <file> - Alias for show

Claude Code:
  Any text message is sent to Claude Code.
  Slash commands (e.g. /commit, /search) are forwarded.

Session:
  /cd <path> - Change working directory
  /pwd - Show current working directory
  /new - Start a fresh conversation

System:
  /help - This message
  /status - Show status
  /abort - Cancel current task

Permissions:
  When Claude needs approval, quote the
  permission message and reply: yes, no, or always`;

// --- Startup ---

async function main() {
  console.log(`[codeclaw] Working directory: ${DEFAULT_WORKING_DIR}`);
  console.log(
    `[codeclaw] Allowed users: ${ALLOWED_USERS.size === 0 ? "all" : [...ALLOWED_USERS].join(", ")}`
  );

  await whatsapp.connect();
  whatsapp.onMessage(handleMessage);

  console.log("[codeclaw] Ready. Send a WhatsApp message to start.");
}

// --- Graceful Shutdown ---

function shutdown() {
  console.log("\n[codeclaw] Shutting down...");
  claude.abortAll();
  whatsapp.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Run ---

main().catch((err) => {
  console.error("[codeclaw] Fatal:", err);
  process.exit(1);
});
