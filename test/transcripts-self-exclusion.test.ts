/**
 * #4472 — transcript discovery must not re-ingest gbrain's own claude-cli
 * subprocess sessions.
 *
 * The claude-cli provider spawns `claude --print` with
 * cwd = <tmpdir>/gbrain-claude-cli-cwd-<pid>; Claude Code records each call
 * as a session under ~/.claude/projects/<slugified-cwd>/. Discovery picked
 * those up like any other project — a self-ingestion feedback loop (gbrain's
 * prompt scaffolding + page content re-entering the brain as
 * "conversations"). Pins:
 *
 *   1. discovery skips sessions whose path carries the scratch-cwd
 *      fingerprint; `includeSelf` restores them (the CLI --include-self
 *      escape hatch);
 *   2. the fingerprint predicate + per-PID dir naming agree (the constant is
 *      shared, not duplicated);
 *   3. the provider-init sweep removes dead-PID scratch dirs and leaves
 *      live-PID, own-PID, and non-matching dirs alone.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import type { HarnessRoot } from '../src/core/transcripts/detect.ts';
import {
  CLAUDE_CLI_CWD_PREFIX,
  claudeCliCwdDir,
  claudeCliConfigDir,
  isClaudeCliSelfTranscriptPath,
  sweepDeadClaudeCliScratchDirs,
} from '../src/core/ai/providers/claude-cli-scratch.ts';

let projectsRoot: string;
let roots: HarnessRoot[];

beforeAll(() => {
  projectsRoot = mkdtempSync(join(tmpdir(), 'gb-self-excl-projects-'));
  // A real user project session.
  const userProject = join(projectsRoot, '-Users-alice-code-myapp');
  mkdirSync(userProject, { recursive: true });
  writeFileSync(join(userProject, 'session-user.jsonl'), '{"type":"user"}\n', 'utf-8');
  // gbrain's own claude-cli scratch-cwd session (slugified per Claude Code:
  // /private/tmp/gbrain-claude-cli-cwd-12345 → -private-tmp-gbrain-claude-cli-cwd-12345).
  const selfProject = join(projectsRoot, `-private-tmp-${CLAUDE_CLI_CWD_PREFIX}12345`);
  mkdirSync(selfProject, { recursive: true });
  writeFileSync(join(selfProject, 'session-self.jsonl'), '{"type":"user"}\n', 'utf-8');
  roots = [{ format: 'claude-code', root: projectsRoot, extension: '.jsonl' }];
});

afterAll(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
});

describe('transcript discovery — claude-cli self-session exclusion (#4472)', () => {
  test('default discovery skips gbrain-claude-cli-cwd sessions', () => {
    const found = discoverTranscriptFiles(roots);
    const names = found.map((f) => basename(f.path));
    expect(names).toContain('session-user.jsonl');
    expect(names).not.toContain('session-self.jsonl');
  });

  test('includeSelf restores them (the --include-self escape hatch)', () => {
    const found = discoverTranscriptFiles(roots, { includeSelf: true });
    const names = found.map((f) => basename(f.path));
    expect(names).toContain('session-user.jsonl');
    expect(names).toContain('session-self.jsonl');
  });

  test('fingerprint predicate and per-PID dir naming share one constant', () => {
    expect(basename(claudeCliCwdDir(4242))).toBe(`${CLAUDE_CLI_CWD_PREFIX}4242`);
    expect(isClaudeCliSelfTranscriptPath(claudeCliCwdDir())).toBe(true);
    expect(isClaudeCliSelfTranscriptPath('/Users/alice/.claude/projects/-Users-alice-code-myapp/s.jsonl')).toBe(false);
    // The slugified project-dir form matches too.
    expect(
      isClaudeCliSelfTranscriptPath(`/Users/alice/.claude/projects/-private-tmp-${CLAUDE_CLI_CWD_PREFIX}999/s.jsonl`),
    ).toBe(true);
  });
});

describe('claude-cli scratch sweep (#4472)', () => {
  test('removes dead-PID dirs; keeps live-PID, own-PID, and non-matching dirs', () => {
    const base = mkdtempSync(join(tmpdir(), 'gb-self-excl-sweep-'));
    try {
      // A genuinely dead PID: a child that already exited.
      const deadPid = spawnSync('true').pid!;
      expect(typeof deadPid).toBe('number');

      const deadCwd = join(base, `${CLAUDE_CLI_CWD_PREFIX}${deadPid}`);
      const deadCfg = join(base, basename(claudeCliConfigDir(deadPid)));
      const ownCwd = join(base, `${CLAUDE_CLI_CWD_PREFIX}${process.pid}`);
      const liveCwd = join(base, `${CLAUDE_CLI_CWD_PREFIX}1`); // pid 1 is alive (EPERM → alive)
      const nonNumeric = join(base, `${CLAUDE_CLI_CWD_PREFIX}not-a-pid`);
      const unrelated = join(base, 'some-other-dir');
      for (const d of [deadCwd, deadCfg, ownCwd, liveCwd, nonNumeric, unrelated]) {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'marker.txt'), 'x', 'utf-8');
      }

      const removed = sweepDeadClaudeCliScratchDirs(base);
      expect(removed).toBe(2); // dead cwd + dead config dir
      expect(existsSync(deadCwd)).toBe(false);
      expect(existsSync(deadCfg)).toBe(false);
      expect(existsSync(ownCwd)).toBe(true);
      expect(existsSync(liveCwd)).toBe(true);
      expect(existsSync(nonNumeric)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(readdirSync(base).length).toBe(4);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('unreadable base dir is a no-op, never a throw (fail-open)', () => {
    expect(sweepDeadClaudeCliScratchDirs(join(tmpdir(), 'gb-self-excl-missing-base'))).toBe(0);
  });
});
