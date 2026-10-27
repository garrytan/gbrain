/**
 * Value: protects=the capture CLI end to end on the current tree: it round-trips, writes a gzipped dump at the latest schema version, and blanks generated secrets;
 *   fails_when=main()'s fidelity gate, the secret blanking or the derived_generation_items.pending column drop out of a captured fixture, or the CLI stops writing --out;
 *   why_new=capture-schema-history-fixture.test.ts calls dumpBrainSchema on a toy schema and never runs main, blankSecrets or the fidelity gate; seam=none;
 *   no_claim=the postgres engine path and older release trees (PGLite on the current tree only)
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const root = resolve(import.meta.dir, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'capture-fixture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('capturing the current tree as pglite writes a restorable dump with generated secrets blanked', () => {
  const out = join(dir, 'fixture.sql.gz');
  const run = Bun.spawnSync(['bun', 'scripts/capture-schema-history-fixture.ts', '--tree', root, '--engine', 'pglite', '--out', out], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(run.stderr.toString()).not.toContain('differs from the release');
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain(`schema v${LATEST_VERSION}, pglite`);

  const sql = Buffer.from(Bun.gunzipSync(readFileSync(out))).toString('utf8');
  expect(sql).toContain(`a fresh brain at schema v${LATEST_VERSION}`);
  expect(sql).toMatch(/CREATE TABLE "derived_generation_items" \([^;]*"pending" boolean DEFAULT false NOT NULL/);
  expect(sql).toContain('"token_secret"');
  expect(sql).not.toMatch(/"token_secret"\s*:\s*"(?!0+")/);

  const usage = Bun.spawnSync(['bun', 'scripts/capture-schema-history-fixture.ts', '--engine', 'pglite'], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(usage.exitCode).toBe(1);
  expect(usage.stderr.toString()).toContain('Usage: capture-schema-history-fixture.ts --tree');
}, 120_000);
