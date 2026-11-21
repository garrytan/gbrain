/**
 * The follow, reconcile, fingerprint, allocator and status scenarios shared by test/shadow-follow.test.ts (PGLite)
 * and test/e2e/shadow-follow.test.ts (Postgres). Each runs on a seeded store with the real follower, follow child
 * and reconciler (test/helpers/follow-rig.ts) and the real Rust addon.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { buildFollowStatus, readPasses } from '../../src/shadow/follow-status.ts';
import { rowDigest, sortKey } from '../../src/shadow/follow-digest.ts';
import type { ShadowState } from '../../src/shadow/state.ts';
import { openReadSource } from '../../src/shadow/read-pool.ts';
import { Reconciler } from '../../src/shadow/reconcile.ts';
import { openFollowRig, type FollowRig } from './follow-rig.ts';
import { fillSeedFixture } from './shadow-seed-fixture.ts';

export interface FollowScenarioContext {
  primary: () => BrainEngine;
  addon: () => RustAddon;
  kind: 'pglite' | 'postgres';
  tempDir: () => string;
}

const STATE = { enabled: true, sample_rate: 0.1 } as unknown as ShadowState;
const PERSON = (title: string) => ({ type: 'person' as const, title, compiled_truth: `${title} works on widgets.`, timeline: '' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5)); // a pass restores only what was invalidated before it started
const status = (rig: FollowRig) => { rig.child.tick(); return buildFollowStatus(rig.dir, STATE); };

export function defineFollowScenarios(ctx: FollowScenarioContext): void {
  async function rig(): Promise<FollowRig> {
    const primary = ctx.primary();
    await fillSeedFixture(primary);
    const r = await openFollowRig(primary, ctx.addon(), ctx.tempDir(), ctx.kind);
    // A fresh epoch starts invalid ("not_reconciled"); the first full pass proves the seed and restores coverage.
    const first = await r.reconciler.run('full');
    expect(first.error).toBeUndefined();
    expect(first.repaired_rows).toBe(0);
    return r;
  }

  describe('follower', () => {
    test('committed writes reach the store, and a delete takes the page and its links with it', async () => {
      const r = await rig();
      try {
        await r.wrapped.putPage('people/bob-example', PERSON('Bob Example'));
        await r.wrapped.addLink('people/bob-example', 'companies/acme-example', 'works at', 'works_at');
        await r.wrapped.deletePage('people/alice-example');
        await r.settle();
        expect((await r.rust.getPage('people/bob-example'))?.title).toBe('Bob Example');
        expect((await r.rust.getLinks('people/bob-example')).map((l) => l.to_slug)).toEqual(['companies/acme-example']);
        expect(await r.rust.getPage('people/alice-example')).toBeNull();
        expect(await r.rust.getLinks('people/alice-example')).toEqual([]);
        // Deleting a page clears stores by slug that no key names: those relations are dirty until a pass for them.
        expect(status(r).follower.coverage_watermark).toMatchObject({ valid: false, invalidated_reason: 'relation_dirty' });
        await tick();
        const dirty = await r.reconciler.run('dirty', ['owner_only_marks', 'slug_aliases', 'page_aliases', 'slug_rename_history', 'open_loops']);
        expect(dirty.error).toBeUndefined();
        const s = status(r);
        expect(s.follower.state).toBe('following');
        expect(s.follower.applied_rows).toBeGreaterThan(0);
        // The follower covered everything: the next full pass finds nothing to repair.
        const pass = await r.reconciler.run('full');
        expect(pass.repaired_rows).toBe(0);
        expect(pass.follower_misses).toBe(0);
      } finally { await r.close(); }
    }, 90_000);

    test('a rolled-back transaction changes nothing in the store', async () => {
      const r = await rig();
      try {
        await r.wrapped.transaction(async (tx) => {
          await tx.putPage('people/ghost-example', PERSON('Ghost Example'));
          throw new Error('roll back');
        }).catch(() => undefined);
        await r.settle();
        expect(await r.rust.getPage('people/ghost-example')).toBeNull();
        expect((await r.reconciler.run('full')).repaired_rows).toBe(0);
      } finally { await r.close(); }
    }, 90_000);

    test('an older apply arriving after a newer one changes nothing', async () => {
      const r = await rig();
      try {
        const key = [{ name: 'key', type: 'text', collatable: true, category: 'S', generated: false }];
        const apply = (generation: number, value: string) => r.store.replaceRelationRows(
          r.seedId, 'config', generation, [{ sort: sortKey(key, ['gen_probe']).toString('hex'), key: { key: 'gen_probe' } }],
          [{ key: 'gen_probe', value }], [{ sort: sortKey(key, ['gen_probe']).toString('hex'), digest: rowDigest({ key: 'gen_probe', value }).toString('hex') }]);
        const base = Date.now() * 1000;
        expect((await apply(base + 2, 'new')).upserted).toBe(1);
        expect((await apply(base + 1, 'old')).skipped_older).toBe(1);
        const entries = await r.store.relationEntries(r.seedId, 'config', null, null, 5000);
        expect(entries.some((e) => e.generation === base + 2)).toBe(true);
      } finally { await r.close(); }
    }, 90_000);
  });

  describe('coverage watermark', () => {
    test('it goes invalid on an invalid item and on a sequence gap, and a full pass restores it', async () => {
      const r = await rig();
      try {
        expect(status(r).follower.coverage_watermark.valid).toBe(true);
        r.follower.publish({ seq: 1_000_000, committed_at: Date.now(), items: [{ kind: 'invalid', reason: 'test_unmappable' }] });
        await r.settle();
        let s = status(r);
        expect(s.follower.state).toBe('invalid');
        expect(s.follower.coverage_watermark.invalidated_reason).toBe('invalid:test_unmappable');
        await tick();
        await r.reconciler.run('full');
        expect(status(r).follower.coverage_watermark.valid).toBe(true);
        r.follower.publish({ seq: 2_000_000, committed_at: Date.now(), items: [] });
        await r.settle();
        s = status(r);
        expect(s.follower.coverage_watermark).toMatchObject({ valid: false, invalidated_reason: 'seq_gap' });
        await tick();
        await r.reconciler.run('full');
        expect(status(r).follower.state).toBe('following');
      } finally { await r.close(); }
    }, 90_000);
  });

  describe('reconcile', () => {
    test('it repairs a row changed behind the follower and counts it as a follower miss', async () => {
      const r = await rig();
      try {
        await ctx.primary().executeRaw(`UPDATE pages SET title = 'Changed Behind The Back' WHERE slug = 'people/alice-example'`);
        const pass = await r.reconciler.run('full');
        expect(pass.error).toBeUndefined();
        expect(pass.repaired_rows).toBe(1);
        expect(pass.repaired_by_relation).toEqual({ pages: 1 });
        expect(pass.follower_misses).toBe(1);
        expect((await r.rust.getPage('people/alice-example'))?.title).toBe('Changed Behind The Back');
        const clean = await r.reconciler.run('full');
        expect(clean.repaired_rows).toBe(0);
        const s = status(r);
        expect(s.reconcile).toMatchObject({ state: 'ok', consecutive_clean_full_passes: 1 });
        expect(readPasses(r.dir).map((p) => p.repaired_rows)).toEqual([0, 1, 0]);
        expect((await r.reconciler.run('full')).repaired_rows).toBe(0);
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(2);
      } finally { await r.close(); }
    }, 90_000);

    test('each interval is its own short read, and nothing talks to the store while a read is open', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      let open = 0;
      let pageIntervals = 0;
      let rpcsInsideReads = 0;
      const reads$ = { pauseMs: 0, close: () => base.close(), read: <T>(fn: Parameters<typeof base.read<T>>[0]) => base.read(async (tx, query) => { open++; try { return await fn(tx, query); } finally { open--; } }) };
      const rpc = <T>(method: string, args?: Record<string, unknown>): Promise<T> => { if (open > 0) rpcsInsideReads++; if (method === 'relationDigest' && args?.relation === 'pages') pageIntervals++; return r.rpc<T>(method, args); };
      try {
        await ctx.primary().executeRaw(`UPDATE pages SET title = 'Changed Behind The Back' WHERE slug = 'people/alice-example'`);
        const small = new Reconciler({ dir: r.dir, reads: reads$, rpc, follower: r.follower, intervalRows: 2 });
        const pass = await small.run('full');
        expect(pass.error).toBeUndefined();
        expect(pass.repaired_by_relation).toEqual({ pages: 1 });
        expect(pageIntervals).toBeGreaterThan(1); // the fixture's pages do not fit two rows
        expect(rpcsInsideReads).toBe(0);
        expect((await small.run('full')).repaired_rows).toBe(0);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('an interval read before a delete does not bring the deleted row back', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      let stale = true;
      // The pass's first read of pages is taken, then the page is deleted and followed before the pass uses the rows.
      const reads = { pauseMs: 0, close: () => base.close(), read: async <T>(fn: Parameters<typeof base.read<T>>[0]): Promise<T> => {
        const out = await base.read(fn);
        if (stale && Array.isArray(out) && out.some((row) => (row as { values?: { slug?: string } })?.values?.slug === 'people/alice-example')) { stale = false; await r.wrapped.deletePage('people/alice-example'); await r.settle(); }
        return out;
      } };
      try {
        const pass = await new Reconciler({ dir: r.dir, reads, rpc: r.rpc, follower: r.follower }).run('full');
        expect(pass.error).toBeUndefined();
        expect(stale).toBe(false);
        expect(await r.rust.getPage('people/alice-example')).toBeNull();
        expect((await r.reconciler.run('full')).repaired_rows).toBe(0);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('it repairs a missing row and an extra row', async () => {
      const r = await rig();
      try {
        const primary = ctx.primary();
        await primary.executeRaw(`DELETE FROM tags WHERE page_id = (SELECT id FROM pages WHERE slug = 'people/alice-example')`);
        await primary.putPage('people/carol-example', PERSON('Carol Example')); // behind the follower: the unwrapped primary
        const pass = await r.reconciler.run('full');
        expect(pass.repaired_by_relation.tags).toBe(1);
        // Deleting alice's tag fires the knowledge_revision trigger on her page row: that row differs too.
        expect(pass.repaired_by_relation.pages).toBe(2);
        expect(await r.rust.getTags('people/alice-example')).toEqual([]);
        expect((await r.rust.getPage('people/carol-example'))?.title).toBe('Carol Example');
      } finally { await r.close(); }
    }, 90_000);
  });

  describe('fingerprints and allocators', () => {
    test('a fact the follower applies is fingerprint-checked, and the probe passes against this primary', async () => {
      const r = await rig();
      try {
        await r.wrapped.insertFact({ fact: 'Bob likes C++ and .NET, v3.5.', entity_slug: 'people/alice-example', source: 'mcp:remember' }, { source_id: 'default' });
        await r.settle();
        const s = status(r);
        expect(s.fingerprints.checked_rows).toBeGreaterThanOrEqual(1);
        expect(s.fingerprints.mismatches).toBe(0);
        expect(s.fingerprints.probe).toMatchObject({ state: 'pass', mismatches: 0 });
        expect(s.fingerprints.probe.server_version).not.toBeNull();
      } finally { await r.close(); }
    }, 90_000);

    test('the allocator check verifies the store hands out ids above the primary', async () => {
      const r = await rig();
      try {
        const s = status(r);
        expect(s.allocators.verified).toBe(true);
        expect(s.allocators.checked_at).not.toBeNull();
      } finally { await r.close(); }
    }, 90_000);
  });
}
