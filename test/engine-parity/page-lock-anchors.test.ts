/**
 * BrainEngine parity — a page write with no stored page write guard row.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through harness.ts), a
 *    page write and a transaction that locks page keys and writes a page behave the same whether or not a guard row
 *    for the key is already stored. On the SQL arms, `page_write_guards` rows are lock anchors only
 *    (src/core/page-state/guards.ts): each lock inserts its row with ON CONFLICT DO NOTHING and then takes it FOR
 *    UPDATE in the same pipeline, so a missing row is written again before it is read. The Rust store has no such
 *    table; it holds the keys in the transaction (rust/crates/gbrain-store/src/transactions.rs hold_page_keys).
 *  - Regression: a brain copied without its guard rows (the Rust shadow seed does not copy them) that refuses,
 *    loses or misorders a page write, or reads a page differently, because a guard row it never needed is absent.
 *  - Why existing coverage misses it: every other case writes into a brain whose guard rows the same engine wrote,
 *    so no case starts a write with the anchor missing.
 *  - Seam: none in the comparison. Typed members only. On the SQL arms the case removes the stored guard rows with
 *    harness-style SQL behind the backend switch (no typed member deletes them), and checks that the writes put
 *    them back; the Rust arm has no rows to remove.
 */
import { describe, expect } from 'bun:test';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

/** Fixture: remove every stored page write guard row (SQL arms) and return the slugs removed. */
async function dropGuardRows(engine: BrainEngine, backend: ParityBackend): Promise<string[]> {
  if (backend === 'rust') return [];
  const rows = await engine.executeRaw<{ slug: string }>('DELETE FROM page_write_guards RETURNING slug');
  return rows.map(r => r.slug).sort();
}

/** Fixture: the stored page write guard slugs (SQL arms). */
async function guardSlugs(engine: BrainEngine, backend: ParityBackend): Promise<string[]> {
  if (backend === 'rust') return [];
  const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_write_guards ORDER BY slug');
  return rows.map(r => r.slug);
}

describe('engine parity: page lock anchors', () => {
  parityTest('a page write and a key-locked transaction behave the same with no stored guard row', {
    methods: ['putPage', 'getPage', 'transaction', 'lockPageKeys'],
  }, async (engine, backend) => {
    await engine.putPage('notes/anchor-a', NOTE('Anchor A', 'first body'));
    const removed = await dropGuardRows(engine, backend);
    if (backend !== 'rust') expect(removed).toContain('notes/anchor-a');

    // A plain overwrite of a page whose guard row is gone.
    await engine.putPage('notes/anchor-a', NOTE('Anchor A', 'second body'));
    // A transaction that locks an existing key and a new one (neither has a row) and writes both.
    const locked = await engine.transaction(async (tx) => {
      await tx.lockPageKeys([{ sourceId: 'default', slug: 'notes/anchor-b' }, { sourceId: 'default', slug: 'notes/anchor-a' }]);
      await tx.putPage('notes/anchor-b', NOTE('Anchor B', 'new body'));
      await tx.putPage('notes/anchor-a', NOTE('Anchor A', 'third body'));
      return 'committed';
    });
    if (backend !== 'rust') expect(await guardSlugs(engine, backend)).toEqual(['notes/anchor-a', 'notes/anchor-b']);

    const view = async (slug: string) => {
      const page = await engine.getPage(slug);
      return page && { title: page.title, compiled_truth: page.compiled_truth };
    };
    const answers = { locked, a: await view('notes/anchor-a'), b: await view('notes/anchor-b') };
    expect(answers).toEqual({
      locked: 'committed',
      a: { title: 'Anchor A', compiled_truth: 'third body' },
      b: { title: 'Anchor B', compiled_truth: 'new body' },
    });
    return answers;
  });
});
