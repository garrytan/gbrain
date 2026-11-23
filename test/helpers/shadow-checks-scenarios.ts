/**
 * Scenarios shared by test/shadow-privacy.test.ts (PGLite) and test/e2e/shadow-checks.test.ts (Postgres): the per-item
 * privacy check, the stable rerun outcomes and the exact vector reference, each from a real primary (real readers, folder
 * rules, lineage, follower and embeddings) joined by the real supervisor to a shadow child whose Rust engine is a fake.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { currentCallerAccess, withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import { makeAskHandler } from '../../src/shadow/checks.ts';
import { openReadSource } from '../../src/shadow/read-pool.ts';
import { encodeValue } from '../../src/shadow/codec.ts';
import { readEpoch } from '../../src/shadow/evidence-epoch.ts';
import { readEpochRecall, RECALL_REFERENCE_LIMIT, type RankedKey } from '../../src/shadow/recall.ts';
import { batch, sample, sleep, startRig, until, type Rig, type RigOptions } from './shadow-stable-harness.ts';
import { installFixtureChunks } from './page-projection.ts';

export const ALICE = { identity: ['member:alice-example'], hidePrivate: true, restricted: true, applyRemoteReadPolicy: true };
export const BOB = { ...ALICE, identity: ['member:bob-example'], satisfiedRuleIds: ['default:r1'] }; // the folder rule's reader
const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';

/** Pages with readers, a folder rule and lineage, once per primary; returns each page's id by slug. */
export async function privacyFixture(engine: BrainEngine): Promise<Record<string, number>> {
  const ids = async (): Promise<Record<string, number>> => Object.fromEntries((await engine.executeRaw<{ id: number; slug: string }>('SELECT id, slug FROM pages')).map((r) => [r.slug, Number(r.id)]));
  if ((await ids())['open/a']) return ids();
  const put = (slug: string, frontmatter: Record<string, unknown> = {}) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `shared widget notes ${slug}`, timeline: '', frontmatter });
  await put('open/a');
  await put('priv/a', { visibility: 'private' });
  await put('mem/a', { readable_by: ['member:bob-example'] });
  await put('secrets/plan', { visibility: 'private' });
  await put('summary/x', { derived_from: ['secrets/plan'] }); // restricted by lineage: its input is private
  await engine.executeRaw(`INSERT INTO access_policy_state(source_id) VALUES('default')`);
  await engine.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','r1','partners/',ARRAY['member:bob-example'],1)`);
  await put('partners/x');
  return ids();
}

export const vec = (seed: number): Float32Array => {
  const f = new Float32Array(DIMS);
  let h = createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < DIMS; i++) { if (i % 32 === 0) h = createHash('sha256').update(h).digest(); f[i] = (h[i % 32]! - 128) / 128; }
  return f;
};

/** Twelve pages, one chunk each, with distinct embeddings; once per primary. Returns the chunk ids by seed. */
export async function vectorFixture(engine: BrainEngine): Promise<Map<number, number>> {
  const chunks = async () => new Map((await engine.executeRaw<{ id: number; chunk_text: string }>(`SELECT c.id, c.chunk_text FROM content_chunks c WHERE c.chunk_text LIKE 'vec note %'`)).map((r) => [Number(r.chunk_text.slice(9)), Number(r.id)]));
  if ((await chunks()).size === 12) return chunks();
  for (let i = 0; i < 12; i++) {
    await engine.putPage(`vec/n${i}`, { type: 'note', title: `V${i}`, compiled_truth: `vec note ${i}`, timeline: '' });
    await installFixtureChunks(engine, `vec/n${i}`, [{ chunk_index: 0, chunk_text: `vec note ${i}`, chunk_source: 'compiled_truth', embedding: vec(i), model: MODEL, token_count: 3 }]);
  }
  return chunks();
}

