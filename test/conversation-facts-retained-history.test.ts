/**
 * Wave 9 follow-ups, item 2 (lifecycle half): the conversation extractor's
 * own bookkeeping no longer undoes a label repair.
 *
 * Protects: an expired completion marker does not keep a page "complete"
 * (the completion query reads active outcomes only); a replacement batch
 * expires, never deletes, a row an open loop or another fact's
 * superseded_by references, and keeps rows a label repair retired; and the
 * hand-off flag `--slugs` selects exactly the named pages. Unmanaged PGLite,
 * injected extractor (no gateway).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SLUG = 'meetings/2026-09-28-sync';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function brain(run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  await engine.putPage(SLUG, { type: 'meeting', title: 'Sync', frontmatter: { date: '2026-09-28' }, compiled_truth:
    '**Alice Example:** Can you send the plan?\n**Bob Example:** Yes, on Thursday.\n**Alice Example:** Thanks, I review on Mondays.' });
  await run(engine);
}

const extract = (engine: BrainEngine, calls: { n: number }) => runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0,
  overrideDisabled: true, extractor: async () => { calls.n++; return [{ fact: 'Bob Example sends the plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null, source: 'x' }]; } });

test('an expired completion marker does not keep the page complete', async () => {
  await brain(async engine => {
    const calls = { n: 0 };
    await extract(engine, calls);
    expect((await extract(engine, calls)).pages_skipped_completed).toBe(1);
    await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE source=$1', [TERMINAL_AUDIT_SOURCE]);
    const rerun = await extract(engine, calls);
    expect(rerun).toMatchObject({ pages_processed: 1, pages_skipped_completed: 0 });
    expect(calls.n).toBe(2);
  });
});

test('a replacement keeps referenced and label-retired rows as expired history', async () => {
  await brain(async engine => {
    const calls = { n: 0 };
    await extract(engine, calls);
    const [first] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source='cli:extract-conversation-facts' ORDER BY id LIMIT 1");
    await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, detector, fact_id)
      VALUES ('default', 'k', 'commitment_owed_by_me', 'Send the plan', 'manual', $1)`, [first!.id]);
    const [retired] = await engine.insertFacts([{ fact: 'Date said Thursday', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts',
      context: 'from x segment 1970-01-01T00:00:00Z.. | retired: conversation-labels abc', expired_at: new Date(), row_num: 50, source_markdown_slug: SLUG }],
    { source_id: 'default' }).then(r => r.ids);
    const run = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, overrideDisabled: true, force: true,
      extractor: async () => [{ fact: 'Bob Example sends the plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null, source: 'x' }] });
    expect(run).toMatchObject({ pages_processed: 1, facts_inserted: 1 });
    const kept = await engine.executeRaw<{ id: number; expired: boolean }>('SELECT id, expired_at IS NOT NULL AS expired FROM facts WHERE id=ANY($1::bigint[]) ORDER BY id',
      [[first!.id, retired!]]);
    expect(kept.map(r => [Number(r.id), r.expired])).toEqual([[Number(first!.id), true], [Number(retired), true]]);
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL
      AND source='cli:extract-conversation-facts'`, [SLUG]);
    expect(n).toBe(1);
  });
});

test('--slugs selects exactly the named pages', async () => {
  const { parseArgs } = await import('../src/commands/extract-conversation-facts.ts') as unknown as { parseArgs: (args: string[]) => Record<string, unknown> };
  expect(parseArgs(['--source-id', 'default', '--slugs', 'meetings/a,meetings/b', '--dry-run'])).toMatchObject({ slugs: ['meetings/a', 'meetings/b'], dryRun: true });
});
