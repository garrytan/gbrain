import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal, preserveWithdrawnFenceRows } from '../src/core/facts/withdrawal.ts';
import { withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let disposePostgres: (() => Promise<void>) | undefined;
const sourceId = 'withdrawal-overlay-test';
beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(fixture.engine); disposePostgres = fixture.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await disposePostgres?.();
}, 60_000);

function fact(claim: string, extra: Partial<ParsedFact> = {}): ParsedFact {
  return { rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    active: true, context: 'Original evidence context', ...extra };
}

test('withdrawal covers prior context, inactive history and every legacy fence by fingerprint', async () => {
  const active = 'withdrawalcontextsentinel active claim';
  const expired = 'withdrawalhistorysentinel expired claim';
  const body = `Safe prose\n${renderFactsTable([fact(active), fact(active, { rowNum: 2, visibility: 'private' })])}
Historical section\n${renderFactsTable([fact(expired, { active: false, validUntil: '2020-01-01', context: 'superseded by #9' })])}`;
  for (const engine of engines) {
    await engine.putPage('legacy-withdrawal', { type: 'note', title: 'Synthetic legacy facts', compiled_truth: body }, { sourceId });
    for (const claim of [active, expired]) {
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: sourceId });
      expect((await recordFactWithdrawal(engine, stored.id, sourceId, true)).withdrawn).toBe(true);
    }
    const snapshot = (await engine.readPageSnapshot('legacy-withdrawal', { sourceId }))!;
    const rows = withdrawalFenceBlocks(snapshot.page.compiled_truth).flatMap(block => block.parsed.facts);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ active: false, forgotten: true });
    expect(rows[0].context).toStartWith('forgotten:');
    expect(rows[0].context).toContain('Original evidence context');
    expect(rows[1]).toMatchObject({ active: true, visibility: 'private', forgotten: false });
    expect(rows[2]).toMatchObject({ active: false, forgotten: true, validUntil: '2020-01-01' });
    expect(rows[2].context).toContain('superseded by #9');
    expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(active);
    expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(expired);
    const imported = await preserveWithdrawnFenceRows(engine, sourceId, body);
    expect(imported).toBe(snapshot.page.compiled_truth);
    expect(await preserveWithdrawnFenceRows(engine, sourceId, imported)).toBe(imported);
    await rebuildPendingPageProjections(engine, 100);
    const chunks = await engine.getChunks('legacy-withdrawal', { sourceId });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map(chunk => chunk.chunk_text).join('\n')).not.toContain('withdrawal');
    expect(await engine.searchKeyword('withdrawalcontextsentinel', { sourceId })).toEqual([]);
    expect(await engine.searchKeyword('withdrawalhistorysentinel', { sourceId })).toEqual([]);
  }
});
