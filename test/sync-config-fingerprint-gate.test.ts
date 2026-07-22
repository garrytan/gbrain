/**
 * #2157 follow-on (migration v125) — end-to-end gate wiring.
 *
 * `test/sync-config-fingerprint.test.ts` pins the persistence + comparison
 * primitives (compute/read/write). This file pins the WIRING inside
 * `performSync`: with git HEAD unchanged, a drift in the walk-affecting
 * `sources.config` fields must break out of the "Already up to date" early
 * return and force a full re-walk — and the re-stamped fingerprint must
 * settle the gate back to `up_to_date` on the following pass. Deleting the
 * `configMismatch` term from the gate condition fails this test; none of the
 * primitive tests would catch that.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
let repoPath: string;

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-fp-gate-'));
  mkdirSync(join(repoPath, 'wiki'));
  mkdirSync(join(repoPath, 'memory'));
  writeFileSync(join(repoPath, 'wiki', 'page1.md'), '# Page 1\n\nbody\n');
  writeFileSync(join(repoPath, 'memory', 'note1.md'), '# Note 1\n\nbody\n');
  git(repoPath, 'init');
  git(repoPath, 'add', '-A');
  git(repoPath, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'init');

  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    ['vault', 'vault', repoPath, JSON.stringify({ include_globs: ['wiki/**'] })],
  );
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
});

test('config-glob drift with unchanged git HEAD forces a re-walk, then settles', async () => {
  // First sync: row config include_globs = ['wiki/**'], caller threads it
  // (as syncOneSource / the single-source CLI path do). memory/* skipped.
  const first = await performSync(engine, {
    repoPath, sourceId: 'vault', include: ['wiki/**'],
    noPull: true, noEmbed: true, full: true,
  });
  expect(first.status).toBe('first_sync');
  expect(await engine.getPage('wiki/page1')).not.toBeNull();
  expect(await engine.getPage('memory/note1')).toBeNull();

  // No drift, HEAD unchanged: gate stays quiet.
  const second = await performSync(engine, {
    repoPath, sourceId: 'vault', include: ['wiki/**'],
    noPull: true, noEmbed: true,
  });
  expect(second.status).toBe('up_to_date');

  // User widens the persisted globs (what `gbrain sources add --include`
  // writes). Git HEAD has NOT moved.
  await engine.executeRaw(
    `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
    [JSON.stringify({ include_globs: ['wiki/**', 'memory/**'] }), 'vault'],
  );

  // Pre-fix this returned `up_to_date` (HEAD unchanged) and memory/note1
  // stayed missing until a manual `--full`. The fingerprint gate must force
  // the full re-walk instead.
  const third = await performSync(engine, {
    repoPath, sourceId: 'vault', include: ['wiki/**', 'memory/**'],
    noPull: true, noEmbed: true,
  });
  expect(third.status).not.toBe('up_to_date');
  expect(await engine.getPage('memory/note1')).not.toBeNull();

  // Re-stamped fingerprint matches the current row: gate settles.
  const fourth = await performSync(engine, {
    repoPath, sourceId: 'vault', include: ['wiki/**', 'memory/**'],
    noPull: true, noEmbed: true,
  });
  expect(fourth.status).toBe('up_to_date');
});
