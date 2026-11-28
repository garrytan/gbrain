/**
 * The follow, reconcile, fingerprint, allocator and status scenarios shared by test/shadow-follow.test.ts (PGLite)
 * and test/e2e/shadow-follow.test.ts (Postgres). Each runs on a seeded store with the real follower, follow child
 * and reconciler (test/helpers/follow-rig.ts) and the real Rust addon.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { buildFollowStatus, readPasses } from '../../src/shadow/follow-status.ts';
import { rowDigest, sortKey } from '../../src/shadow/follow-digest.ts';
import { nextGeneration } from '../../src/shadow/follower.ts';
import type { ShadowState } from '../../src/shadow/state.ts';
import { openReadSource } from '../../src/shadow/read-pool.ts';
import { Reconciler } from '../../src/shadow/reconcile.ts';
import { planAsWrittenSource } from '../../src/shadow/writer-coverage.ts';
import { openFollowRig, type FollowRig } from './follow-rig.ts';
import { snapshotPersistence, snapshotTree } from './primary-snapshot.ts';
import { linkEntityIdentity } from '../../src/core/entity-identity.ts';
import { fillSeedFixture } from './shadow-seed-fixture.ts';

export interface FollowScenarioContext {
  primary: () => BrainEngine;
  addon: () => RustAddon;
  kind: 'pglite' | 'postgres';
  tempDir: () => string;
}

const STATE = { enabled: true, sample_rate: 0.1 } as unknown as ShadowState;
type Snapshot = { tables: Record<string, string[]>; files: Record<string, string> };
const PERSON = (title: string) => ({ type: 'person' as const, title, compiled_truth: `${title} works on widgets.`, timeline: '' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5)); // a pass restores only what was invalidated before it started
const status = (rig: FollowRig) => { rig.child.tick(); return buildFollowStatus(rig.dir, STATE); };

export function defineFollowScenarios(ctx: FollowScenarioContext): void {
  async function rig(opts: { dirty?: (relation: string) => void } = {}): Promise<FollowRig> {
    const primary = ctx.primary();
    await fillSeedFixture(primary);
    const r = await openFollowRig(primary, ctx.addon(), ctx.tempDir(), ctx.kind, opts);
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

    test('a rename also moves a subject-scoped withdrawal, and the watermark waits for a pass over it', async () => {
      const r = await rig();
      try {
        await ctx.primary().executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', 'people/alice-example', 'hash-1')`);
        await tick();
        expect((await r.reconciler.run('full')).error).toBeUndefined();
        await r.wrapped.updateSlug('people/alice-example', 'people/alice-renamed');
        await r.settle();
        expect(status(r).follower.coverage_watermark).toMatchObject({ valid: false, invalidated_reason: 'relation_dirty' });
        await tick();
        // Every relation a rename names except the withdrawals: still not covered.
        expect((await r.reconciler.run('dirty', ['slug_aliases', 'slug_rename_history', 'page_aliases', 'owner_only_marks'])).error).toBeUndefined();
        expect(status(r).follower.coverage_watermark.valid).toBe(false);
        expect((await r.reconciler.run('dirty', ['fact_withdrawals'])).error).toBeUndefined();
        expect(status(r).follower.state).toBe('following');
        const pass = await r.reconciler.run('full');
        expect(pass.repaired_rows).toBe(0);
        expect(pass.follower_misses).toBe(0);
      } finally { await r.close(); }
    }, 90_000);

    test('link state follows link writes, and entity groups, purge tombstones and tokens follow raw writes after a pass for them', async () => {
      const r = await rig();
      try {
        // The engine refreshes the relationship state of a link pair itself, so the write map names it: no pass is needed.
        await r.wrapped.removeLink('people/alice-example', 'companies/acme-example', 'works_at');
        await r.wrapped.addLink('people/alice-example', 'companies/acme-example', 'works at again', 'works_at');
        await r.wrapped.putPage('people/bob-example', PERSON('Bob Example'));
        await r.wrapped.addLink('people/bob-example', 'companies/acme-example', 'works at', 'works_at');
        await r.settle();
        const state = await ctx.primary().executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM link_relationships`);
        expect(state[0]!.n).toBe(4);
        await tick();
        expect(status(r).follower.coverage_watermark.valid).toBe(true);
        // A raw write reaches the follower as a relation-level change, which a pass for that relation repairs.
        await linkEntityIdentity(r.wrapped, { entityId: 'person/bob', slug: 'people/bob-example', sourceId: 'default', canonical: true });
        await r.wrapped.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, actor) VALUES ('default', 'world', '*', gbrain_fact_fingerprint('Bob owes Acme money'), 'owner')`);
        await r.wrapped.executeRaw(`INSERT INTO access_tokens (name, token_hash) VALUES ('bob-key', $1)`, [createHash('sha256').update('shadow-follow-token').digest('hex')]);
        await r.settle();
        expect(status(r).follower.coverage_watermark).toMatchObject({ valid: false, invalidated_reason: 'relation_dirty' });
        await tick();
        const probedAt = status(r).fingerprints.probe.checked_at;
        expect((await r.reconciler.run('dirty', ['entity_identities', 'fact_purges', 'access_tokens'])).error).toBeUndefined();
        expect(status(r).follower.coverage_watermark.valid).toBe(true);
        // A pass for the purge tombstones runs the fingerprint probe again: its answer depends on them.
        expect(status(r).fingerprints.probe.checked_at).not.toBe(probedAt);
        const pass = await r.reconciler.run('full');
        expect(pass.repaired_rows).toBe(0);
        expect(pass.follower_misses).toBe(0);
        expect(pass.repaired_by_relation).toEqual({});
      } finally { await r.close(); }
    }, 90_000);

    test('a probe that fails in a dirty pass for purge tombstones clears the cached verdict and keeps coverage invalid until a probe succeeds', async () => {
      const r = await rig();
      try {
        expect(status(r).fingerprints.probe.state).toBe('pass');
        await r.wrapped.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, actor) VALUES ('default', 'world', '*', gbrain_fact_fingerprint('Bob owes Acme money'), 'owner')`);
        await r.settle();
        expect(status(r).follower.coverage_watermark).toMatchObject({ valid: false, invalidated_reason: 'relation_dirty' });
        await tick();
        const failing = spyOn(r.reconciler, 'probe').mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        try {
          const failed = await r.reconciler.run('dirty', ['fact_purges']);
          expect(failed.error).toBe('probe:57014');
        } finally { failing.mockRestore(); }
        // The old passing verdict no longer stands, and the rows are not covered.
        expect(status(r).fingerprints.probe.state).toBe('not_run');
        expect(status(r).follower.coverage_watermark.valid).toBe(false);
        // A later pass whose probe succeeds records a fresh verdict and restores coverage: nothing is wedged.
        await tick();
        const again = await r.reconciler.run('dirty', ['fact_purges']);
        expect(again.error).toBeUndefined();
        // The fresh verdict follows the host: a host whose lower() or whitespace rules differ from PGLite's fails it while a tombstone exists.
        const probe = status(r).fingerprints.probe;
        expect(probe.state).toBe(probe.differing_code_points_total > 0 ? 'fail' : 'pass');
        expect(probe.checked_at).not.toBeNull();
        expect(status(r).follower.coverage_watermark.valid).toBe(true);
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

    test('stopping the reconciler and closing the read source ends a pass in flight and opens nothing again', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      let readsAfterStop = 0;
      let stopped = false;
      const reads = { pauseMs: 0, close: () => base.close(), read: <T>(fn: Parameters<typeof base.read<T>>[0]) => { if (stopped) readsAfterStop++; return base.read(fn); } };
      let small: Reconciler;
      const rpc = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
        const out = await r.rpc<T>(method, args);
        if (method === 'relationDigest' && !stopped) { stopped = true; small.stop(); await base.close(); }
        return out;
      };
      try {
        small = new Reconciler({ dir: r.dir, reads, rpc, follower: r.follower, intervalRows: 2 });
        const pass = await small.run('full');
        expect(pass.error).toMatch(/stopped/);
        expect(readsAfterStop).toBe(0);
        await expect(base.read(async () => 1)).rejects.toThrow(/closed/);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('a process that closes mid-pass records no failed pass and keeps the clean count; the next process finishes the same pass', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        const before = status(r).reconcile.consecutive_clean_full_passes;
        const passes = readPasses(r.dir).length;
        const beforeAt = status(r).reconcile.last_clean_full_pass_at;
        expect(typeof beforeAt).toBe('string');
        expect(before).toBeGreaterThanOrEqual(1);
        let digests = 0;
        let small: Reconciler;
        const stopping = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
          const out = await r.rpc<T>(method, args);
          if (method === 'relationDigest' && ++digests === 3) small.stop();
          return out;
        };
        small = new Reconciler({ dir: r.dir, reads: base, rpc: stopping, follower: r.follower, intervalRows: 2 });
        const stopped = await small.run('full', undefined, { resume: true });
        // Closing is not a failed pass: nothing is recorded, so the trailing clean passes still count.
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(before);
        expect(readPasses(r.dir)).toHaveLength(passes);
        expect(stopped.error).toBe('stopped');
        // The half done is no pass: the newest clean full pass is still the one before it (criterion 1's 24 h rule reads this).
        expect(status(r).reconcile.last_clean_full_pass_at).toBe(beforeAt);
        const progress = JSON.parse(readFileSync(join(r.dir, 'reconcile', 'progress.json'), 'utf8')) as { id: string; done: string[] };
        expect(progress.id).toBe(stopped.id);
        let resumedDigests = 0;
        const counting = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => { if (method === 'relationDigest') resumedDigests++; return r.rpc<T>(method, args); };
        const resumed = await new Reconciler({ dir: r.dir, reads: base, rpc: counting, follower: r.follower, intervalRows: 2 }).run('full', undefined, { resume: true });
        expect(resumed.error).toBeUndefined();
        expect(resumed.id).toBe(stopped.id);
        expect(resumed.started_at).toBe(stopped.started_at);
        expect(resumed.repaired_rows).toBe(0);
        expect(existsSync(join(r.dir, 'reconcile', 'progress.json'))).toBe(false);
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(before + 1);
        // Only the finished pass counts, at the time it finished.
        expect(status(r).reconcile.last_clean_full_pass_at).toBe(resumed.finished_at);
        // The resumed pass walked only what was left: a fresh pass reads every interval again.
        let freshDigests = 0;
        const fresh = await new Reconciler({ dir: r.dir, reads: base, rpc: async <T>(method: string, args?: Record<string, unknown>): Promise<T> => { if (method === 'relationDigest') freshDigests++; return r.rpc<T>(method, args); }, follower: r.follower, intervalRows: 2 }).run('full', undefined, { resume: true });
        expect(fresh.id).not.toBe(stopped.id);
        expect(resumedDigests).toBeLessThan(freshDigests);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('a process stopped right after the last interval of a relation repaired a row keeps that repair: the resumed pass reports it and is not clean', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        expect(status(r).reconcile.consecutive_clean_full_passes).toBeGreaterThanOrEqual(1);
        const since = new Date(Date.now() - 1_000);
        const unknownBefore = planAsWrittenSource(r.dir).unknownPaths(since);
        // One interval larger than the page count: all of pages is one short interval, its last, which no interval
        // checkpoint follows. The drifted row is in it.
        const [{ n }] = await ctx.primary().executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages`);
        const size = Number(n) + 1;
        await ctx.primary().executeRaw(`UPDATE pages SET title = 'Changed In The Last Interval' WHERE id = (SELECT max(id) FROM pages)`);
        let small: Reconciler;
        let cutAt: number | null = null;
        const stopping = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
          const out = await r.rpc<T>(method, args);
          // The cut: the store already took the repair, and the reconciler has not read again.
          if (method === 'replaceInterval' && args?.relation === 'pages' && args?.hi === null && cutAt === null) { cutAt = Date.now(); small.stop(); }
          return out;
        };
        small = new Reconciler({ dir: r.dir, reads: base, rpc: stopping, follower: r.follower, intervalRows: size });
        const stopped = await small.run('full', undefined, { resume: true });
        expect(cutAt).not.toBeNull();
        expect(stopped.error).toBe('stopped');
        expect(stopped.repaired_by_relation).toEqual({ pages: 1 });
        // The store holds the repaired row now, so a pass that reads that interval again finds nothing to repair.
        const resumed = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full', undefined, { resume: true });
        expect(resumed.error).toBeUndefined();
        expect(resumed.id).toBe(stopped.id);
        expect(resumed.repaired_rows).toBeGreaterThanOrEqual(1);
        expect(resumed.repaired_by_relation.pages).toBeGreaterThanOrEqual(1);
        expect(resumed.follower_misses).toBeGreaterThanOrEqual(1);
        const passes = readPasses(r.dir).filter((p) => p.id === stopped.id);
        expect(passes).toHaveLength(1);
        expect(passes[0]!.repaired_rows).toBeGreaterThanOrEqual(1);
        // A repaired pass ends the clean streak, and criterion 1 has no clean pass to read until the next one.
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(0);
        expect(status(r).reconcile.last_clean_full_pass_at).toBeNull();
        // The repair is writer-coverage evidence: a path the plan as written did not account for.
        expect(planAsWrittenSource(r.dir).unknownPaths(since)).toBe(unknownBefore + 1);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('a half-done pass is not resumed under another continuity, seed or evidence epoch, or without asking', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        const file = join(r.dir, 'reconcile', 'progress.json');
        for (const change of [{ continuity: 'another-session-run' }, { seed_id: 'another-seed' }, { epoch_id: 'another-epoch' }, null]) {
          let small: Reconciler;
          let digests = 0;
          const stopping = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
            const out = await r.rpc<T>(method, args);
            if (method === 'relationDigest' && ++digests === 3) small.stop();
            return out;
          };
          small = new Reconciler({ dir: r.dir, reads: base, rpc: stopping, follower: r.follower, intervalRows: 2 });
          const stopped = await small.run('full', undefined, { resume: true });
          expect(stopped.error).toBe('stopped');
          if (change) writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...change }));
          const next = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: 2 }).run('full', undefined, change ? { resume: true } : {});
          expect(next.error).toBeUndefined();
          expect(next.id).not.toBe(stopped.id);
          expect(existsSync(file)).toBe(false);
        }
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

    test('a clean interval still raises the fence: an older apply that arrives after the pass changes nothing', async () => {
      const r = await rig();
      try {
        const key = [{ name: 'key', type: 'text', collatable: true, category: 'S', generated: false }];
        const sort = sortKey(key, ['gen_probe']).toString('hex');
        const apply = (generation: number, value: string) => r.store.replaceRelationRows(
          r.seedId, 'config', generation, [{ sort, key: { key: 'gen_probe' } }], [{ key: 'gen_probe', value }],
          [{ sort, digest: rowDigest({ key: 'gen_probe', value }).toString('hex') }]);
        await ctx.primary().executeRaw(`INSERT INTO config (key, value) VALUES ('gen_probe', 'current') ON CONFLICT (key) DO UPDATE SET value = 'current'`);
        expect((await r.reconciler.run('full')).repaired_rows).toBeGreaterThanOrEqual(1);
        // A follower read taken now carries this generation; its apply is still on the way when the next pass verifies the store.
        const early = nextGeneration();
        await tick();
        const clean = await r.reconciler.run('full');
        expect(clean.repaired_rows).toBe(0);
        const late = await apply(early, 'intermediate');
        expect(late.skipped_older).toBe(1);
        expect(await r.rust.getConfig('gen_probe')).toBe('current');
      } finally { await r.close(); }
    }, 90_000);

    test('displacing a page also marks its tags dirty, and a pass over what was reported leaves the store equal', async () => {
      const dirtied: string[] = [];
      const r = await rig({ dirty: (relation) => dirtied.push(relation) });
      try {
        const primary = ctx.primary();
        const tagsOf = async (slug: string) => (await primary.getTags(slug)).sort();
        expect(await tagsOf('people/alice-example')).not.toEqual([]);
        // Acme takes alice's slug and alice is renamed, but only acme's change reaches the follower: alice, still unrenamed in the store, is displaced.
        await primary.executeRaw(`UPDATE pages SET slug = 'people/alice-renamed' WHERE slug = 'people/alice-example'`);
        await primary.executeRaw(`UPDATE pages SET slug = 'people/alice-example' WHERE slug = 'companies/acme-example'`);
        r.follower.publish({ seq: 3_000_000, committed_at: Date.now(), items: [{ kind: 'rows', relation: 'pages', selector: { slug: 'people/alice-example' }, before_keys: null }] });
        await r.settle();
        expect(dirtied).toContain('pages');
        expect(dirtied).toContain('tags');
        await tick();
        expect((await r.reconciler.run('dirty', [...new Set(dirtied)])).error).toBeUndefined();
        expect(await r.rust.getTags('people/alice-renamed')).toEqual(await tagsOf('people/alice-renamed'));
        const pass = await r.reconciler.run('full');
        expect(pass.repaired_rows).toBe(0);
      } finally { await r.close(); }
    }, 90_000);
  });

  describe('managed brain', () => {
    // The brain keeps its files in a checkout (persistence_brain.enabled); shadow mode must leave every persistence_* row and that checkout alone.
    async function managedRig(): Promise<{ r: FollowRig; contentRoot: string; before: Snapshot; snap: () => Promise<Snapshot> }> {
      const primary = ctx.primary();
      await fillSeedFixture(primary);
      await primary.executeRaw('INSERT INTO git_canonical_brain(singleton, strict_sources) VALUES (1, 0) ON CONFLICT (singleton) DO NOTHING'); // a fresh brain has this row; the PGLite test reset clears it
      await primary.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
      const contentRoot = join(ctx.tempDir(), 'content-root');
      mkdirSync(join(contentRoot, 'people'), { recursive: true });
      writeFileSync(join(contentRoot, 'people', 'alice-example.md'), '# Alice Example\n');
      writeFileSync(join(contentRoot, 'index.md'), '# index\n');
      const snap = async () => ({ tables: await snapshotPersistence(primary), files: snapshotTree(contentRoot) });
      const before = await snap(); // taken before the seed, so the seed is covered too
      const r = await openFollowRig(primary, ctx.addon(), ctx.tempDir(), ctx.kind);
      return { r, contentRoot, before, snap };
    }

    test('seeding, following a batch of writes and a full reconcile pass change no persistence_* row and nothing in the content root', async () => {
      const { r, before, snap } = await managedRig();
      try {
        expect(before.tables.persistence_brain!.some((row) => row.includes('"enabled":true'))).toBe(true);
        expect(Object.keys(before.files)).toContain('people/alice-example.md');
        const first = await r.reconciler.run('full');
        expect(first.error).toBeUndefined();
        // A managed brain accepts canonical writes only from a writer that names its source, as the persistence coordinator does.
        await r.wrapped.transaction(async (tx) => {
          await tx.executeRaw("SELECT set_config('gbrain.write_sources', '[\"default\"]', true)");
          await tx.putPage('people/bob-example', PERSON('Bob Example'));
          await tx.addLink('people/bob-example', 'companies/acme-example', 'works at', 'works_at');
          await tx.deletePage('people/alice-example');
        });
        await r.settle();
        await tick();
        const pass = await r.reconciler.run('full');
        expect(pass.error).toBeUndefined();
        // The follower applied the writes, and the pass found nothing it had missed.
        expect((await r.rust.getPage('people/bob-example'))?.title).toBe('Bob Example');
        expect((await r.rust.getLinks('people/bob-example')).map((l) => l.to_slug)).toEqual(['companies/acme-example']);
        expect(await r.rust.getPage('people/alice-example')).toBeNull();
        expect(status(r).follower.applied_rows).toBeGreaterThan(0);
        expect(pass.follower_misses).toBe(0);
        // The writes changed pages and links on the brain; they and shadow mode left everything else alone.
        const after = await snap();
        expect(after.tables).toEqual(before.tables);
        expect(after.files).toEqual(before.files);
      } finally { await r.close(); }
    }, 120_000);

    test('the snapshot check catches a write to a persistence_* table and to the content root', async () => {
      const { r, contentRoot, before, snap } = await managedRig();
      try {
        await ctx.primary().executeRaw("UPDATE persistence_brain SET activated_at = '2026-01-02T03:04:05Z' WHERE singleton = 1");
        expect((await snap()).tables).not.toEqual(before.tables);
        await ctx.primary().executeRaw('UPDATE persistence_brain SET activated_at = NULL WHERE singleton = 1');
        expect((await snap()).tables).toEqual(before.tables);
        writeFileSync(join(contentRoot, 'index.md'), '# index changed\n');
        expect((await snap()).files).not.toEqual(before.files);
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

    test('a full pass counts the primary refresh rows a swap must drain first', async () => {
      const r = await rig();
      try {
        expect(status(r).primary_refreshes).toMatchObject({ nonterminal_rows: 0 });
        const primary = ctx.primary();
        const [wt] = await primary.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id::text AS id');
        await primary.executeRaw(`INSERT INTO persistence_worktree_refreshes(worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
          VALUES($1::uuid,ARRAY['default'],gen_random_uuid(),1,1,'fenced',$2,$3,'origin/main')`, [wt!.id, 'a'.repeat(40), 'b'.repeat(40)]);
        expect((await r.reconciler.run('full')).nonterminal_refresh_rows).toBe(1);
        const s = status(r);
        expect(s.primary_refreshes.nonterminal_rows).toBe(1);
        expect(s.primary_refreshes.checked_at).toBe(s.reconcile.last_pass!.finished_at);
        await primary.executeRaw("UPDATE persistence_worktree_refreshes SET state='aborted', completed_at=now()");
        await r.reconciler.run('full');
        expect(status(r).primary_refreshes.nonterminal_rows).toBe(0);
      } finally { await r.close(); }
    }, 90_000);
  });
}
