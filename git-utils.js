import { execFile } from "node:child_process";
import path from "node:path";

const TIMEOUT = 5000;

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: TIMEOUT }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

export async function getGitFileInfo(filePath, cwd) {
  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRoot) return null;

  const [remoteUrl, branch, status, diff] = await Promise.all([
    git(["remote", "get-url", "origin"], repoRoot),
    git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
    git(["status", "--porcelain", "--", filePath], repoRoot),
    git(["diff", "--", filePath], repoRoot),
  ]);

  return { repoRoot, remoteUrl, branch, status, diff };
}

export function parseGitHubUrl(remoteUrl) {
  if (!remoteUrl) return null;
  // SSH: git@github.com:user/repo.git
  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;
  // HTTPS: https://github.com/user/repo.git
  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;
  return null;
}

export function buildGitHubFileUrl(baseUrl, branch, repoRoot, absoluteFilePath) {
  const relPath = path.relative(repoRoot, absoluteFilePath);
  return `${baseUrl}/blob/${branch}/${relPath}`;
}
