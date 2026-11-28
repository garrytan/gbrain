/**
 * The follow, reconcile, fingerprint, allocator and status scenarios shared by test/shadow-follow.test.ts (PGLite)
 * and test/e2e/shadow-follow.test.ts (Postgres). Each runs on a seeded store with the real follower, follow child
 * and reconciler (test/helpers/follow-rig.ts) and the real Rust addon.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { FollowChild } from '../../src/shadow/follow-child.ts';
import * as followStatus from '../../src/shadow/follow-status.ts';
import { buildFollowStatus, readFollowerFile, readPasses } from '../../src/shadow/follow-status.ts';
import { rowDigest, sortKey } from '../../src/shadow/follow-digest.ts';
import { nextGeneration } from '../../src/shadow/follower.ts';
import { SHADOW_STATE_VERSION, writeShadowState, type ShadowState } from '../../src/shadow/state.ts';
import { openReadSource } from '../../src/shadow/read-pool.ts';
import { fullPassDue, Reconciler } from '../../src/shadow/reconcile.ts';
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

    // Hole 1 (strict basis): a full pass reads the basis (the counters the follower's state will be proven from) before it
    // starts, keeps it in its resume point, and hands it to the serving process only once its watermark is restored. The
    // options are passed untyped, so a build without them fails on the assertions.
    for (const variant of ['resumed with its basis', 'resumed from a point an older build wrote'] as const) test(`a fresh full pass reads its basis before it starts and keeps it in its resume point; it is handed over only after the watermark restore (${variant})`, async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        let asked = 0;
        const askedAt: number[] = [];
        const basis = async (): Promise<string | null> => { askedAt.push(Date.now()); return `basis-${++asked}`; };
        const handed: Array<{ token: string; at: number }> = [];
        let restoredAt = 0;
        const onBasis = (token: string): void => { handed.push({ token, at: Date.now() }); };
        let digests = 0;
        let small: Reconciler;
        const stopping = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
          const out = await r.rpc<T>(method, args);
          if (method === 'relationDigest' && ++digests === 3) small.stop();
          return out;
        };
        small = new Reconciler({ dir: r.dir, reads: base, rpc: stopping, follower: r.follower, intervalRows: 2, basis, onBasis } as never);
        const stopped = await small.run('full', undefined, { resume: true });
        expect(stopped.error).toBe('stopped');
        const file = join(r.dir, 'reconcile', 'progress.json');
        const progress = JSON.parse(readFileSync(file, 'utf8')) as { id: string; pass_start: number; db_at?: string | null };
        expect(progress.db_at).toBe('basis-1');
        expect(askedAt).toHaveLength(1);
        expect(askedAt[0]!).toBeLessThanOrEqual(progress.pass_start); // read before the pass started
        expect(handed).toEqual([]); // a stopped pass restores nothing and hands nothing over
        expect((small as unknown as { inProgressBasis?: () => string | null }).inProgressBasis?.()).toBe('basis-1'); // what a close seals with
        if (variant === 'resumed from a point an older build wrote') {
          const { db_at: _dropped, ...older } = progress;
          writeFileSync(file, JSON.stringify(older));
        }
        const watching = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
          const out = await r.rpc<T>(method, args);
          if (method === 'watermark') restoredAt = Date.now();
          return out;
        };
        const next = new Reconciler({ dir: r.dir, reads: base, rpc: watching, follower: r.follower, intervalRows: 2, basis, onBasis } as never);
        const resumed = await next.run('full', undefined, { resume: true });
        expect(resumed.error).toBeUndefined();
        expect(resumed.id).toBe(stopped.id);
        expect(restoredAt).toBeGreaterThan(0);
        if (variant === 'resumed with its basis') {
          // The basis of the pass it continued, not a new reading: the state is proven from that pass's start.
          expect(handed.map((h) => h.token)).toEqual(['basis-1']);
          expect(handed[0]!.at).toBeGreaterThanOrEqual(restoredAt);
        } else {
          expect(handed).toEqual([]); // no basis on record: this session cannot seal
        }
        expect((next as unknown as { inProgressBasis?: () => string | null }).inProgressBasis?.()).toBeNull(); // finished: nothing in progress
        // A fresh pass reads a new basis and hands it over after its own restore.
        const fresh = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: 2, basis, onBasis } as never).run('full');
        expect(fresh.error).toBeUndefined();
        expect(handed.at(-1)?.token).toBe(`basis-${asked}`);
        expect(asked).toBeGreaterThanOrEqual(2);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    // A full pass that repaired a row in the last interval of a relation (no interval checkpoint follows it) and is
    // stopped right after the store took the repair, before the reconciler reads again. The store now holds the repaired
    // row, so any later scan finds nothing: the repair must be on record at once, outside the resume point.
    const stopAfterTailRepair = async (r: FollowRig, base: ReturnType<typeof openReadSource>) => {
      const [{ n }] = await ctx.primary().executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages`);
      const size = Number(n) + 1; // one interval larger than the page count: all of pages is one short last interval
      await ctx.primary().executeRaw(`UPDATE pages SET title = 'Changed In The Last Interval' WHERE id = (SELECT max(id) FROM pages)`);
      let small: Reconciler;
      let cutAt: number | null = null;
      const stopping = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
        const out = await r.rpc<T>(method, args);
        if (method === 'replaceInterval' && args?.relation === 'pages' && args?.hi === null && cutAt === null) { cutAt = Date.now(); small.stop(); }
        return out;
      };
      small = new Reconciler({ dir: r.dir, reads: base, rpc: stopping, follower: r.follower, intervalRows: size });
      const stopped = await small.run('full', undefined, { resume: true });
      expect(cutAt).not.toBeNull();
      expect(stopped.error).toBe('stopped');
      expect(stopped.repaired_by_relation).toEqual({ pages: 1 });
      return { stopped, size };
    };
    // The repair is on record: the clean streak ends, criterion 1 has no clean pass, and writer coverage counts the
    // path the plan as written did not account for.
    const expectRepairOnRecord = (r: FollowRig, stoppedId: string, since: Date, unknownBefore: number) => {
      const rows = readPasses(r.dir).filter((p) => p.id === stoppedId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.repaired_rows).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.error).toBe('stopped');
      expect(planAsWrittenSource(r.dir).unknownPaths(since)).toBe(unknownBefore + 1);
    };

    test('a process stopped right after the last interval of a relation repaired a row puts that repair on record at once, and a fresh full pass afterwards does not erase it', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        expect(status(r).reconcile.consecutive_clean_full_passes).toBeGreaterThanOrEqual(1);
        const since = new Date(Date.now() - 1_000);
        const unknownBefore = planAsWrittenSource(r.dir).unknownPaths(since);
        const { stopped, size } = await stopAfterTailRepair(r, base);
        // Right after the stop, before any other pass runs.
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(0);
        expect(status(r).reconcile.last_clean_full_pass_at).toBeNull();
        expectRepairOnRecord(r, stopped.id, since, unknownBefore);
        // A stopped full pass did not finish, so a full pass is due at the next check whatever its age, and the status
        // says so: due since the stop, not a day later.
        expect(fullPassDue(readPasses(r.dir).filter((p) => p.kind === 'full').at(-1))).toBe(true);
        expect(status(r).reconcile.next_full_pass_due).toBe(stopped.finished_at);
        // A fresh full pass (what `engine shadow reconcile` and the nightly tick run) reads the healed rows clean. It is
        // a new pass, it counts as one clean pass, and the stopped pass's repair stays on record.
        const fresh = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full');
        expect(fresh.error).toBeUndefined();
        expect(fresh.id).not.toBe(stopped.id);
        expect(fresh.repaired_rows).toBe(0);
        expectRepairOnRecord(r, stopped.id, since, unknownBefore);
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(1);
        expect(status(r).reconcile.last_clean_full_pass_at).toBe(fresh.finished_at);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('a repair put on record by a stopped pass survives the next owner drawing another continuity', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        const since = new Date(Date.now() - 1_000);
        const unknownBefore = planAsWrittenSource(r.dir).unknownPaths(since);
        const { stopped, size } = await stopAfterTailRepair(r, base);
        // The next owner took no seal, so its child answers under another continuity: no resume point is admitted.
        const otherOwner = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
          const out = await r.rpc<T>(method, args);
          return (method === 'state' ? { ...(out as Record<string, unknown>), continuity: 'another-owner-continuity' } : out) as T;
        };
        const next = await new Reconciler({ dir: r.dir, reads: base, rpc: otherOwner, follower: r.follower, intervalRows: size }).run('full', undefined, { resume: true });
        expect(next.error).toBeUndefined();
        expect(next.id).not.toBe(stopped.id);
        expectRepairOnRecord(r, stopped.id, since, unknownBefore);
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(1);
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    // The stopped pass's record could not be appended once (the pass log was briefly not writable), so its repair is held
    // only in the resume point. Append access is back before anything else runs. The repair is not lost: until it is
    // published, status and writer coverage count it, and a fresh pass or another owner's continuity publishes it before
    // dropping that resume point.
    for (const recovery of ['a fresh full pass', 'the next owner under another continuity'] as const) {
      test(`a repair whose stopped record could not be appended is counted at once and put on record by ${recovery}, never dropped with the resume point`, async () => {
        const r = await rig();
        const base = openReadSource(ctx.primary(), { pauseMs: 0 });
        try {
          expect(status(r).reconcile.consecutive_clean_full_passes).toBeGreaterThanOrEqual(1);
          const since = new Date(Date.now() - 1_000);
          const unknownBefore = planAsWrittenSource(r.dir).unknownPaths(since);
          const original = followStatus.appendPass;
          let failed = false;
          const failing = spyOn(followStatus, 'appendPass').mockImplementation((d, p) => {
            if (p.error === 'stopped' && !failed) { failed = true; throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); }
            return original(d, p);
          });
          let out: Awaited<ReturnType<typeof stopAfterTailRepair>>;
          try { out = await stopAfterTailRepair(r, base); } finally { failing.mockRestore(); }
          const { stopped, size } = out;
          // The injection fired: no record, and the repair is in the resume point.
          expect(failed).toBe(true);
          expect(readPasses(r.dir).filter((p) => p.id === stopped.id)).toHaveLength(0);
          const progress = JSON.parse(readFileSync(join(r.dir, 'reconcile', 'progress.json'), 'utf8')) as { id: string; repaired_rows: number };
          expect(progress.id).toBe(stopped.id);
          expect(progress.repaired_rows).toBeGreaterThanOrEqual(1);
          // Right away, before any other pass runs: the repair already ends the clean streak and counts for writer coverage.
          expect(status(r).reconcile.consecutive_clean_full_passes).toBe(0);
          expect(status(r).reconcile.last_clean_full_pass_at).toBeNull();
          expect(planAsWrittenSource(r.dir).unknownPaths(since)).toBe(unknownBefore + 1);
          const otherOwner = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
            const out = await r.rpc<T>(method, args);
            return (method === 'state' ? { ...(out as Record<string, unknown>), continuity: 'another-owner-continuity' } : out) as T;
          };
          const next = recovery === 'a fresh full pass'
            ? await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full')
            : await new Reconciler({ dir: r.dir, reads: base, rpc: otherOwner, follower: r.follower, intervalRows: size }).run('full', undefined, { resume: true });
          expect(next.error).toBeUndefined();
          expect(next.id).not.toBe(stopped.id);
          expect(next.repaired_rows).toBe(0);
          expectRepairOnRecord(r, stopped.id, since, unknownBefore);
          expect(status(r).reconcile.consecutive_clean_full_passes).toBe(1);
          expect(status(r).reconcile.last_clean_full_pass_at).toBe(next.finished_at);
        } finally { await base.close(); await r.close(); }
      }, 90_000);
    }

    // F5. The stopped pass's record could not be appended once, so its repair is held only in the resume point. The next
    // full pass then fails in its setup, before it took that resume point over (its state or seed plan request, or its
    // first read of the primary). A pass that never took the resume point over must not remove it: it is the repair's
    // only record. A later pass that does take it over puts it on record exactly once.
    for (const point of ['state request', 'seed plan request', 'first primary read'] as const) {
      test(`a full pass that fails in its setup (${point}) keeps a stopped repair's only record, and a later pass puts it on record once`, async () => {
        const r = await rig();
        const base = openReadSource(ctx.primary(), { pauseMs: 0 });
        try {
          const since = new Date(Date.now() - 1_000);
          const unknownBefore = planAsWrittenSource(r.dir).unknownPaths(since);
          const original = followStatus.appendPass;
          let failed = false;
          const failing = spyOn(followStatus, 'appendPass').mockImplementation((d, p) => {
            if (p.error === 'stopped' && !failed) { failed = true; throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); }
            return original(d, p);
          });
          let out: Awaited<ReturnType<typeof stopAfterTailRepair>>;
          try { out = await stopAfterTailRepair(r, base); } finally { failing.mockRestore(); }
          const { stopped, size } = out;
          expect(failed).toBe(true);
          const held = (): { id: string; repaired_rows: number } | null => {
            try { return JSON.parse(readFileSync(join(r.dir, 'reconcile', 'progress.json'), 'utf8')) as { id: string; repaired_rows: number }; } catch { return null; }
          };
          expect(held()?.id).toBe(stopped.id);
          // The next pass fails before it took the resume point over.
          let thrown = false;
          const boom = () => { thrown = true; return Object.assign(new Error('setup failed'), { code: 'test_setup_failed' }); };
          const rpc = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
            if (!thrown && ((point === 'state request' && method === 'state') || (point === 'seed plan request' && method === 'seedPlan'))) throw boom();
            return r.rpc<T>(method, args);
          };
          const reads = point === 'first primary read'
            ? { pauseMs: 0, read: <T>(fn: Parameters<typeof base.read<T>>[0]): Promise<T> => (thrown ? base.read(fn) : Promise.reject(boom())), close: async () => undefined }
            : base;
          const failedPass = await new Reconciler({ dir: r.dir, reads, rpc, follower: r.follower, intervalRows: size }).run('full', undefined, { resume: true });
          expect(thrown).toBe(true);
          expect(failedPass.error).toContain('test_setup_failed');
          // The repair is still held, and still counted, though the failed pass is on record with no repair.
          const kept = held();
          expect(kept?.id).toBe(stopped.id);
          expect(kept?.repaired_rows).toBeGreaterThanOrEqual(1);
          expect(status(r).reconcile.consecutive_clean_full_passes).toBe(0);
          expect(planAsWrittenSource(r.dir).unknownPaths(since)).toBe(unknownBefore + 1);
          // A later pass takes it over and puts it on record exactly once.
          const next = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full');
          expect(next.error).toBeUndefined();
          expectRepairOnRecord(r, stopped.id, since, unknownBefore);
        } finally { await base.close(); await r.close(); }
      }, 90_000);
    }

    // F5. A pass whose own record cannot be appended at its end (a full disk for a moment) holds repairs: its own, or a
    // stopped pass's it took over and continued. Its resume point is the only other place those counts are, so it is
    // never removed before the record landed; the counts stay there and are counted until a later pass records them.
    for (const holder of ['a fresh pass that repaired rows itself', 'a resumed pass that took over a stopped repair'] as const) {
      test(`${holder} whose own record cannot be appended keeps the repair counts in the resume point until a later pass records them once`, async () => {
        const r = await rig();
        const base = openReadSource(ctx.primary(), { pauseMs: 0 });
        try {
          const since = new Date(Date.now() - 1_000);
          const unknownBefore = planAsWrittenSource(r.dir).unknownPaths(since);
          const original = followStatus.appendPass;
          let size: number;
          let held: string;
          let failing: ReturnType<typeof spyOn>;
          if (holder === 'a fresh pass that repaired rows itself') {
            const [{ n }] = await ctx.primary().executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages`);
            size = Number(n) + 1;
            await ctx.primary().executeRaw(`UPDATE pages SET title = 'Changed Before A Fresh Pass' WHERE id = (SELECT max(id) FROM pages)`);
            let failed = false;
            failing = spyOn(followStatus, 'appendPass').mockImplementation((d, p) => {
              if (!failed && (p.repaired_rows ?? 0) > 0) { failed = true; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }
              return original(d, p);
            });
            let pass: Awaited<ReturnType<Reconciler['run']>>;
            try { pass = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full'); } finally { failing.mockRestore(); }
            expect(failed).toBe(true);
            expect(pass.repaired_rows).toBeGreaterThanOrEqual(1);
            held = pass.id;
          } else {
            let failedStop = false;
            failing = spyOn(followStatus, 'appendPass').mockImplementation((d, p) => {
              if (p.error === 'stopped' && !failedStop) { failedStop = true; throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); }
              return original(d, p);
            });
            let out: Awaited<ReturnType<typeof stopAfterTailRepair>>;
            try { out = await stopAfterTailRepair(r, base); } finally { failing.mockRestore(); }
            expect(failedStop).toBe(true);
            size = out.size;
            held = out.stopped.id;
            let failedEnd = false;
            failing = spyOn(followStatus, 'appendPass').mockImplementation((d, p) => {
              if (!failedEnd && p.id === held) { failedEnd = true; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }
              return original(d, p);
            });
            let resumed: Awaited<ReturnType<Reconciler['run']>>;
            try { resumed = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full', undefined, { resume: true }); } finally { failing.mockRestore(); }
            expect(failedEnd).toBe(true);
            expect(resumed.id).toBe(held);
            expect(resumed.repaired_rows).toBeGreaterThanOrEqual(1);
          }
          expect(readPasses(r.dir).filter((p) => p.id === held)).toHaveLength(0);
          const progress = JSON.parse(readFileSync(join(r.dir, 'reconcile', 'progress.json'), 'utf8')) as { id: string; repaired_rows: number };
          expect(progress.id).toBe(held);
          expect(progress.repaired_rows).toBeGreaterThanOrEqual(1);
          expect(status(r).reconcile.consecutive_clean_full_passes).toBe(0);
          expect(planAsWrittenSource(r.dir).unknownPaths(since)).toBe(unknownBefore + 1);
          const next = await new Reconciler({ dir: r.dir, reads: base, rpc: r.rpc, follower: r.follower, intervalRows: size }).run('full');
          expect(next.error).toBeUndefined();
          const rows = readPasses(r.dir).filter((p) => p.id === held);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.repaired_rows).toBeGreaterThanOrEqual(1);
          expect(planAsWrittenSource(r.dir).unknownPaths(since)).toBe(unknownBefore + 1);
          expect(existsSync(join(r.dir, 'reconcile', 'progress.json'))).toBe(false);
        } finally { await base.close(); await r.close(); }
      }, 90_000);
    }

    // The next owner took the seal over and its serving process sent ok:true, which the child applied, but the answer
    // was lost, and neither the veto line nor any revoke reached the child (seal.ts returns the doubt). The child still
    // says valid, under the sealed continuity, so a resume point written under that continuity would be admitted. A
    // foreign write then changes a row in a relation that resume point already walked. The first check must not resume
    // it: it withdraws the confirmation and scans fresh, so the changed row is found.
    test('after a seal confirmation left in doubt, the first check scans fresh: the resume point under the sealed continuity is not reused, and a row changed in a relation it already walked is repaired', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      try {
        // A clean pass stopped once pages was walked: its resume point holds pages as done.
        let sawPages = false;
        let small: Reconciler;
        const stopping = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
          const out = await r.rpc<T>(method, args);
          if (method === 'relationDigest') { if (args?.relation === 'pages') sawPages = true; else if (sawPages) small.stop(); }
          return out;
        };
        small = new Reconciler({ dir: r.dir, reads: base, rpc: stopping, follower: r.follower, intervalRows: 2 });
        const stopped = await small.run('full', undefined, { resume: true });
        expect(stopped.error).toBe('stopped');
        expect(stopped.repaired_rows).toBe(0);
        const progress = JSON.parse(readFileSync(join(r.dir, 'reconcile', 'progress.json'), 'utf8')) as { id: string; done: string[]; continuity: string };
        expect(progress.id).toBe(stopped.id);
        expect(progress.done).toContain('pages');
        // The owner closes with a seal, and the next owner's child takes it over.
        writeShadowState(r.dir, { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'state-start-1', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind } as ShadowState);
        await r.settle();
        r.child.handle({ t: 'seal', db_at: 'mark-1' });
        await r.child.close();
        expect(readFollowerFile(r.dir)?.seal?.continuity).toBe(progress.continuity);
        const waiters = new Map<number, (m: { ok: boolean; value?: unknown; error?: { code: string; message: string } }) => void>();
        const next = new FollowChild({ dir: r.dir, store: async () => r.store, owner: () => true, writeControl: (line) => { const m = JSON.parse(line); waiters.get(m.id)?.(m); } });
        let id = 0;
        const nextRpc = <T,>(method: string, args: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => {
          const n = ++id;
          waiters.set(n, (m) => { waiters.delete(n); if (m.ok) resolve(m.value as T); else reject(Object.assign(new Error(m.error?.message), { code: m.error?.code })); });
          next.handle({ t: 'rpc', id: n, method, args });
        });
        expect(await nextRpc('state')).toMatchObject({ valid: false, pending_seal: { db_at: 'mark-1' } });
        // Both phases applied in the child (the confirmation is held invalid until the commit); the commit's answer is what was lost.
        expect(await nextRpc('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: false, invalidated_reason: 'seal_confirm_pending', confirmed: true });
        expect(await nextRpc('state')).toMatchObject({ valid: false, continuity: null });
        expect(await nextRpc('commitSeal', { db_at: 'mark-1' })).toMatchObject({ valid: true, confirmed: true });
        expect(await nextRpc('state')).toMatchObject({ valid: true, continuity: progress.continuity });
        await ctx.primary().executeRaw(`UPDATE pages SET title = 'Changed While The Confirmation Was In Doubt' WHERE id = (SELECT min(id) FROM pages)`);
        const before = readPasses(r.dir).length;
        const checked = new Reconciler({ dir: r.dir, reads: base, rpc: nextRpc, intervalRows: 2, ready: async () => ({ doubt: 'seal_commit_unacknowledged' }) });
        // The real first check (startNightly runs it FIRST_CHECK_MS after the start) with the real pass.
        await (checked as unknown as { firstRun(): Promise<void> }).firstRun();
        const added = readPasses(r.dir).slice(before);
        expect(added).toHaveLength(1);
        expect(added[0]!.id).not.toBe(stopped.id);
        expect(added[0]!.started_at).not.toBe(stopped.started_at);
        expect(added[0]!.error).toBeUndefined();
        expect(added[0]!.repaired_by_relation.pages ?? 0).toBeGreaterThanOrEqual(1);
        // No clean result came from the old resume point, and the child is valid again only through the fresh pass.
        expect(readPasses(r.dir).some((p) => p.id === stopped.id)).toBe(false);
        expect(existsSync(join(r.dir, 'reconcile', 'progress.json'))).toBe(false);
        expect(await nextRpc('state')).toMatchObject({ valid: true });
        await next.close();
      } finally { await base.close(); await r.close(); }
    }, 90_000);

    test('a finished pass whose resume point could not be removed is never resumed again: one record per pass, and no clean pass without its own scan', async () => {
      const r = await rig();
      const base = openReadSource(ctx.primary(), { pauseMs: 0 });
      const reconcileDir = join(r.dir, 'reconcile');
      const file = join(reconcileDir, 'progress.json');
      const counting = () => {
        const c = { digests: 0, rpc: <T>(method: string, args?: Record<string, unknown>): Promise<T> => { if (method === 'relationDigest') c.digests++; return r.rpc<T>(method, args); } };
        return c;
      };
      try {
        // How many interval digests one whole scan reads.
        const whole = counting();
        expect((await new Reconciler({ dir: r.dir, reads: base, rpc: whole.rpc, follower: r.follower, intervalRows: 2 }).run('full')).error).toBeUndefined();
        expect(whole.digests).toBeGreaterThan(3);
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
        expect(existsSync(file)).toBe(true);
        const cleanBefore = status(r).reconcile.consecutive_clean_full_passes;
        // The pass log stays writable; the directory does not, so removing the finished pass's resume point fails.
        chmodSync(reconcileDir, 0o500);
        const runs: { id: string; digests: number }[] = [];
        try {
          for (let i = 0; i < 3; i++) {
            const c = counting();
            const pass = await new Reconciler({ dir: r.dir, reads: base, rpc: c.rpc, follower: r.follower, intervalRows: 2 }).run('full', undefined, { resume: true });
            expect(pass.error).toBeUndefined();
            expect(existsSync(file)).toBe(true); // the injected failure fired: the resume point is still there
            runs.push({ id: pass.id, digests: c.digests });
          }
        } finally { chmodSync(reconcileDir, 0o700); }
        // The first run continues the stopped pass; it then is finished, so each later run is a new pass that scans everything.
        expect(runs[0]!.id).toBe(stopped.id);
        expect(runs[0]!.digests).toBeLessThan(whole.digests);
        for (const run of runs.slice(1)) {
          expect(run.id).not.toBe(stopped.id);
          expect(run.digests).toBe(whole.digests);
        }
        const ids = readPasses(r.dir).map((p) => p.id);
        expect(ids.length).toBe(new Set(ids).size);
        expect(ids.filter((id) => id === stopped.id)).toHaveLength(1);
        // Three clean passes, each from its own scan (the first finished the stopped one's remaining intervals).
        expect(status(r).reconcile.consecutive_clean_full_passes).toBe(cleanBefore + 3);
      } finally { await base.close(); await r.close(); }
    }, 120_000);

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
