/**
 * v0.41.13 (#1422) — `gbrain dream` surfaces engine-connect failures on stderr.
 *
 * Pre-fix bug (foxhoundinc): dream wrapped `connectEngine()` in `try {} catch {}`
 * that silently swallowed the failure. The cycle then ran with `engine: null`,
 * every DB phase reported "No database connection: connect() has not been
 * called", and the user saw exit 0 + "lint + backlinks done" with no clue why.
 *
 * Post-fix: the catch binds the error and writes a single `[dream] WARNING:`
 * line to stderr naming the connect failure and the consequence (DB phases
 * will be skipped). The cycle still runs filesystem phases honestly — no
 * behavior change for that path.
 *
 * Subprocess test so we exercise the real cli.ts dispatch end-to-end.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runDream(args: string[], extraEnv: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync('bun', ['run', 'src/cli.ts', 'dream', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('#1422 — dream surfaces connectEngine failures', () => {
  test('connect failure prints WARNING line on stderr (does not swallow silently)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-dream-warn-'));
    const tmpBrain = mkdtempSync(join(tmpdir(), 'gbrain-dream-brain-'));
    try {
      // Point GBRAIN_HOME at an empty tempdir so loadConfig sees no config,
      // then force a bad Postgres URL via env so connectEngine throws on
      // the attempt to reach a non-existent server. Port 9 is the discard
      // protocol — guaranteed not to accept Postgres traffic.
      // GBRAIN_HOME=/tmp/x yields configDir() === '/tmp/x/.gbrain' (config.ts:687-690).
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres',
        database_url: 'postgresql://nobody:nobody@127.0.0.1:9/nodb',
      }));
      const { stderr, status } = runDream(['--dir', tmpBrain, '--phase', 'lint'], {
        GBRAIN_HOME: tmpHome,
      });
      // Filesystem-only phases still run; exit code reflects cycle outcome,
      // not connect failure. The KEY contract: the WARNING text appears.
      expect(stderr).toContain('[dream] WARNING: could not connect to DB');
      expect(stderr).toContain('Running filesystem-only phases');
      expect(stderr).toContain('DB-dependent phases');
      // Sanity: process did not hang / segfault. Exit is success or non-zero
      // (filesystem phases are tolerant). We assert it terminated, not the code.
      expect(status).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpBrain, { recursive: true, force: true });
    }
  });

  test('successful connect emits NO WARNING line', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-dream-ok-'));
    const tmpBrain = mkdtempSync(join(tmpdir(), 'gbrain-dream-brain-'));
    try {
      // PGLite at a fresh tempdir always connects cleanly. No DATABASE_URL.
      // GBRAIN_HOME=/tmp/x yields configDir() === '/tmp/x/.gbrain' (config.ts:687-690).
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'pglite',
      }));
      const { stderr, status } = runDream(['--dir', tmpBrain, '--phase', 'lint'], {
        GBRAIN_HOME: tmpHome,
        // Strip any inherited Postgres URL so PGLite is unambiguously the engine.
        DATABASE_URL: '',
        GBRAIN_DATABASE_URL: '',
      });
      expect(stderr).not.toContain('[dream] WARNING: could not connect to DB');
      expect(status).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpBrain, { recursive: true, force: true });
    }
  });
});
