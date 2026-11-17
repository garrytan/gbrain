/**
 * #5983/#5974 doctor checks: schema drift on managed-writer-guarded tables and
 * writes the database refused. PGLite, no DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { GUARDED_TABLES } from '../src/core/persistence/writer-guard-schema.ts';
import { checkManagedGuardSchemaDrift, checkPublicationRefusals, GUARDED_TABLE_COLUMNS } from '../src/commands/doctor/checks/managed-guard.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  for (const id of ['doctor-owned', 'doctor-other']) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  await registerLocalWriter(engine, 'cli');
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('managed guard doctor checks', () => {
  test('the canonical column list matches every committed catalog golden', () => {
    const dir = join(import.meta.dir, 'fixtures/goldens/catalog');
    const union: Record<string, Set<string>> = Object.fromEntries(GUARDED_TABLES.map(t => [t, new Set<string>()]));
    for (const file of readdirSync(dir).filter(f => /-engine-init-.*\.json$/.test(f))) {
      const tables = JSON.parse(readFileSync(join(dir, file), 'utf8')).golden.tables as Record<string, { columns: string[] }>;
      for (const table of GUARDED_TABLES) for (const column of tables[table].columns) union[table].add(column.split(' ')[1]);
    }
    // A migration that adds a column to a guarded table updates GUARDED_TABLE_COLUMNS in src/commands/doctor/checks/managed-guard.ts.
    expect(Object.fromEntries(GUARDED_TABLES.map(t => [t, [...union[t]].sort()]))).toEqual(
      Object.fromEntries(GUARDED_TABLES.map(t => [t, [...GUARDED_TABLE_COLUMNS[t]].sort()])));
  });

  test('a fresh brain is clean; a source_id column on a page-child table is named', async () => {
    expect(await checkManagedGuardSchemaDrift(engine)).toMatchObject({ status: 'ok', details: { extra_columns: [] } });
    await engine.executeRaw('ALTER TABLE tags ADD COLUMN source_id text');
    await engine.executeRaw('ALTER TABLE facts ADD COLUMN external_note text');
    try {
      const check = await checkManagedGuardSchemaDrift(engine);
      expect(check).toMatchObject({ status: 'warn', details: { extra_columns: ['facts.external_note', 'tags.source_id'], page_child_source_columns: ['tags.source_id'] } });
      expect(check.message).toContain('docs/guides/write-refusals.md#managed-guard-page-children');
    } finally {
      await engine.executeRaw('ALTER TABLE tags DROP COLUMN source_id');
      await engine.executeRaw('ALTER TABLE facts DROP COLUMN external_note');
    }
  });

  test('a write the guard refused is counted with its next step', async () => {
    expect(await checkPublicationRefusals(engine)).toMatchObject({ status: 'ok', details: { guard_refusals: 0 } });
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='doctor-owned'");
    const ctx = { engine, config: { engine: 'pglite' }, sourceId: 'doctor-owned', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    const authority = await submissionAuthority(ctx, 'put_page', 'doctor-owned', source.incarnation, 'refused');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: 'doctor-owned', sourceIncarnation: source.incarnation,
        slug: 'refused', pageId: null, requestId: randomUUID(), callerIntent: { content: 'x' }, intent: { content: 'x' }, authority });
      const row = (await claimNextWrite(engine, randomUUID()))!;
      const done = await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage('leak', { type: 'note', title: 'x', compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: 'doctor-other' });
        return {};
      } });
      expect(done.error_code).toBe('writer_coordinator_required');
    } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
    const check = await checkPublicationRefusals(engine);
    expect(check).toMatchObject({ status: 'warn', details: { guard_refusals: 1, trigger_refusals: 0, unclassified_p0001: 0 } });
    expect(check.message).toContain('foresights sources writer status --probe --json');
  });
});