export function defineCheckScenarios(ctx: { primary: () => BrainEngine; dialect: 'pglite' | 'postgres' }): void {
  const rigs: Rig[] = [];
  afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });
  const start = async (o: Partial<RigOptions> = {}): Promise<Rig> => { const rig = await startRig({ primary: ctx.primary(), ...o }); rigs.push(rig); return rig; };

  /** A seeded rig whose first Rust answer (the sample) differs from the primary's and whose later answers follow `later`. */
  async function mismatching(later: 'agrees' | 'differs', o: Partial<RigOptions> = {}): Promise<Rig> {
    await privacyFixture(ctx.primary()); // the primary has pages, so Rust's empty first answer is a mismatch
    const rig = await start(o);
    let calls = 0;
    rig.rust.listPages = async () => (++calls === 1 || later === 'differs' ? [] : ctx.primary().listPages({ limit: 100 }));
    return rig;
  }
  const rows = (rig: Rig, n = 1) => rig.finish(n);

  /** Reads `listPages` as `caller` on the primary (it excludes what the caller may not read), while Rust answers `rustSlugs`. */
  async function leak(caller: Record<string, unknown>, rustSlugs: string[], opts: Record<string, unknown> = { excludePrivate: true }, primary?: BrainEngine) {
    const ids = await privacyFixture(ctx.primary());
    const rig = await start({ primary: primary ?? ctx.primary(), unseeded: true });
    rig.rust.listPages = async () => rustSlugs.map((slug) => ({ id: ids[slug], slug, source_id: 'default', title: slug, type: 'note' }));
    await withCallerAccess(caller, () => rig.engine.listPages({ limit: 100, ...opts } as never));
    return { rig, rows: await rig.finish() };
  }

  describe('the per-item privacy check', () => {
    for (const [name, slug] of [['a same-source private page', 'priv/a'], ['a member-restricted page', 'mem/a'], ['a folder-restricted page', 'partners/x'], ['a page derived from private content', 'summary/x']] as const) {
      test(`${name} that Rust shows and the primary did not is privacy_diverged and pauses mirroring`, async () => {
        const seen = await withCallerAccess(ALICE, () => ctx.primary().listPages({ limit: 100, excludePrivate: true }));
        expect(seen.map((r) => r.slug)).not.toContain(slug); // the primary hid it from this caller
        const { rig, rows } = await leak(ALICE, [...seen.map((r) => r.slug), slug]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ op: 'listPages', outcome: 'privacy_diverged', reason: 'row_not_readable_by_caller' });
        expect(rig.stoppedBy).toBe('privacy_diverged');
        expect(JSON.stringify(rows)).not.toContain(slug); // ids and policy never reach the ledger
      });
    }
  
    test('an authorized page outside the primary\'s top k does not pause mirroring', async () => {
      await privacyFixture(ctx.primary());
      const top = await withCallerAccess(BOB, () => ctx.primary().listPages({ excludePrivate: true, limit: 1 }));
      expect(top).toHaveLength(1);
      const { rig, rows } = await leak(BOB, [top[0]!.slug, 'mem/a', 'partners/x'], { excludePrivate: true, limit: 1 });
      expect(rows[0]!.outcome).not.toBe('privacy_diverged'); // bob reads both: a different answer, not a leak
      expect(rig.stoppedBy).toBeNull();
    });
  
    test('a policy that moves during the check is inconclusive, never clean and never a pause', async () => {
      const primary = ctx.primary();
      const rig = await start({ unseeded: true });
      const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
      const real = supervisor.o.onAsk;
      supervisor.o.onAsk = async (ask) => { // the page is edited between the primary read and the check
        if (ask.kind === 'privacy') await primary.executeRaw(`UPDATE pages SET updated_at = now() + interval '1 minute' WHERE slug = 'priv/a'`);
        return real(ask);
      };
      const ids = await privacyFixture(primary);
      rig.rust.listPages = async () => [{ id: ids['priv/a'], slug: 'priv/a', source_id: 'default', title: 'x', type: 'note' }];
      await withCallerAccess(ALICE, () => rig.engine.listPages({ limit: 100, excludePrivate: true }));
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved', rerun: 'skipped:no_epoch' });
      expect(rig.stoppedBy).toBeNull();
    });
  
    test('a read that did not ask for the read policy is not judged', async () => {
      const { rig, rows } = await leak(ALICE, ['priv/a'], {});
      expect(rows[0]!.outcome).not.toBe('privacy_diverged');
      expect(rig.stoppedBy).toBeNull();
    });
  
    test('a check that cannot be answered leaves the sample inconclusive', async () => {
      const rig = await start({ unseeded: true, child: { timeoutMs: 1000 } });
      (rig.attached.supervisor as unknown as { o: { onAsk: unknown } }).o.onAsk = async () => { throw Object.assign(new Error('x'), { code: 'broken' }); };
      const ids = await privacyFixture(ctx.primary());
      rig.rust.listPages = async () => [{ id: ids['priv/a'], slug: 'priv/a', source_id: 'default', title: 'x', type: 'note' }];
      await withCallerAccess(ALICE, () => rig.engine.listPages({ limit: 100, excludePrivate: true }));
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_unavailable' });
    });
  });

  describe('caller access capture', () => {
    test('the wrapper captures the frozen record, the child runs Rust under it, and a read outside any record carries the default one', async () => {
      const rig = await start({ unseeded: true });
      const seen: Array<readonly string[]> = [];
      rig.rust.getPage = async () => { seen.push(currentCallerAccess().identity); return null; };
      await withCallerAccess(ALICE, () => rig.engine.getPage('missing/one'));
      await rig.engine.getPage('missing/two');
      await rig.finish(2);
      expect(seen).toEqual([['member:alice-example'], []]);
    });
  });

  describe('stable rerun outcomes', () => {
    test('a rerun that still differs is diff, with the original mismatch kept', async () => {
      const rig = await mismatching('differs');
      await rig.settled();
      await sample(rig);
      expect((await rows(rig))[0]).toMatchObject({ op: 'listPages', outcome: 'diff', reason: 'rerun_differs', mismatch: 'diff', rerun: 'differed' });
    });
  
    test('a rerun that matches closes the sample as unsuccessful: inconclusive, never match', async () => {
      const rig = await mismatching('agrees');
      await rig.settled();
      await sample(rig);
      expect((await rows(rig))[0]).toMatchObject({ outcome: 'inconclusive', mismatch: 'diff', rerun: 'matched' });
    });
  
    test('an invalid watermark, a relation-only invalidation and a failed apply followed by a higher sequence each leave it inconclusive', async () => {
      const never = await mismatching('agrees'); // never settled: the new session's watermark is invalid
      await sample(never);
      expect((await rows(never))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:watermark_invalid' });
  
      const relation = await mismatching('agrees');
      await relation.settled();
      relation.attached.supervisor.send(JSON.stringify({ t: 'watermark', valid: false, reason: 'relation_dirty', relation: 'config' }) + '\n');
      await sample(relation);
      expect((await rows(relation))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:watermark_invalid' });
  
      let first = true;
      const failed = await mismatching('agrees', { store: { replaceRelationRows: async (_i, relation, _g, k) => { failed.applied.push({ relation: String(relation), keys: (k as unknown[]).length }); if (first) { first = false; throw new Error('boom'); } return { upserted: 1, deleted: 0, skipped_older: 0, displaced: 0, dropped: 0, unmapped_columns: [], losses: {} }; } } });
      await failed.settled();
      failed.attached.follower!.publish(batch(1, [{ kind: 'rows', relation: 'config', selector: { key: 'a' }, before_keys: [['a']] }]));
      await failed.attached.follower!.settle();
      failed.attached.follower!.publish(batch(2, [{ kind: 'rows', relation: 'config', selector: { key: 'b' }, before_keys: [['b']] }]));
      await failed.attached.follower!.settle();
      await sample(failed);
      expect(failed.applied).toHaveLength(2); // both batches reached the store: the first threw, the second applied
      expect((await rows(failed))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:watermark_invalid' });
    });
  
    test('a write published after the primary read leaves it inconclusive', async () => {
      const rig = await mismatching('agrees');
      await rig.settled();
      // The rerun's own primary read goes through the unwrapped engine: publish while it runs by delaying it.
      const original = ctx.primary().listPages.bind(ctx.primary());
      let reruns = 0;
      (ctx.primary() as unknown as { listPages: unknown }).listPages = async (...a: never[]) => { const out = await (original as (...x: unknown[]) => unknown)(...a); if (++reruns === 2) rig.attached.follower!.publish(batch(1, [{ kind: 'rows', relation: 'config', selector: { key: 'late' }, before_keys: null }])); return out; };
      try {
        await sample(rig);
        expect((await rows(rig))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:write_after_barrier' });
      } finally { (ctx.primary() as unknown as { listPages: unknown }).listPages = original; }
    });
  
    test('an answer for another epoch is dropped, never restamped', async () => {
      const rig = await mismatching('agrees');
      await rig.settled();
      const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<Record<string, unknown>> } };
      const real = supervisor.o.onAsk;
      supervisor.o.onAsk = async (ask) => { const out = await real(ask); return ask.kind === 'rerun' ? { ...out, epoch_id: 'another-epoch' } : out; };
      await sample(rig);
      expect((await rows(rig))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:epoch_changed' });
    });
  
    test('a full queue leaves the overflow inconclusive and a closing child leaves the rest so; nothing reads as clean', async () => {
      const rig = await mismatching('differs');
      await rig.settled();
      const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
      supervisor.o.onAsk = () => new Promise(() => {}); // the serving process never answers
      for (let i = 0; i < 70; i++) { await sample(rig); if (i === 49) await sleep(300); } // the mirror queue holds 64: the second wave arrives after the child drained the first
      await until(() => rig.rows().length >= 6);
      rig.attached.supervisor.stop(); // the child's stdin ends: the running rerun is cut off and the queued ones end as skipped
      await until(() => rig.rows().length >= 70);
      const all = rig.rows();
      const why = (r: string) => all.filter((x) => x.rerun === r).length;
      expect([why('skipped:queue_full'), why('skipped:closing'), why('skipped:child_closing')]).toEqual([6, 1, 63]);
      expect(all.every((r) => r.outcome === 'inconclusive')).toBe(true);
    }, 30_000);
  });

  describe('vector recall', () => {
    const embedded = { embedding: vec(3) };
    test('the reference is the primary\'s own exact top ten with room for ties, and it is rate limited', async () => {
      const primary = ctx.primary();
      const chunkOf = await vectorFixture(primary);
      const real = openReadSource(primary);
      const sql: string[] = []; // the statements the reference run sends through its read transaction
      const reads = { ...real, read: <T>(fn: Parameters<typeof real.read<T>>[0]) => real.read((tx, q) => fn(new Proxy(tx, { get: (t, p) => (p === 'executeRaw' ? (text: string, ...a: never[]) => { sql.push(text); return (t.executeRaw as Function).call(t, text, ...a); } : Reflect.get(t, p, t)) }) as BrainEngine, q)) };
      try {
        const handler = makeAskHandler({ engine: primary, reads, dir: '/none', rpc: (async () => ({})) as never });
        const ask = { id: 1, kind: 'vector', args: encodeValue([embedded.embedding, { limit: 10 }]), access: {} };
        const reference = await handler(ask) as RankedKey[];
        const cosine = (a: Float32Array, b: Float32Array): number => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
        const exact = [...chunkOf.keys()].sort((p, q) => cosine(vec(3), vec(q)) - cosine(vec(3), vec(p))).map((i) => String(chunkOf.get(i)));
        expect(reference).toHaveLength(Math.min(RECALL_REFERENCE_LIMIT, 12)); // asked for more than the caller's ten, so a tie at the cutoff is visible
        expect(new Set(reference.slice(0, 10).map((r) => r.k))).toEqual(new Set(exact.slice(0, 10)));
        expect(sql.slice(0, 2)).toEqual(['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off']); // before any search statement
        await expect(handler(ask)).rejects.toMatchObject({ code: 'rate_limited' });
      } finally { await real.close(); }
    });

    test('with index and bitmap scans off the statements cannot use the HNSW index, and the settings survive a searchVector call in the same transaction', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const nodes = (p: { 'Node Type'?: string; 'Index Name'?: string; Plans?: unknown[] }, out: string[] = []): string[] => { out.push(`${p['Node Type']}:${p['Index Name'] ?? ''}`); for (const c of p.Plans ?? []) nodes(c as never, out); return out; };
      const stmt = buildVectorSearchStatement({ dialect: ctx.dialect, embedding: vec(3), limit: 10, offset: 0, opts: { limit: 10 } as never, scope: undefined as never });
      const plan = (sets: string[], sql: string) => primary.transaction(async (tx) => {
        for (const s of sets) await tx.executeRaw(s);
        const params = [...stmt.params]; params[stmt.innerLimitIdx] = stmt.innerLimit;
        const [row] = await tx.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
        const p = row!['QUERY PLAN']; return nodes((Array.isArray(p) ? p[0] : p).Plan).filter((n) => n.includes('idx_chunks_embedding'));
      }, { readOnly: true });
      expect(stmt.indexWalkSql).toBeDefined();
      expect(await plan(['SET LOCAL enable_seqscan = off'], stmt.indexWalkSql!)).not.toEqual([]); // the control: the walk does use the index
      expect(await plan(['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off'], stmt.indexWalkSql!)).toEqual([]);
      expect(await plan(['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off'], stmt.sql)).toEqual([]);
      const after = await primary.transaction(async (tx) => {
        await tx.executeRaw('SET LOCAL enable_indexscan = off');
        await tx.searchVector(vec(3), { limit: 10 });
        return (await tx.executeRaw<{ v: string }>(`SELECT current_setting('enable_indexscan') AS v`))[0]!.v;
      }, { readOnly: true });
      expect(after).toBe('off');
    });

    test('a sampled vector read is scored against the reference through the real child; a second one within a minute is not', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const full = await primary.searchVector(vec(3), { limit: 12 });
      const rig = await start();
      rig.rust.searchVector = async () => [...full.slice(0, 9), full[10]]; // Rust misses the tenth true neighbour and returns the eleventh
      await rig.engine.searchVector(vec(3), { limit: 10 });
      const epoch = readEpoch(rig.dir)?.epoch_id ?? (await until(() => readEpoch(rig.dir) !== null), readEpoch(rig.dir)!.epoch_id);
      await until(() => (readEpochRecall(rig.dir, epoch)?.length ?? 0) === 1);
      await rig.engine.searchVector(vec(3), { limit: 10 });
      await sleep(300);
      expect(readEpochRecall(rig.dir, epoch)).toMatchObject([{ vector: 0.9, primary: 1, ref_size: 10 }]);
    });
  });
}
