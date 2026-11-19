/**
 * #5904 probe (E28): `foresights extract timeline --source db` on a managed brain
 * writes through the coordinator, and a refused write is reported honestly
 * with a non-zero exit. Shared by the PGLite test and the Postgres E2E.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { managedBrain } from './managed-brain.ts';

const put = (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: person\ntitle: ${slug}\n---\n\n${body}\n` } });

const rows = (engine: BrainEngine, slug: string) => engine.executeRaw<{ date: string; summary: string }>(
  `SELECT t.date::text AS date, t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id
    WHERE p.slug = $1 ORDER BY t.date`, [slug]);

/** A page published before timeline projection: its stored rows are gone, its body still has the bullets. */
async function dropStoredTimeline(engine: BrainEngine, slug: string) {
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
    tx.executeRaw('DELETE FROM timeline_entries WHERE page_id = (SELECT id FROM pages WHERE slug = $1)', [slug]), TEST_WRITE_ATTRIBUTION));
}

async function runCaptured(engine: BrainEngine, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  const priorExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
  try {
    await runExtract(engine, args);
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = priorExitCode ?? 0;
  }
  const exitCode = currentExitCode();
  _resetCliExitVerdictForTests();
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';
const BODY = 'A person.\n\n## Timeline\n\n- **2026-01-02** | test — Met Acme\n- **2026-02-03** | test — Joined Acme';

export async function managedTimelineDbWritesThroughCoordinator(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    await put(ctx, ALICE, BODY);
    await disposePersistenceConsumer(engine);
    await dropStoredTimeline(engine, ALICE);
    expect(await rows(engine, ALICE)).toEqual([]);

    const run = await runCaptured(engine, ['timeline', '--source', 'db']);
    expect(run.stderr).not.toContain('refused');
    expect(run.stderr).not.toContain('rows lost');
    expect(run.exitCode).toBe(0);
    expect(await rows(engine, ALICE)).toEqual([
      { date: '2026-01-02', summary: 'Met Acme' },
      { date: '2026-02-03', summary: 'Joined Acme' },
    ]);
    expect(run.stdout).toContain('Timeline: created 2 entries from 1 pages (db source)');

    const again = await runCaptured(engine, ['timeline', '--source', 'db']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('Timeline: created 0 entries from 1 pages (db source)');
    expect(await rows(engine, ALICE)).toHaveLength(2);
  }, { databaseUrl });
}

export async function managedTimelineDbRefusalExitsNonZero(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    await put(ctx, BOB, BODY);
    await put(ctx, ALICE, BODY);
    await disposePersistenceConsumer(engine);
    await dropStoredTimeline(engine, ALICE);
    const bobBefore = await rows(engine, BOB);
    expect(bobBefore).toHaveLength(2);

    await engine.executeRaw(`CREATE OR REPLACE FUNCTION test_refuse_timeline() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: refused by test'; END $$`);
    await engine.executeRaw('CREATE TRIGGER test_refuse_timeline BEFORE INSERT ON timeline_entries FOR EACH ROW EXECUTE FUNCTION test_refuse_timeline()');
    try {
      const run = await runCaptured(engine, ['timeline', '--source', 'db']);
      expect(run.exitCode).toBe(1);
      // #5974: the coordinator names a guard refusal inside its publication instead of an opaque storage_error.
      expect(run.stderr).toContain('refused: writer_coordinator_required; nothing written; existing timeline rows are untouched');
      expect(run.stderr).not.toContain('rows lost');
      expect(run.stderr).toContain('1 page(s) not written, 0 written');
      expect(run.stderr).toContain('foresights extract --stale');
      expect(run.stderr).toContain('docs/guides/write-refusals.md#extract-timeline-refused');
      expect(await rows(engine, BOB)).toEqual(bobBefore);
      expect(await rows(engine, ALICE)).toEqual([]);
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS test_refuse_timeline ON timeline_entries');
      await engine.executeRaw('DROP FUNCTION IF EXISTS test_refuse_timeline()');
    }
  }, { databaseUrl });
}
