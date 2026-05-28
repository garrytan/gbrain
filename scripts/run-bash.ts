import {
  existsSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const BASH_NOT_FOUND_MESSAGE =
  "bash was not found. Install Git for Windows with Git Bash, add bash to PATH, or set GBRAIN_BASH to bash.exe.";

export type BashLookupEnv = NodeJS.ProcessEnv & {
  GBRAIN_BASH?: string;
  PATH?: string;
  Path?: string;
  path?: string;
};

export function windowsGitBashCandidates(gitExePath: string): string[] {
  const gitDir = dirname(gitExePath);
  const gitRoot = dirname(gitDir);
  return [
    join(gitRoot, "bin", "bash.exe"),
    join(gitRoot, "usr", "bin", "bash.exe"),
  ];
}

function pathEntries(env: BashLookupEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

function executableExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findBash({
  env = process.env,
  platform = process.platform,
}: {
  env?: BashLookupEnv;
  platform?: NodeJS.Platform;
} = {}): string | null {
  if (env.GBRAIN_BASH && executableExists(env.GBRAIN_BASH)) {
    return env.GBRAIN_BASH;
  }

  const bashName = platform === "win32" ? "bash.exe" : "bash";
  for (const entry of pathEntries(env, platform)) {
    const candidate = join(entry, bashName);
    if (executableExists(candidate)) return candidate;
  }

  if (platform === "win32") {
    const whereGit = spawnSync("where", ["git"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const gitPaths = whereGit.status === 0
      ? whereGit.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      : [];

    for (const gitPath of gitPaths) {
      for (const candidate of windowsGitBashCandidates(gitPath)) {
        if (executableExists(candidate)) return candidate;
      }
    }

    const localAppData = env.LOCALAPPDATA;
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env["ProgramFiles(x86)"];
    const commonCandidates = [
      localAppData && join(localAppData, "Programs", "Git", "bin", "bash.exe"),
      programFiles && join(programFiles, "Git", "bin", "bash.exe"),
      programFilesX86 && join(programFilesX86, "Git", "bin", "bash.exe"),
    ].filter((p): p is string => Boolean(p));

    for (const candidate of commonCandidates) {
      if (executableExists(candidate)) return candidate;
    }
  }

  return null;
}

function main(): number {
  const [, , script, ...args] = process.argv;
  if (!script) {
    console.error("usage: bun run scripts/run-bash.ts <script.sh> [args...]");
    return 2;
  }

  const bash = findBash();
  if (!bash) {
    console.error(`[run-bash] ${BASH_NOT_FOUND_MESSAGE}`);
    return 2;
  }

  const result = spawnSync(bash, [resolve(script), ...args], {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[run-bash] failed to run ${script}: ${result.error.message}`);
    return 2;
  }

  return result.status ?? 1;
}

if (import.meta.main) {
  process.exit(main());
}
