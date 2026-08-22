/**
 * #3696 — relative paths must never reach daemon-visible state.
 *
 *   1. `addSource --path <relative>` stores an ABSOLUTE local_path (resolved
 *      against the registering shell's cwd) — pre-fix the relative string was
 *      inserted verbatim and every daemon-context consumer (launchd cwd=/)
 *      join-resolved a phantom path.
 *   2. generateLaunchdPlist emits a WorkingDirectory key pinned to $HOME
 *      (spawn-safe — NEVER the repo: launchd chdir()s before exec, so a
 *      deleted repo would fail every respawn and the self-disable guard
 *      could never run). The wrapper cd's into the repo after the guard.
 *   3. The autopilot dispatch loops skip (with a loud warning) any source
 *      whose stored local_path is still relative (legacy rows).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, basename, dirname, isAbsolute, resolve } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { generateLaunchdPlist, relativeLocalPathSkipWarning } from '../src/commands/autopilot.ts';

let engine: PGLiteEngine;
let repoDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-3696-'));
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repoDir, stdio: 'pipe' });
  mkdirSync(join(repoDir, 'topics'), { recursive: true });
  writeFileSync(join(repoDir, 'topics/x.md'), '---\ntype: concept\ntitle: X\n---\n\nbody.\n');
  execSync('git add -A && git commit -m seed', { cwd: repoDir, stdio: 'pipe' });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
}, 60_000);

describe('#3696 addSource stores absolute local_path', () => {
  test('a relative --path is resolved against cwd before INSERT', async () => {
    const origCwd = process.cwd();
    // cd into the temp repo's PARENT so `./<basename>` is a valid relative path.
    process.chdir(dirname(repoDir));
    try {
      const relPath = `./${basename(repoDir)}`;
      expect(isAbsolute(relPath)).toBe(false);
      // Compute the expectation from the SAME cwd addSource resolves against
      // (macOS: chdir realpaths /var → /private/var, so a dirname()-based
      // expectation would compare the unrealpathed spelling).
      const expected = resolve(relPath);
      await addSource(engine, { id: 'rel-src-3696', localPath: relPath });

      const rows = await engine.executeRaw<{ local_path: string }>(
        `SELECT local_path FROM sources WHERE id = 'rel-src-3696'`,
      );
      expect(rows.length).toBe(1);
      expect(isAbsolute(rows[0]!.local_path)).toBe(true);
      expect(rows[0]!.local_path).toBe(expected);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('#3696 generateLaunchdPlist WorkingDirectory', () => {
  test('emits WorkingDirectory = $HOME (spawn-safe), never the repo', () => {
    // launchd chdir()s into WorkingDirectory BEFORE exec: pinning the repo
    // here means a deleted repo fails every respawn, so the wrapper's
    // self-disable guard can never fire — a zombie KeepAlive job forever.
    // The repo cwd lives in the wrapper, after the guard proves it exists.
    const plist = generateLaunchdPlist('/Users/me/.gbrain/autopilot-run.sh', '/Users/me');
    expect(plist).toContain('<key>WorkingDirectory</key><string>/Users/me</string>');
  });

  test('XML-escapes the WorkingDirectory path', () => {
    const plist = generateLaunchdPlist('/w.sh', '/data/a&b');
    expect(plist).toContain('<key>WorkingDirectory</key><string>/data/a&amp;b</string>');
  });
});

describe('#3696 autopilot dispatch skips relative local_path', () => {
  test('relative path yields a skip warning; absolute path is dispatchable', () => {
    const warn = relativeLocalPathSkipWarning('legacy-src', 'notes/vault');
    expect(warn).not.toBeNull();
    expect(warn).toContain('legacy-src');
    expect(warn).toContain('notes/vault');
    expect(warn).toContain('cannot be resolved from a daemon');

    expect(relativeLocalPathSkipWarning('ok-src', '/abs/vault')).toBeNull();
  });
});
