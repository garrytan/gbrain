/**
 * #4472 — the claude-cli provider's per-PID scratch dirs, split into a tiny
 * dependency-light module so transcript discovery (src/core/transcripts/
 * discover.ts) can recognize the fingerprint without importing the whole
 * provider (and its @ai-sdk surface).
 *
 * Why discovery must know: each `claude --print` subprocess runs with
 * cwd = <tmpdir>/gbrain-claude-cli-cwd-<pid> (context isolation — no local
 * CLAUDE.md to auto-discover), and Claude Code records a session transcript
 * for that cwd under ~/.claude/projects/<slugified-cwd>/. Those sessions are
 * gbrain's OWN internal LLM calls — importing them back into the brain is a
 * self-ingestion feedback loop (prompt scaffolding + page content re-entering
 * as "conversations"). The prefix is lowercase [a-z-] only, so it survives
 * Claude Code's cwd slugification verbatim and a substring match on the
 * discovered path is a reliable fingerprint.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectsDir } from '../../bootstrap/host-specs.ts';

/** Basename prefix of the per-PID cwd the claude-cli subprocess runs in. */
export const CLAUDE_CLI_CWD_PREFIX = 'gbrain-claude-cli-cwd-';
/** Basename prefix of the per-PID hermetic CLAUDE_CONFIG_DIR (#4119). */
export const CLAUDE_CLI_CONFIG_PREFIX = 'gbrain-claude-cli-config-';

/** The per-PID scratch cwd path for this process. */
export function claudeCliCwdDir(pid: number = process.pid): string {
  return join(tmpdir(), `${CLAUDE_CLI_CWD_PREFIX}${pid}`);
}

/** The per-PID hermetic-config scratch path for this process (#4119). */
export function claudeCliConfigDir(pid: number = process.pid): string {
  return join(tmpdir(), `${CLAUDE_CLI_CONFIG_PREFIX}${pid}`);
}

/**
 * True when a discovered transcript path belongs to a gbrain claude-cli
 * subprocess session (the slugified scratch-cwd fingerprint appears in the
 * harness project dir).
 */
export function isClaudeCliSelfTranscriptPath(path: string): boolean {
  return path.includes(CLAUDE_CLI_CWD_PREFIX);
}

/**
 * #5413 — session ids of gbrain's own claude-cli subprocess sessions, read
 * from the harness transcripts Claude Code keeps under
 * `<projectsRoot>/<slugified scratch cwd>/<session id>.jsonl`. The
 * session-end hook names each corpus file `<session id>.txt`, so a corpus
 * file whose stem is in this set is a self-capture from before the hook
 * refused them. Best-effort: a capture whose harness transcript Claude Code
 * has since pruned is unclassifiable and stays in the corpus.
 */
export function claudeCliSelfSessionIds(projectsRoot: string = claudeProjectsDir()): Set<string> {
  const ids = new Set<string>();
  for (const project of claudeCliSelfProjectDirs(projectsRoot)) {
    let files: string[];
    try {
      files = readdirSync(project);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length));
    }
  }
  return ids;
}

/** The harness project dirs of gbrain claude-cli scratch cwds (one listing of
 * the projects root; no project's files are read). */
export function claudeCliSelfProjectDirs(projectsRoot: string = claudeProjectsDir()): string[] {
  try {
    return readdirSync(projectsRoot)
      .filter(isClaudeCliSelfTranscriptPath)
      .map((project) => join(projectsRoot, project));
  } catch {
    return [];
  }
}

/**
 * #5820 — the ONE single-session self-capture classifier (serve-side
 * writeback harvest, the sweep's corpus pass, doctor `self_capture`): true
 * when a scratch project holds `<id>.jsonl`. Pass `projectDirs` to classify
 * many ids against one listing.
 */
export function isClaudeCliSelfSessionId(
  id: string,
  projectDirs: readonly string[] = claudeCliSelfProjectDirs(),
): boolean {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)) return false;
  return projectDirs.some((dir) => existsSync(join(dir, `${id}.jsonl`)));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but owned by another user; anything else (ESRCH) = dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Sweep dead-PID scratch dirs (cwd + hermetic-config) left behind by
 * crashed/killed gbrain processes — the per-PID naming means nothing ever
 * reclaimed them. Called once at provider init; every step is best-effort
 * (a sweep failure must never break a chat call). Returns the number of
 * dirs removed. `baseDir` is injectable for tests.
 */
export function sweepDeadClaudeCliScratchDirs(baseDir: string = tmpdir()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const prefix = name.startsWith(CLAUDE_CLI_CWD_PREFIX)
      ? CLAUDE_CLI_CWD_PREFIX
      : name.startsWith(CLAUDE_CLI_CONFIG_PREFIX)
        ? CLAUDE_CLI_CONFIG_PREFIX
        : null;
    if (!prefix) continue;
    const pidText = name.slice(prefix.length);
    if (!/^\d+$/.test(pidText)) continue; // not our naming shape — leave it
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (pid === process.pid) continue;
    if (isPidAlive(pid)) continue;
    try {
      rmSync(join(baseDir, name), { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
