import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";

const PERM_TIMEOUT_MS = 120_000;

export class ClaudeHandler {
  constructor(workingDir) {
    this.workingDir = workingDir;
    this.activeQueries = new Map(); // chatId -> AbortController
    this.pendingPerms = new Map(); // msgId -> { resolve, timer, toolName, input }
    this.alwaysAllowed = new Set(); // tool patterns auto-approved for session
    this.sessions = new Map(); // chatId -> sessionId (for conversation resume)
  }

  /**
   * Execute a Claude Code query and stream results back via sendFn.
   * sendFn(text) must return the sent message's ID (for permission matching).
   */
  async execute(chatId, prompt, sendFn, { workingDir } = {}) {
    if (this.activeQueries.has(chatId)) {
      await sendFn("A task is already running. Send /abort to cancel it first.");
      return;
    }

    const ac = new AbortController();
    this.activeQueries.set(chatId, ac);

    const cwd = workingDir || this.workingDir;

    try {
      await sendFn("Working on it...");

      const canUseTool = async (toolName, input, options) => {
        return this._handlePermission(toolName, input, options, sendFn);
      };

      const queryOptions = {
        cwd,
        permissionMode: "default",
        canUseTool,
        abortController: ac,
      };

      const existingSession = this.sessions.get(chatId);
      if (existingSession) {
        queryOptions.resume = existingSession;
      }

      const iter = query({
        prompt,
        options: queryOptions,
      });

      let resultText = "";
      let totalCost = 0;
      let numTurns = 0;
      let isError = false;
      let sessionId = null;

      for await (const msg of iter) {
        if (msg.session_id) {
          sessionId = msg.session_id;
        }
        if (msg.type === "result") {
          totalCost = msg.total_cost_usd ?? 0;
          numTurns = msg.num_turns ?? 0;
          if (msg.session_id) {
            sessionId = msg.session_id;
          }

          if (msg.subtype === "success") {
            resultText = msg.result || "";
          } else {
            isError = true;
            const errors = msg.errors?.join("\n") || msg.subtype;
            resultText = `Error: ${errors}`;
          }
        }
      }

      if (sessionId) {
        this.sessions.set(chatId, sessionId);
      }

      // Send the final result
      if (resultText) {
        const costLine = `\n---\n$${totalCost.toFixed(4)} | ${numTurns} turns`;
        const fullText = isError
          ? `❌ ${resultText}${costLine}`
          : `${resultText}${costLine}`;

        await sendFn(fullText);
      }
    } catch (err) {
      if (err.name === "AbortError" || ac.signal.aborted) {
        await sendFn("Stopped.");
      } else {
        console.error("[claude] Query error:", err);
        await sendFn(`❌ Error: ${err.message}`);
      }
    } finally {
      this.activeQueries.delete(chatId);
    }
  }

  /**
   * Handle a permission request from the SDK by sending a WhatsApp prompt
   * and waiting for the user's quoted reply.
   */
  async _handlePermission(toolName, input, options, sendFn) {
    // Check session-level always-allowed tools
    if (this.alwaysAllowed.has(toolName)) {
      return { behavior: "allow" };
    }

    // Format a human-readable description of the tool use
    const description = this._formatToolDescription(toolName, input);
    const reason = options.decisionReason
      ? `\nReason: ${options.decisionReason}`
      : "";

    const promptText = [
      "🔧 Permission needed",
      "",
      `Tool: ${toolName}`,
      description,
      reason,
      "",
      "Quote this message and reply:",
      "  yes - approve once",
      "  always - always approve this tool",
      "  no - deny",
    ].join("\n");

    const msgId = await sendFn(promptText);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPerms.delete(msgId);
        resolve({ behavior: "deny", message: "Permission timed out" });
      }, PERM_TIMEOUT_MS);

      this.pendingPerms.set(msgId, {
        resolve,
        timer,
        toolName,
        input,
        suggestions: options.suggestions,
      });
    });
  }

  /**
   * Resolve a pending permission based on the user's quoted reply.
   * Returns true if a matching permission was found and resolved.
   */
  resolvePermission(stanzaId, decision) {
    const perm = this.pendingPerms.get(stanzaId);
    if (!perm) return false;

    clearTimeout(perm.timer);
    this.pendingPerms.delete(stanzaId);

    const d = decision.toLowerCase().trim();

    if (d === "yes" || d === "y" || d === "approve") {
      perm.resolve({ behavior: "allow" });
    } else if (d === "always" || d === "a") {
      this.alwaysAllowed.add(perm.toolName);
      const result = { behavior: "allow" };
      if (perm.suggestions?.length) {
        result.updatedPermissions = perm.suggestions;
      }
      perm.resolve(result);
    } else {
      perm.resolve({ behavior: "deny", message: "User denied" });
    }

    return true;
  }

  /**
   * Format a readable description of what a tool wants to do.
   */
  _formatToolDescription(toolName, input) {
    switch (toolName) {
      case "Edit":
        return `File: ${input.file_path || "unknown"}`;
      case "Write":
        return `File: ${input.file_path || "unknown"}`;
      case "Read":
        return `File: ${input.file_path || "unknown"}`;
      case "Bash":
        return `Command: ${input.command || "unknown"}`;
      case "Glob":
        return `Pattern: ${input.pattern || "unknown"}`;
      case "Grep":
        return `Pattern: ${input.pattern || "unknown"}`;
      case "WebFetch":
        return `URL: ${input.url || "unknown"}`;
      case "WebSearch":
        return `Query: ${input.query || "unknown"}`;
      default:
        return `Input: ${JSON.stringify(input).slice(0, 200)}`;
    }
  }

  /**
   * Generate a code screenshot using Freeze CLI.
   * Returns a PNG Buffer, or null if Freeze is unavailable.
   */
  async generateScreenshot(code, language = "text") {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const srcFile = `/tmp/codeclaw-${id}.txt`;
    const outFile = `/tmp/codeclaw-${id}.png`;

    try {
      await writeFile(srcFile, code, "utf-8");

      await new Promise((resolve, reject) => {
        execFile(
          "freeze",
          [srcFile, "-o", outFile, "-l", language],
          { timeout: 10_000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      return await readFile(outFile);
    } catch {
      return null;
    } finally {
      await unlink(srcFile).catch(() => {});
      await unlink(outFile).catch(() => {});
    }
  }

  /** Return all sessions as a plain object for persistence. */
  getSessions() {
    return Object.fromEntries(this.sessions);
  }

  /** Restore sessions from a plain object (e.g. loaded from state file). */
  restoreSessions(obj) {
    if (obj && typeof obj === "object") {
      for (const [chatId, sessionId] of Object.entries(obj)) {
        this.sessions.set(chatId, sessionId);
      }
    }
  }

  clearSession(chatId) {
    this.sessions.delete(chatId);
  }

  abort(chatId) {
    const ac = this.activeQueries.get(chatId);
    if (ac) {
      ac.abort();
      return true;
    }
    return false;
  }

  abortAll() {
    for (const ac of this.activeQueries.values()) {
      ac.abort();
    }
    this.activeQueries.clear();

    for (const perm of this.pendingPerms.values()) {
      clearTimeout(perm.timer);
      perm.resolve({ behavior: "deny", message: "Shutting down" });
    }
    this.pendingPerms.clear();
  }

  get activeCount() {
    return this.activeQueries.size;
  }

  get pendingPermCount() {
    return this.pendingPerms.size;
  }
}
