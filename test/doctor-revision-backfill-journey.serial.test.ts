/**
 * #5216 follow-up journey: the command doctor `revision_backfill` prints
 * actually finishes the page revision backfill.
 *
 * Protects: on a brain created by `foresights init` (managed) whose pages still
 * wait for their revision with the schema version current, doctor warns with
 * `foresights apply-migrations --force-schema`; `foresights apply-migrations --yes`
 * alone leaves the backfill where it was; the printed command completes it
 * and doctor clears.
 * Fails when: doctor has no revision_backfill check, prints a command that
 * does not resume the backfill, or the backfill fails its rows on the managed
 * writer guard.
 * Why existing coverage misses it: the backfill tests call
 * resumePageRevisionBackfill in-process; none runs the printed command.
 * Seams: none; the real CLI against a PGLite brain in a temporary home.
 * Serial: it opens the CLI's PGLite data directory in-process between CLI runs.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUGS = ['notes/rev-a', 'notes/rev-b', 'notes/rev-c'];

test('journey: on a CLI-created brain, the command doctor prints finishes the backfill and doctor clears', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-revision-journey-'));
  try {
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home, timeoutMs: 120_000 });
    expect(init.exitCode).toBe(0);
    // The setup migrations foresights init leaves pending re-run the schema pass; finish them first, as an upgraded brain has.
    expect((await runCli(['apply-migrations', '--yes', '--no-autopilot-install'], { home, timeoutMs: 120_000 })).exitCode).toBe(0);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: join(home, '.gbrain', 'brain.pglite') });
      try {
        const [{ enabled }] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain');
        expect(enabled).toBe(true);
        await engine.executeRaw('UPDATE persistence_brain SET enabled = false');
        for (const slug of SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.` }, { sourceId: 'default' });
        await engine.executeRaw('UPDATE persistence_brain SET enabled = true');
        await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision DROP NOT NULL');
        await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER USER');
        await engine.executeRaw('UPDATE pages SET knowledge_revision = NULL WHERE slug = ANY($1::text[])', [SLUGS]);
        await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER USER');
      } finally { await engine.disconnect(); }
    });

    const doctor = async () => {
      const out = await runCli(['doctor', '--only', 'revision_backfill', '--json'], { home, timeoutMs: 120_000 });
      const report = JSON.parse(out.stdout) as { checks: Check[] };
      return report.checks.find(c => c.name === 'revision_backfill')!;
    };
    const before = await doctor();
    expect(before.status).toBe('warn');
    expect((before.fix as { command?: string }).command).toBe('foresights apply-migrations --force-schema');

    const plain = await runCli(['apply-migrations', '--yes', '--no-autopilot-install'], { home, timeoutMs: 120_000 });
    expect(plain.exitCode).toBe(0);
    expect((await doctor()).status).toBe('warn');

    const resumed = await runCli(['apply-migrations', '--force-schema'], { home, timeoutMs: 120_000 });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stderr).toContain('page revision backfill complete: 3 row(s)');
    expect((await doctor()).status).toBe('ok');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 300_000);
