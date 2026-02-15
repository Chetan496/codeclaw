import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";

const LANG_MAP = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".json": "json",
  ".md": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".html": "html",
  ".sh": "bash",
  ".sql": "sql",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
};

const MAX_VIEW_LINES = 200;

export class FileBrowser {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.sessions = new Map();
  }

  async browse(chatId, dirPath = ".", rootDir) {
    const effectiveRoot = rootDir ? path.resolve(rootDir) : this.rootDir;
    const fullPath = path.resolve(effectiveRoot, dirPath);

    if (!fullPath.startsWith(effectiveRoot)) {
      return { text: "Cannot navigate outside the project directory." };
    }

    let entries;
    try {
      entries = await readdir(fullPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return { text: `Directory not found: ${dirPath}` };
      if (err.code === "EACCES") return { text: `Access denied: ${dirPath}` };
      throw err;
    }

    // Filter hidden files, sort dirs first then alphabetical
    const visible = entries.filter((e) => !e.name.startsWith("."));
    visible.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const listing = visible.map((entry) => ({
      name: entry.name,
      relPath: path.relative(effectiveRoot, path.join(fullPath, entry.name)),
      isDir: entry.isDirectory(),
    }));

    this.sessions.set(chatId, { currentDir: dirPath, listing, rootDir: effectiveRoot });

    const relDir = path.relative(effectiveRoot, fullPath) || ".";
    const lines = listing.map((item, i) => {
      const icon = item.isDir ? "📁" : "📄";
      const suffix = item.isDir ? "/" : "";
      return `${i + 1}. ${icon} ${item.name}${suffix}`;
    });

    const text = [
      `📁 ${relDir} (${listing.length} items)`,
      "",
      ...lines,
      "",
      "Reply with a number to open.",
    ].join("\n");

    return { text };
  }

  async handleNumberReply(chatId, number) {
    const session = this.sessions.get(chatId);
    if (!session) return null;

    const index = number - 1;
    if (index < 0 || index >= session.listing.length) {
      return { type: "error", text: `Invalid selection. Pick 1-${session.listing.length}.` };
    }

    const item = session.listing[index];

    if (item.isDir) {
      const result = await this.browse(chatId, item.relPath, session.rootDir);
      return { type: "browse", ...result };
    }

    const result = await this.viewFile(item.relPath, session.rootDir);
    return { type: "file", ...result };
  }

  async viewFile(filePath, rootDir) {
    const effectiveRoot = rootDir ? path.resolve(rootDir) : this.rootDir;
    const fullPath = path.resolve(effectiveRoot, filePath);

    if (!fullPath.startsWith(effectiveRoot)) {
      return { text: "Cannot access files outside the project directory." };
    }

    let content;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return { text: `File not found: ${filePath}` };
      if (err.code === "EACCES") return { text: `Access denied: ${filePath}` };
      // Likely binary
      try {
        const s = await stat(fullPath);
        return { text: `Binary file: ${filePath} (${formatSize(s.size)})` };
      } catch {
        return { text: `Cannot read file: ${filePath}` };
      }
    }

    const lines = content.split("\n");
    const ext = path.extname(filePath);
    const language = LANG_MAP[ext] || "text";
    let displayContent = content;
    let truncated = false;

    if (lines.length > MAX_VIEW_LINES) {
      displayContent = lines.slice(0, MAX_VIEW_LINES).join("\n");
      truncated = true;
    }

    const header = `📄 ${filePath} (${lines.length} lines, ${language})`;
    const footer = truncated
      ? `\n... truncated at ${MAX_VIEW_LINES} lines`
      : "";

    return {
      text: `${header}\n\`\`\`${language}\n${displayContent}\n\`\`\`${footer}`,
      content: displayContent,
      language,
      fullLineCount: lines.length,
    };
  }

  hasActiveSession(chatId) {
    return this.sessions.has(chatId);
  }

  clearSession(chatId) {
    this.sessions.delete(chatId);
  }

  detectLanguage(filename) {
    const ext = path.extname(filename);
    return LANG_MAP[ext] || "text";
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
