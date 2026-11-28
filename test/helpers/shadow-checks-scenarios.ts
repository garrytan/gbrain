/**
 * Scenarios shared by test/shadow-privacy.test.ts (PGLite) and test/e2e/shadow-checks.test.ts (Postgres): the per-item
 * privacy check, the stable rerun outcomes and the exact vector reference, each from a real primary (real readers, folder
 * rules, lineage, follower and embeddings) joined by the real supervisor to a shadow child whose Rust engine is a fake.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { callerAccessRecord, withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import { RERUN_BACKOFF_TOTAL_MS, type ShadowChildDeps } from '../../src/shadow/child.ts';
import { createLsnWatch, makeAskHandler } from '../../src/shadow/checks.ts';
import { openReadSource } from '../../src/shadow/read-pool.ts';
import { readdirSync, readFile, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SampleRegistry } from '../../src/shadow/samples.ts';
import { encodeValue } from '../../src/shadow/codec.ts';
import { ensureEpoch, readEpoch } from '../../src/shadow/evidence-epoch.ts';
import { appendLedgerRows } from '../../src/shadow/ledger.ts';
import { readEpochRecall, RECALL_REFERENCE_LIMIT, type RankedKey } from '../../src/shadow/recall.ts';
import { evaluateReadiness } from '../../src/core/engine-swap/readiness.ts';
import { buildEvidenceStatus } from '../../src/shadow/evidence.ts';
import { batch, gate, sample, sleep, startRig, until, untilNotMoved, type Rig, type RigOptions } from './shadow-stable-harness.ts';
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
  if ((await chunks()).size === 12) return chunks(); // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
  for (let i = 0; i < 12; i++) { // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
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
  async function leak(caller: Record<string, unknown> | null, rustSlugs: string[], opts: Record<string, unknown> = { excludePrivate: true }, primary?: BrainEngine) {
    const ids = await privacyFixture(ctx.primary());
    const rig = await start({ primary: primary ?? ctx.primary(), unseeded: true });
    rig.rust.listPages = async () => rustSlugs.map((slug) => ({ id: ids[slug], slug, source_id: 'default', title: slug, type: 'note' }));
    const read = () => rig.engine.listPages({ limit: 100, ...opts } as never);
    await (caller ? withCallerAccess(caller, read) : read());
    return { rig, rows: await rig.finish() };
  }
  /** A positive outcome (a violation found, a row cleared) asked again from a new capture when an unrelated commit moved the first (harness `untilNotMoved`). */
  const unmoved = <R extends { rows: Array<Record<string, unknown>> }>(run: () => Promise<R>): Promise<R> => untilNotMoved(run, (r) => r.rows[0]?.reason === 'privacy_check_moved' || r.rows[0]?.rerun === 'skipped:moved');

  describe('the per-item privacy check', () => {
    for (const [name, slug] of [['a same-source private page', 'priv/a'], ['a member-restricted page', 'mem/a'], ['a folder-restricted page', 'partners/x'], ['a page derived from private content', 'summary/x']] as const) {
      test(`${name} that Rust shows and the primary did not is privacy_diverged and pauses mirroring`, async () => {
        const seen = await withCallerAccess(ALICE, () => ctx.primary().listPages({ limit: 100, excludePrivate: true }));
        expect(seen.map((r) => r.slug)).not.toContain(slug); // the primary hid it from this caller
        const { rig, rows } = await unmoved(() => leak(ALICE, [...seen.map((r) => r.slug), slug]));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ op: 'listPages', outcome: 'privacy_diverged', reason: 'row_not_readable_by_caller' });
        expect(rig.stoppedBy).toBe('privacy_diverged');
        expect(JSON.stringify(rows)).not.toContain(slug); // ids and policy never reach the ledger
      });
    }
  
    test('a read with no caller record that asked for the policy is judged under no record, and so is Rust', async () => {
      await privacyFixture(ctx.primary());
      const open = (await ctx.primary().listPages({ limit: 100, excludePrivate: true })).map((r) => r.slug);
      expect(open).not.toContain('priv/a'); // the baseline policy hides it
      const { rows } = await unmoved(() => leak(null, [...open, 'priv/a']));
      expect(rows[0]).toMatchObject({ outcome: 'privacy_diverged', reason: 'row_not_readable_by_caller' });
    });

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
      await primary.executeRaw(`UPDATE pages SET updated_at = now() - interval '1 hour' WHERE slug = 'priv/a'`); // the later tests share this primary
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
    test('the wrapper captures the frozen record, the child runs Rust under it, and a read outside any record runs Rust under none', async () => {
      const rig = await start({ unseeded: true });
      const seen: Array<readonly string[] | string> = [];
      rig.rust.getPage = async () => { seen.push(callerAccessRecord()?.identity ?? 'no record'); return null; };
      await withCallerAccess(ALICE, () => rig.engine.getPage('missing/one'));
      await rig.engine.getPage('missing/two');
      await rig.finish(2);
      expect(seen).toEqual([['member:alice-example'], 'no record']); // a record, even an empty one, changes the page policy text the Rust adapter serves
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
  
    test('a write published after the barrier is rerun from a new position: once it clears the sample, and if it lands on every run the sample stays unresolved', async () => {
      for (const [name, lands, expected] of [
        ['one write', (n: number) => n === 2, { outcome: 'inconclusive', rerun: 'matched' }],
        ['a write on every run', (n: number) => n >= 2, { outcome: 'inconclusive', rerun: 'skipped:moved' }],
      ] as const) {
        const rig = await mismatching('agrees');
        await rig.settled();
        // The rerun's own primary read goes through the unwrapped engine: publish while it runs by delaying it.
        const original = ctx.primary().listPages.bind(ctx.primary());
        let reruns = 0;
        (ctx.primary() as unknown as { listPages: unknown }).listPages = async (...a: never[]) => { const out = await (original as (...x: unknown[]) => unknown)(...a); if (lands(++reruns)) rig.attached.follower!.publish(batch(reruns, [{ kind: 'rows', relation: 'config', selector: { key: `late${reruns}` }, before_keys: null }])); return out; };
        try {
          await sample(rig);
          expect([name, (await rows(rig))[0]]).toEqual([name, expect.objectContaining(expected)]);
        } finally { (ctx.primary() as unknown as { listPages: unknown }).listPages = original; }
      }
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
  
    test('a membership-only ranked read (a take search) whose rerun has the same rows in another order, with other scores, closes as matched; other rows still differ', async () => {
      const primary = ctx.primary();
      const take = (n: number, score: number) => ({ take_id: n, page_id: n, page_slug: `take/p${n}`, row_num: n, claim: `claim ${n}`, kind: 'fact', holder: 'garry', weight: 1, since_date: null, until_date: null, active: true, source_id: 'default', score });
      const original = (primary as unknown as { searchTakes: unknown }).searchTakes;
      (primary as unknown as { searchTakes: unknown }).searchTakes = async () => [take(1, 0.9), take(2, 0.8), take(3, 0.7)]; // the primary's rows, now and on the rerun
      try {
        for (const [name, later, expected] of [
          ['the same rows reversed with other scores', () => [take(3, 0.1), take(2, 0.2), take(1, 0.3)], { outcome: 'inconclusive', rerun: 'matched' }],
          ['a row fewer', () => [take(1, 0.9), take(2, 0.8)], { outcome: 'diff', reason: 'rerun_differs', rerun: 'differed' }],
        ] as const) {
          const rig = await mismatching('agrees');
          let calls = 0;
          rig.rust.searchTakes = async () => (++calls === 1 ? [] : later()); // the first answer lacks every row: a membership mismatch, then the rerun
          await rig.settled();
          await (rig.engine as unknown as { searchTakes: (q: string) => Promise<unknown> }).searchTakes('claim');
          const out = (await rig.finish()).filter((r) => r.op === 'searchTakes');
          expect([name, out[0]]).toEqual([name, expect.objectContaining(expected)]);
        }
      } finally { (primary as unknown as { searchTakes: unknown }).searchTakes = original; }
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

  describe('ranked vector search under excludePrivate', () => {
    type Rows = Array<Record<string, unknown>>;
    /** One ranked searchVector read as ALICE under excludePrivate; Rust answers `answer(primary's rows, a real spare row, page ids)`. Returns criterion 3, the counts and the ledger rows. */
    async function ranked(answer: (theirs: Rows, spare: Record<string, unknown>, ids: Record<string, number>) => Rows, o: { settle?: boolean; onPrivacyAsk?: (n: number) => Promise<void>; child?: Partial<ShadowChildDeps>; noRecall?: boolean; opts?: Record<string, unknown>; onRerunAsk?: (n: number, rig: Rig) => Promise<void> } = {}) {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      await vectorFixture(primary);
      const opts = { limit: 10, excludePrivate: true, ...o.opts };
      const theirs = await withCallerAccess(ALICE, () => primary.searchVector(vec(3), opts)) as unknown as Rows;
      // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
      const spare = (await withCallerAccess(ALICE, () => primary.searchVector(vec(3), { ...opts, limit: 12 })) as unknown as Rows)[10]!; // a real chunk the caller may read, outside the top ten // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
      const rig = await start(o.child ? { child: o.child } : {});
      if (o.noRecall) { // the recall score has its own waits: leave it out, so the waits counted are the rerun's
        const sup = (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o;
        const real = sup.onAsk;
        sup.onAsk = async (ask) => { if (ask.kind === 'vector') throw Object.assign(new Error('off'), { code: 'busy' }); return real(ask); };
      }
      if (o.onPrivacyAsk) { // the primary changes (or not) while the check runs: called with the number of this privacy ask
        const sup = (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o;
        const real = sup.onAsk;
        let asks = 0;
        sup.onAsk = async (ask) => { if (ask.kind === 'privacy') await o.onPrivacyAsk!(++asks); return real(ask); };
      }
      if (o.onRerunAsk) { // the n-th stable rerun the child asks for: the hook may fail it (a thrown allowlisted code) or stop the shadow
        const sup = (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o;
        const real = sup.onAsk;
        let reruns = 0;
        sup.onAsk = async (ask) => { if (ask.kind === 'rerun') await o.onRerunAsk!(++reruns, rig); return real(ask); };
      }
      if (o.settle) await rig.settled(); // a rerun needs the child started and its watermark valid
      rig.rust.searchVector = async () => answer(theirs, spare, ids);
      await withCallerAccess(ALICE, () => rig.engine.searchVector(vec(3), opts));
      const rows = await rig.finish();
      const { evidence, ...ev } = buildEvidenceStatus({ dir: rig.dir });
      const row3 = evaluateReadiness({ epoch_id: evidence?.epoch_id, epoch_started_at: evidence?.epoch_started_at, ...ev } as never, new Date()).criteria.find((c) => c.n === 3)!;
      return { rows, evidence: evidence!, reads: ev.reads!, row3, stopped: rig.stoppedBy, dir: rig.dir };
    }
    const counts = (r: Awaited<ReturnType<typeof ranked>>) => {
      expect(r.rows[0]).toMatchObject({ outcome: 'inconclusive', mismatch: 'diff', private_read: true });
      expect(r.reads.diverged_unexplained_7d).toBe(1); // no completed rerun: unexplained
      expect(r.evidence.ranking_differences).toEqual({});
      expect(r.row3).toMatchObject({ state: 'fail' });
    };

    test('every extra row passed the check: a reported ranking difference, counted per member, and out of diverged_unexplained_7d', async () => {
      const r = await unmoved(() => ranked((theirs, spare) => [...theirs, spare]));
      expect(r.rows[0]).toMatchObject({ op: 'searchVector', outcome: 'diff', reason: 'extra_rows_cleared', private_read: true });
      expect(r.reads.diverged_unexplained_7d).toBe(0);
      expect(r.evidence.ranking_differences).toEqual({ searchVector: 1 });
      expect(r.row3.state).toBe('pass');
    });

    test('one extra row the caller may not read pauses mirroring and makes criterion 3 NOT READY', async () => {
      const r = await unmoved(() => ranked((theirs, _spare, ids) => [...theirs, { ...theirs[0], page_id: ids['priv/a'], slug: 'priv/a', source_id: 'default', chunk_id: 987_654 }]));
      expect(r.rows[0]).toMatchObject({ outcome: 'privacy_diverged' });
      expect(r.stopped).toBe('privacy_diverged');
      expect(r.reads.diverged_unexplained_7d).toBe(1);
      expect(r.row3).toMatchObject({ state: 'fail' });
      expect(r.row3.detail).toContain('1 unexplained diverged');
    });

    test('an extra row the check cannot evaluate (no page identity, or a page the primary does not have) counts', async () => {
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, page_id: undefined, slug: undefined, source_id: undefined }]));
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, page_id: 99_999_999, slug: 'gone/page', source_id: 'default', chunk_id: 987_654 }]));
    });

    test('a substituted chunk on an allowed page never gets the exemption: changed text, or another page\'s chunk', async () => {
      const primary = ctx.primary();
      await primary.putPage('priv/chunked', { type: 'note', title: 'priv/chunked', compiled_truth: 'PRIVATE-CHUNK-CANARY', timeline: '', frontmatter: { visibility: 'private' } });
      await installFixtureChunks(primary, 'priv/chunked', [{ chunk_index: 0, chunk_text: 'PRIVATE-CHUNK-CANARY', chunk_source: 'compiled_truth', embedding: vec(500), model: 'openai:text-embedding-3-large', token_count: 3 }]);
      const [secret] = await primary.executeRaw<{ id: number; chunk_text: string }>(`SELECT c.id, c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'priv/chunked'`);
      // the same page and chunk id as the primary's tenth row, with other text
      counts(await ranked((theirs) => [...theirs.slice(0, 9), { ...theirs[9], chunk_text: 'SUBSTITUTED TEXT' }]));
      // the tenth row's page, with a chunk that belongs to a private page
      counts(await ranked((theirs) => [...theirs.slice(0, 9), { ...theirs[9], chunk_id: Number(secret!.id), chunk_text: secret!.chunk_text }]));
    });

    test('an extra row on a chunk below the safe-chunk fence is never cleared, though its page and chunk are visible to the caller', async () => {
      const primary = ctx.primary();
      await primary.putPage('fence/page', { type: 'note', title: 'fence/page', compiled_truth: 'fenced chunk text', timeline: '' });
      await installFixtureChunks(primary, 'fence/page', [{ chunk_index: 0, chunk_text: 'fenced chunk text', chunk_source: 'compiled_truth', embedding: vec(502), model: 'openai:text-embedding-3-large', token_count: 3 }]);
      try {
        await primary.executeRaw(`UPDATE pages SET chunker_version = 0 WHERE slug = 'fence/page'`); // not sealed by the strict fence chunker: a remote read never serves it
        const [chunk] = await primary.executeRaw<{ id: number; page_id: number; chunk_text: string }>(`SELECT c.id, c.page_id, c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'fence/page'`);
        counts(await ranked((theirs) => [...theirs, { ...theirs[0], page_id: Number(chunk!.page_id), slug: 'fence/page', source_id: 'default', chunk_id: Number(chunk!.id), chunk_text: chunk!.chunk_text }]));
      } finally { await primary.executeRaw(`DELETE FROM pages WHERE slug = 'fence/page'`); }
    });

    test('a row that names no valid chunk is unexplained: a missing, null or non-numeric chunk id with arbitrary text never clears', async () => {
      counts(await ranked((theirs) => [...theirs.slice(0, 9), { ...theirs[9], chunk_id: undefined, chunk_text: 'ARBITRARY TEXT' }]));
      counts(await ranked((theirs) => [...theirs.slice(0, 9), { ...theirs[9], chunk_id: String(theirs[9]!.chunk_id), chunk_text: 'ARBITRARY TEXT' }]));
    });

    test('an element of the Rust answer that is not a row (a null, a string) makes the verdict incomplete: it is not dropped before the check', async () => {
      counts(await ranked((theirs) => [...theirs, null as never, 'private canary' as never]));
      counts(await ranked((theirs) => [...theirs.slice(0, 9), 7 as never, theirs[9]!]));
    });

    test('a ranked search that answers null, undefined or a single row is unexplained, never complete: it is not an empty list', async () => {
      counts(await ranked(() => null as never));
      counts(await ranked(() => undefined as never));
      counts(await ranked((theirs) => theirs[0] as never));
    });

    test('the primary\'s own page and chunk with a substituted title or flag are unexplained, not a ranking difference', async () => {
      counts(await ranked((theirs) => [...theirs.slice(0, 9), { ...theirs[9], title: 'SUBSTITUTED TITLE' }]));
      counts(await ranked((theirs) => [...theirs.slice(0, 9), { ...theirs[9], stale: true }]));
    });

    test('an extra row on a permitted page and chunk is cleared only when every non-ranking field is the primary\'s stored one: a substituted title, a field the primary does not have, a dropped field, a flag, the type or the chunk index', async () => {
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, title: 'SUBSTITUTED TITLE' }]));
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, message_id: 'm-substituted' }]));
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, stale: true }]));
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, type: 'person' }]));
      counts(await ranked((theirs, spare) => [...theirs, { ...spare, chunk_index: 7 }]));
      counts(await ranked((theirs, spare) => { const { effective_date: _dropped, ...rest } = spare; return [...theirs, rest]; }));
      const control = await unmoved(() => ranked((theirs, spare) => [...theirs, spare])); // the primary's own stored row still clears
      expect(control.rows[0]).toMatchObject({ outcome: 'diff', reason: 'extra_rows_cleared' });
    });

    test('an extra row the primary\'s stored row cannot be read for (the primary cannot answer the check) is unexplained, never cleared', async () => {
      const primary = ctx.primary();
      try {
        counts(await ranked((theirs, spare) => [...theirs, spare], { onPrivacyAsk: async () => { (primary as unknown as { searchVector: unknown }).searchVector = async () => { throw new Error('unreadable'); }; } })); // the stored row is read after the sample, inside the check
      } finally { delete (primary as unknown as { searchVector?: unknown }).searchVector; } // back to the engine's own method
    });

    test('an extra row the caller\'s own query filters would exclude is unexplained: a slug named in exclude_slugs is not a ranking difference', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const all = await withCallerAccess(ALICE, () => primary.searchVector(vec(3), { limit: 12, excludePrivate: true })) as unknown as Rows; // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
      // pregate-literal: SHADOW_ADAPTER_VERSION=11 unrelated literal, not the adapter version
      const banned = all[11]!; // a real chunk the caller may read, that this query excludes
      const opts = { exclude_slugs: [String(banned.slug)] };
      counts(await ranked((theirs) => [...theirs, banned], { opts }));
      const control = await unmoved(() => ranked((theirs, spare) => [...theirs, spare], { opts })); // the same query with a row it allows still clears
      expect(control.rows[0]).toMatchObject({ outcome: 'diff', reason: 'extra_rows_cleared' });
    });

    test('a privacy check that fails only in the rerun stays unsettled: the ledger row carries the reason and privacy_checks_unsettled_7d counts it, so criterion 6 has no evidence', async () => {
      const unidentified = (theirs: Rows, spare: Record<string, unknown>): Rows => [...theirs, { ...spare, page_id: undefined, slug: undefined, source_id: undefined }]; // the first check asks nothing and is not complete: the rerun is the first ask
      const failed = await ranked(unidentified, { settle: true, noRecall: true, onPrivacyAsk: async () => { throw new Error('privacy ask failed'); } });
      expect(failed.rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:privacy_check_unavailable', reason: 'privacy_check_unavailable' });
      expect(failed.evidence.privacy_checks_unsettled_7d).toBe(1);
    });

    test('the same rows in another order (order_diff) settle the privacy question after a completed compare with a clean privacy check: no unsettled count, privacy_diverged present', async () => {
      const r = await ranked((theirs) => [...theirs].reverse());
      expect(r.rows[0]).toMatchObject({ op: 'searchVector', outcome: 'order_diff', private_read: true });
      expect(r.evidence.privacy_checks_unsettled_7d).toBe(0);
      expect(r.row3.state).toBe('pass');
    });

    describe('order_diff never settles after a privacy check that was not clean', () => {
      // The first answer holds an extra row and one with no identity (not complete: a rerun is due); the reruns then answer the primary's own rows in another order.
      // The ranked rerun compare is an order_diff, so only its privacy check decides; when that check moves or fails, the row must stay open and never be written as order_diff.
      const reordered = (n: { calls: number }) => (theirs: Rows, spare: Record<string, unknown>): Rows => (++n.calls === 1 ? [...theirs, spare, { ...spare, page_id: undefined, slug: undefined, source_id: undefined }] : [...theirs].reverse());
      test('a rerun whose own privacy check cannot be answered leaves the sample open, not order_diff', async () => {
        const r = await ranked(reordered({ calls: 0 }), { settle: true, noRecall: true, child: { random: () => 0.5, sleep: async () => undefined }, onPrivacyAsk: async (n) => { if (n >= 2) throw new Error('privacy ask failed'); } });
        expect(r.rows[0]!.outcome).not.toBe('order_diff');
        expect(r.rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: expect.stringMatching(/^skipped:/) });
        expect(r.evidence.privacy_checks_unsettled_7d).toBeGreaterThan(0);
      });
      test('control: the same rerun answered clean (the rerun\'s rows are the primary\'s own, so there is no extra row to judge) closes the sample as matched and settles it', async () => {
        const r = await ranked(reordered({ calls: 0 }), { settle: true, noRecall: true, child: { random: () => 0.5, sleep: async () => undefined } });
        expect(r.rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'matched' });
        expect(r.evidence.privacy_checks_unsettled_7d).toBe(0);
      });
    });

    test('a read made under excludePrivate that the Rust adapter refuses (capability_missing) leaves the privacy question open: privacy_checks_unsettled_7d is above 0 and privacy_diverged stays absent', async () => {
      await privacyFixture(ctx.primary());
      const rig = await start();
      rig.rust.getLinks = async () => { throw Object.assign(new Error('refused'), { code: 'engine_capability_missing', reason: 'exclude_private_unsupported' }); };
      await withCallerAccess(ALICE, () => rig.engine.getLinks('open/a', { excludePrivate: true } as never));
      const rows = await rig.finish();
      expect(rows[0]).toMatchObject({ op: 'getLinks', outcome: 'capability_missing', private_read: true });
      appendLedgerRows(rig.dir, [{ ts: new Date().toISOString(), op: 'getPage', outcome: 'match', epoch_id: readEpoch(rig.dir)!.epoch_id, primary_ms: 1, rust_ms: 1, primary_rows: 1, rust_rows: 1 }]); // an unrelated match: something was compared
      const status = buildEvidenceStatus({ dir: rig.dir });
      expect(status.evidence?.privacy_checks_unsettled_7d).toBeGreaterThan(0);
      expect(status.privacy_diverged).toBeUndefined();
    });

    test('a crash between reruns leaves the sample unsettled for privacy: the first rerun\'s privacy check moved, the child is held in its backoff before the second run, and whatever is on disk then (all a crash would leave) already has an open privacy check', async () => {
      const probe = 'a2_crash_probe';
      await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
      await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
      try {
        const mixed = (theirs: Rows, spare: Record<string, unknown>): Rows => [...theirs, spare, { ...spare, page_id: undefined, slug: undefined, source_id: undefined }];
        let onDisk: ReturnType<typeof buildEvidenceStatus> | undefined;
        await ranked(mixed, { settle: true, noRecall: true, child: { random: () => 0.5, sleep: async () => undefined },
          onPrivacyAsk: async (n) => { if (n >= 2) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (1)`); }, // the first rerun's privacy check moves
          onRerunAsk: async (n, rig) => { if (n === 2) onDisk = buildEvidenceStatus({ dir: rig.dir }); } }); // the second run is asked for: the child has written nothing since the first rerun's answer, as if it were killed here
        expect(onDisk?.evidence?.privacy_checks_unsettled_7d).toBeGreaterThan(0); // the unresolved row alone makes it open
        expect(onDisk?.privacy_diverged).toBeUndefined(); // so the privacy criterion has no evidence yet, not a pass
      } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
    });

    describe('an unsettled privacy reason found in a middle rerun', () => {
      const coded = (code: string): Error => Object.assign(new Error(code), { code });
      // The first check holds but is not complete (a row with no identity); the first rerun's privacy check moves; a LATER rerun then fails before its own check.
      const later: Array<[string, (n: number, rig: Rig) => Promise<void>]> = [
        ['a write after the barrier on every later run (the three runs used up)', async (n) => { if (n >= 2) throw coded('write_after_barrier'); }],
        ['a later run that times out', async (n) => { if (n >= 2) throw coded('timeout'); }],
        ['a later run whose watermark is not valid', async (n) => { if (n >= 2) throw coded('watermark_invalid'); }],
        ['the child stopped while a later run is asked for', async (n, rig) => { if (n >= 2) { rig.attached.supervisor.stop(); throw coded('timeout'); } }],
      ];
      for (const [name, onRerunAsk] of later) {
        test(`${name} keeps the privacy_check_moved reason on the row: privacy_checks_unsettled_7d stays above 0`, async () => {
          const probe = 'a2_carry_probe';
          await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
          await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
          try {
            const mixed = (theirs: Rows, spare: Record<string, unknown>): Rows => [...theirs, spare, { ...spare, page_id: undefined, slug: undefined, source_id: undefined }];
            const r = await ranked(mixed, { settle: true, noRecall: true, child: { random: () => 0.5, sleep: async () => undefined }, onRerunAsk,
              onPrivacyAsk: async (n) => { if (n >= 2) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (1)`); } }); // the first rerun's privacy check moves
            expect(r.rows[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved', rerun: expect.stringMatching(/^skipped:/) });
            expect(r.evidence.privacy_checks_unsettled_7d).toBeGreaterThan(0);
          } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
        });
      }
    });

    test('a rerun whose privacy check moves every time (the three reruns used up) stays unsettled for privacy, not just unresolved', async () => {
      const probe = 'a2_unsettled_probe';
      await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
      await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
      try {
        const mixed = (theirs: Rows, spare: Record<string, unknown>): Rows => [...theirs, spare, { ...spare, page_id: undefined, slug: undefined, source_id: undefined }]; // one row to judge, one that has no identity: the first check holds but is not complete
        const moved = await ranked(mixed, { settle: true, noRecall: true, child: { random: () => 0.5, sleep: async () => undefined }, onPrivacyAsk: async (n) => { if (n >= 2) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (1)`); } }); // every check of the reruns moves
        expect(moved.rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:moved', reason: 'privacy_check_moved' });
        expect(moved.evidence.privacy_checks_unsettled_7d).toBe(1);
      } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
    });

    test('a policy dependency changed between the read and the check without a page timestamp (a deleted page, a source or config row, a provenance link) leaves the sample unresolved', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      const [src] = await primary.executeRaw<{ id: string; config: unknown }>(`SELECT id, config FROM sources ORDER BY id LIMIT 1`);
      const [cfg] = await primary.executeRaw<{ key: string; value: string }>(`SELECT key, value FROM config WHERE key = 'embedding_model'`);
      const changes: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
        ['a deleted page', () => primary.executeRaw(`DELETE FROM pages WHERE slug = 'gone/soon'`), async () => undefined],
        ['a source row', () => primary.executeRaw(`UPDATE sources SET config = config || '{"moved_probe":true}'::jsonb WHERE id = $1`, [src!.id]), () => primary.executeRaw(`UPDATE sources SET config = config - 'moved_probe' WHERE id = $1`, [src!.id])],
        ['a config row', () => primary.executeRaw(`UPDATE config SET value = value || '-probe' WHERE key = 'embedding_model'`), () => primary.executeRaw(`UPDATE config SET value = $1 WHERE key = 'embedding_model'`, [cfg!.value])],
        ['a provenance link', () => primary.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'synthesized_from', 'concept-provenance')`, [ids['summary/x'], ids['secrets/plan']]), () => primary.executeRaw(`DELETE FROM links WHERE from_page_id = $1 AND link_source = 'concept-provenance'`, [ids['summary/x']])],
      ];
      for (const [name, change, undo] of changes) {
        await primary.putPage('gone/soon', { type: 'note', title: 'gone', compiled_truth: 'gone soon', timeline: '' }); // there before the rig's fingerprint is taken
        const rig = await start({ unseeded: true });
        const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
        const real = supervisor.o.onAsk;
        supervisor.o.onAsk = async (ask) => { if (ask.kind === 'privacy') await change(); return real(ask); };
        rig.rust.listPages = async () => [{ id: ids['priv/a'], slug: 'priv/a', source_id: 'default', title: 'x', type: 'note' }];
        try {
          await withCallerAccess(ALICE, () => rig.engine.listPages({ limit: 100, excludePrivate: true }));
          expect([name, (await rig.finish())[0]]).toEqual([name, expect.objectContaining({ outcome: 'inconclusive', reason: 'privacy_check_moved' })]);
          expect([name, rig.stoppedBy]).toEqual([name, null]);
        } finally { await undo(); await primary.executeRaw(`DELETE FROM pages WHERE slug = 'gone/soon'`); }
      }
    });

    describe('the primary\'s WAL position over the check', () => {
      const clearing = (theirs: Rows, spare: Record<string, unknown>): Rows => [...theirs, spare]; // an extra row the caller may read: cleared when nothing moved
      const probe = 'a2_policy_probe';
      const mutations: Array<[string, (n: number) => Promise<unknown>, () => Promise<unknown>]> = [
        // a policy altered in place: a catalog change, no row of any table
        ['ALTER POLICY', async (n) => { await ctx.primary().executeRaw(`ALTER POLICY ${probe}_p ON ${probe} USING (${n % 2 ? 'true' : 'false'})`); },
          async () => { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`); await ctx.primary().executeRaw(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`); await ctx.primary().executeRaw(`CREATE POLICY ${probe}_p ON ${probe} USING (false)`); }],
        // A, then B, then A: a link added and removed again leaves every table as it was
        ['a change undone again (A, B, A)', async () => { const ids = await privacyFixture(ctx.primary()); await ctx.primary().executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'synthesized_from', 'concept-provenance')`, [ids['summary/x'], ids['secrets/plan']]); await ctx.primary().executeRaw(`DELETE FROM links WHERE from_page_id = $1 AND link_source = 'concept-provenance'`, [ids['summary/x']]); },
          async () => undefined],
      ];

      for (const [name, mutate, setup] of mutations) {
        test(`${name} between the read and the check: no clearance, three reruns, then the sample stays unresolved and counts as unexplained`, async () => {
          await setup();
          try {
            const r = await ranked(clearing, { settle: true, onPrivacyAsk: async (n) => { await mutate(n); } }); // every check sees the position move
            counts(r);
            expect(r.rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:moved' });
            expect(r.stopped).toBeNull();
          } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
        });
      }

      test('a rerun clears the sample once the position settles: the first check moved, the second did not', async () => {
        await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
        await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
        try {
          const r = await unmoved(() => ranked(clearing, { settle: true, onPrivacyAsk: async (n) => { if (n === 1) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (1)`); } }));
          expect(r.rows[0]).toMatchObject({ op: 'searchVector', outcome: 'diff', reason: 'extra_rows_cleared', rerun: 'differed' }); // the rerun's own check held
          expect(r.reads.diverged_unexplained_7d).toBe(0);
          expect(r.evidence.ranking_differences).toEqual({ searchVector: 1 });
          expect(r.row3.state).toBe('pass');
        } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
      });

      test('a sample whose position moved twice and then settled is cleared by the third run; one that moves on the first check and all three reruns is not', async () => {
        await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
        await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
        try {
          const r = await unmoved(() => ranked(clearing, { settle: true, onPrivacyAsk: async (n) => { if (n <= 2) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (${n})`); } }));
          expect(r.rows[0]).toMatchObject({ outcome: 'diff', reason: 'extra_rows_cleared' }); // asks 1 and 2 moved, ask 3 held
          const never = await ranked(clearing, { settle: true, onPrivacyAsk: async (n) => { if (n <= 4) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (${n})`); } });
          expect(never.rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:moved' }); // the first check and the three reruns moved: no clearance
        } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
      });

      /** A noisy neighbour on a virtual clock: every wait the child makes moves the clock, and the position moves on each check made before `quietAt`. */
      const noisy = (quietAt: number) => {
        const t = { clock: 0, waits: [] as number[] };
        const child: Partial<ShadowChildDeps> = { random: () => 0.5, sleep: async (ms) => { t.waits.push(ms); t.clock += ms; } };
        const onPrivacyAsk = async (): Promise<void> => { if (t.clock < quietAt) await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (1)`); };
        return { t, run: () => ranked(clearing, { settle: true, child, onPrivacyAsk, noRecall: true }) };
      };
      for (const [name, quietAt, cleared] of [['a burst that ends within the waits clears the sample', 1_000, true], ['noise that never ends leaves it unresolved and unexplained', Infinity, false]] as const) {
        test(`a growing wait before each rerun: ${name}`, async () => {
          await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
          await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
          try {
            let n = noisy(quietAt);
            const r = cleared ? await unmoved(() => { n = noisy(quietAt); return n.run(); }) : await n.run(); // a sample that is to clear is asked again when an unrelated commit moved it
            if (cleared) {
              expect(r.rows[0]).toMatchObject({ outcome: 'diff', reason: 'extra_rows_cleared', rerun: 'differed' });
              expect(r.reads.diverged_unexplained_7d).toBe(0);
              expect(n.t.waits).toEqual([500, 2_000]); // the check at 0 s and the rerun at 0.5 s moved; the rerun at 2.5 s held
            } else {
              counts(r);
              expect(r.rows[0]).toMatchObject({ rerun: 'skipped:moved' });
              expect(n.t.waits).toEqual([500, 2_000, 8_000]); // one wait before each of the three reruns
              expect(n.t.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RERUN_BACKOFF_TOTAL_MS);
            }
          } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
        });
      }

      test('the wait is a timer, not a block: a timer and an I/O callback run while a moved sample waits, and the sample then clears', async () => {
        await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`);
        await ctx.primary().executeRaw(`CREATE TABLE ${probe} (x int)`);
        try {
          let ticks = 0; let io = 0; let running = true;
          const timer = setInterval(() => { ticks++; }, 10);
          const spin = (): void => { if (running) readFile(import.meta.path, () => { io++; setImmediate(spin); }); };
          spin();
          let first: { at: number; ticks: number; io: number } | undefined; let second: { at: number; ticks: number; io: number } | undefined;
          const r = await unmoved(() => { first = second = undefined; return ranked(clearing, { settle: true, child: { random: () => 0.5, sleep: undefined }, noRecall: true, onPrivacyAsk: async (n) => { // the real timer: the first check moves, the rerun asks after the wait
            const mark = { at: Date.now(), ticks, io };
            if (n === 1) { first = mark; await ctx.primary().executeRaw(`INSERT INTO ${probe} VALUES (1)`); } else if (n === 2) second = mark;
          } }); });
          running = false; clearInterval(timer);
          expect(r.rows[0]).toMatchObject({ outcome: 'diff', reason: 'extra_rows_cleared' });
          expect(second!.at - first!.at).toBeGreaterThanOrEqual(450); // it waited 0.5 s
          expect(second!.ticks - first!.ticks).toBeGreaterThan(20); // a timer ran about every 10 ms through the wait: a blocked loop gives none
          expect(second!.io - first!.io).toBeGreaterThan(0); // and file reads completed
        } finally { await ctx.primary().executeRaw(`DROP TABLE IF EXISTS ${probe}`); }
      });
    });

    test('a write this process publishes DURING the check, not before it, leaves the sample unresolved', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      const rig = await start();
      const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
      const real = supervisor.o.onAsk;
      supervisor.o.onAsk = (ask) => { // the check starts, then a write is published while its snapshots are awaited
        const answer = real(ask);
        if (ask.kind === 'privacy') rig.attached.follower!.publish(batch(1, [{ kind: 'relation', relation: 'config', reason: 'x' }]));
        return answer;
      };
      rig.rust.getPage = async () => ({ id: ids['open/a'], slug: 'open/a', source_id: 'default', title: 'x', type: 'note' });
      await withCallerAccess(ALICE, () => rig.engine.getPage('missing/page', { excludePrivate: true } as never));
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved' });
    });

    test('a list of more than 2,000 row identities, or one holding anything invalid, is never complete: a forbidden row after the limit is not cleared by its absence', async () => {
      const crowd = (theirs: Rows, ids: Record<string, number>): Rows => [...Array.from({ length: 2000 }, () => theirs[0]!), { ...theirs[0], page_id: ids['priv/a'], slug: 'priv/a', source_id: 'default', chunk_id: 987_654, chunk_text: 'beyond the limit' }];
      counts(await ranked((theirs, _spare, ids) => crowd(theirs, ids)));
      // the serving process, asked directly: a list that is not a list, or holds a malformed identity, answers incomplete (clean as far as it goes)
      const primary = ctx.primary();
      const samples = new SampleRegistry();
      const reads = openReadSource(primary);
      try {
        const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never });
        const sid = samples.add({ op: 'searchVector', args: encodeValue([vec(3), { limit: 10, excludePrivate: true }]), result: [], at: Date.now(), lsn: 'x' }, 100); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        for (const rows of ['not a list', [{ payload: 'p', id: 'seven' }], [null]]) expect(await handler({ id: 1, kind: 'privacy', sid, phase: 'sample', rows })).toEqual({ verdict: 'clean', complete: false });
        expect(await handler({ id: 2, kind: 'privacy', sid, phase: 'sample', rows: [] })).toEqual({ verdict: 'clean', complete: true }); // control: nothing extra, nothing invalid
      } finally { await reads.close(); }
    });

    test('a write this process publishes DURING the check, not before it, leaves the sample unresolved', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      const rig = await start();
      const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
      const real = supervisor.o.onAsk;
      supervisor.o.onAsk = (ask) => { // the check starts, then a write is published while its snapshots are awaited
        const answer = real(ask);
        if (ask.kind === 'privacy') rig.attached.follower!.publish(batch(1, [{ kind: 'relation', relation: 'config', reason: 'x' }]));
        return answer;
      };
      rig.rust.getPage = async () => ({ id: ids['open/a'], slug: 'open/a', source_id: 'default', title: 'x', type: 'note' });
      await withCallerAccess(ALICE, () => rig.engine.getPage('missing/page', { excludePrivate: true } as never));
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved' });
    });

    test('a list of more than 2,000 row identities, or one holding anything invalid, is never complete: a forbidden row after the limit is not cleared by its absence', async () => {
      const crowd = (theirs: Rows, ids: Record<string, number>): Rows => [...Array.from({ length: 2000 }, () => theirs[0]!), { ...theirs[0], page_id: ids['priv/a'], slug: 'priv/a', source_id: 'default', chunk_id: 987_654, chunk_text: 'beyond the limit' }];
      counts(await ranked((theirs, _spare, ids) => crowd(theirs, ids)));
      // the serving process, asked directly: a list that is not a list, or holds a malformed identity, answers incomplete (clean as far as it goes)
      const primary = ctx.primary();
      const samples = new SampleRegistry();
      const reads = openReadSource(primary);
      try {
        const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never });
        const sid = samples.add({ op: 'searchVector', args: encodeValue([vec(3), { limit: 10, excludePrivate: true }]), result: [], at: Date.now(), lsn: 'x' }, 100); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        for (const rows of ['not a list', [{ payload: 'p', id: 'seven' }], [null]]) expect(await handler({ id: 1, kind: 'privacy', sid, phase: 'sample', rows })).toEqual({ verdict: 'clean', complete: false });
        expect(await handler({ id: 2, kind: 'privacy', sid, phase: 'sample', rows: [] })).toEqual({ verdict: 'clean', complete: true }); // control: nothing extra, nothing invalid
      } finally { await reads.close(); }
    });

    test('the fingerprint moves for a change no timestamp shows: a deleted_at, a chunker or projection seal, a knowledge revision, an embedding, a chunk generation, an access row', async () => {
      const primary = ctx.primary();
      await primary.putPage('fp/page', { type: 'note', title: 'fp/page', compiled_truth: 'fingerprint chunk text', timeline: '' });
      await installFixtureChunks(primary, 'fp/page', [{ chunk_index: 0, chunk_text: 'fingerprint chunk text', chunk_source: 'compiled_truth', embedding: vec(503), model: MODEL, token_count: 3 }]);
      await privacyFixture(primary);
      const reads = openReadSource(primary);
      const watch = createLsnWatch(reads);
      const page = (set: string, undo: string): [string, string] => [`UPDATE pages SET ${set} WHERE slug = 'fp/page'`, `UPDATE pages SET ${undo} WHERE slug = 'fp/page'`];
      try {
        const [orig] = await primary.executeRaw<{ cv: unknown; sealed: unknown }>(`SELECT chunker_version AS cv, text_projection_revision AS sealed FROM pages WHERE slug = 'fp/page'`);
        const changes: Array<[string, string, string]> = [
          ['deleted_at', ...page(`deleted_at = now()`, `deleted_at = NULL`)],
          ['chunker seal', ...page(`chunker_version = 0`, `chunker_version = ${Number(orig!.cv ?? 4)}`)],
          ['knowledge_revision', `UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE slug = 'fp/page'`, `SELECT 1`],
          ['projection seal', `UPDATE pages SET text_projection_revision = gen_random_uuid() WHERE slug = 'fp/page'`, orig!.sealed == null ? `UPDATE pages SET text_projection_revision = NULL WHERE slug = 'fp/page'` : `SELECT 1`],
          ['embedding presence', `UPDATE content_chunks SET embedding = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = 'fp/page')`, `SELECT 1`],
          ['access row', `UPDATE access_rules SET readable_by = ARRAY['member:carol-example'] WHERE rule_id = 'r1'`, `UPDATE access_rules SET readable_by = ARRAY['member:bob-example'] WHERE rule_id = 'r1'`],
        ];
        for (const [name, change, undo] of changes) {
          const before = await watch.live();
          await primary.executeRaw(change);
          expect([name, (await watch.live()) !== before]).toEqual([name, true]);
          await primary.executeRaw(undo);
        }
      } finally { await reads.close(); await primary.executeRaw(`DELETE FROM pages WHERE slug = 'fp/page'`); }
    });

    test('a write this process published after the read, and before the check, leaves the sample unresolved', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      const rig = await start();
      const real = (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o.onAsk;
      (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o.onAsk = async (ask) => {
        if (ask.kind === 'privacy') rig.attached.follower!.publish(batch(1, [{ kind: 'relation', relation: 'config', reason: 'x' }]));
        return real(ask);
      };
      rig.rust.getPage = async () => ({ id: ids['open/a'], slug: 'open/a', source_id: 'default', title: 'x', type: 'note' });
      await withCallerAccess(ALICE, () => rig.engine.getPage('missing/page', { excludePrivate: true } as never));
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved' });
    });

    test('the token a sample is held to is taken BEFORE the primary read starts: a corpus change or a published write while the read runs leaves it unresolved, and a refresh never adopts a newer one', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      const original = primary.listPages.bind(primary);
      try {
        for (const during of ['a corpus change', 'a write published by this process'] as const) {
          await primary.putPage('slow/gone', { type: 'note', title: 'gone', compiled_truth: 'gone soon', timeline: '' });
          const rig = await start();
          const slow = gate();
          let started!: () => void;
          const began = new Promise<void>((resolve) => { started = resolve; });
          (primary as unknown as { listPages: unknown }).listPages = async (...a: never[]) => { started(); await slow.wait; return (original as (...x: unknown[]) => unknown)(...a); };
          rig.rust.listPages = async () => [{ id: ids['priv/a'], slug: 'priv/a', source_id: 'default', title: 'x', type: 'note' }];
          const read = withCallerAccess(ALICE, () => rig.engine.listPages({ limit: 100, excludePrivate: true }));
          await began; // the primary read has started: its token is already taken
          if (during === 'a corpus change') { await primary.executeRaw(`DELETE FROM pages WHERE slug = 'slow/gone'`); await rig.attached.lsnWatch.ready(); } // and a refresh now sees the newer corpus
          else rig.attached.follower!.publish(batch(1, [{ kind: 'relation', relation: 'config', reason: 'x' }]));
          slow.open();
          await read;
          expect([during, (await rig.finish())[0]]).toEqual([during, expect.objectContaining({ outcome: 'inconclusive', reason: 'privacy_check_moved' })]);
          await primary.executeRaw(`DELETE FROM pages WHERE slug = 'slow/gone'`);
        }
      } finally { (primary as unknown as { listPages: unknown }).listPages = original; await primary.executeRaw(`DELETE FROM pages WHERE slug = 'slow/gone'`); }
    });

    test('a derivative of a private origin whose origin is widened before the check is not cleared', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      await installFixtureChunks(primary, 'summary/x', [{ chunk_index: 0, chunk_text: 'a summary of the secret plan', chunk_source: 'compiled_truth', embedding: vec(501), model: 'openai:text-embedding-3-large', token_count: 3 }]);
      await vectorFixture(primary);
      const [chunk] = await primary.executeRaw<{ id: number; chunk_text: string }>(`SELECT c.id, c.chunk_text FROM content_chunks c WHERE c.page_id = $1`, [ids['summary/x']]);
      const opts = { limit: 10, excludePrivate: true };
      const theirs = await withCallerAccess(ALICE, () => primary.searchVector(vec(3), opts)) as unknown as Rows;
      const rig = await start();
      const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
      const real = supervisor.o.onAsk;
      // the derivative's origin is made world-readable between the read and the check: the policy is read now, the read was made under the old one
      supervisor.o.onAsk = async (ask) => {
        if (ask.kind === 'privacy') await primary.executeRaw(`UPDATE pages SET frontmatter = '{"visibility":"world"}'::jsonb, updated_at = now() + interval '1 second' WHERE slug = 'secrets/plan'`);
        return real(ask);
      };
      rig.rust.searchVector = async () => [...theirs, { ...theirs[0], page_id: ids['summary/x'], slug: 'summary/x', source_id: 'default', chunk_id: Number(chunk!.id), chunk_text: chunk!.chunk_text }];
      try {
        await withCallerAccess(ALICE, () => rig.engine.searchVector(vec(3), opts));
        const rows = await rig.finish();
        expect(rows[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved' });
        expect(buildEvidenceStatus({ dir: rig.dir }).evidence!.ranking_differences).toEqual({});
      } finally { await primary.executeRaw(`UPDATE pages SET frontmatter = '{"visibility":"private"}'::jsonb, updated_at = now() - interval '1 hour' WHERE slug = 'secrets/plan'`); }
    });
  });

  describe('a child that is an IPC client of another owner counts nothing', () => {
    const client = async (o: Partial<RigOptions> = {}): Promise<Rig> => { const rig = await start(o); (rig.rust as Record<string, unknown>).ownerRole = 'client'; return rig; };

    test('its rows carry no epoch, no rerun or recall runs, and the status has no evidence from it', async () => {
      const primary = ctx.primary();
      await privacyFixture(primary);
      await vectorFixture(primary);
      const rig = await client();
      rig.rust.listPages = async () => [];
      rig.rust.searchVector = async () => [];
      await sample(rig);
      await rig.engine.searchVector(vec(3), { limit: 10 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count or size), not the adapter version
      const rows = await rig.finish(2);
      expect(rows.map((r) => r.epoch_id)).toEqual([undefined, undefined]); // a client names no epoch
      expect(rows.find((r) => r.op === 'listPages')).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:no_epoch' });
      expect(readEpoch(rig.dir)).toBeNull(); // and opens none
      expect(buildEvidenceStatus({ dir: rig.dir })).toEqual({});
      expect(readEpochRecall(rig.dir, 'any')).toEqual([]); // no reference run was asked for
    });

    test('a privacy pause from it still stops mirroring but is not counted in any epoch', async () => {
      const ids = await privacyFixture(ctx.primary());
      const rig = await client();
      const epoch = ensureEpoch(rig.dir, { seed_id: 'seed-1', rust_addon_sha256: 'a', comparator_version: 2, adapter_version: 'x', capability_set_hash: 'c', readiness_policy_hash: 'p' }).epoch_id;
      appendLedgerRows(rig.dir, [{ ts: new Date().toISOString(), op: 'getPage', outcome: 'match', epoch_id: epoch, primary_ms: 1, rust_ms: 1, primary_rows: 1, rust_rows: 1 }]);
      rig.rust.listPages = async () => [{ id: ids['priv/a'], slug: 'priv/a', source_id: 'default', title: 'x', type: 'note' }];
      await withCallerAccess(ALICE, () => rig.engine.listPages({ limit: 100, excludePrivate: true }));
      const rows = await rig.finish();
      expect(rows[0]).toMatchObject({ outcome: 'privacy_diverged' });
      expect(rows[0]!.epoch_id).toBeUndefined();
      expect(rig.stoppedBy).toBe('privacy_diverged'); // safety is not an evidence count
      expect(buildEvidenceStatus({ dir: rig.dir }).privacy_diverged).toBe(0);
    });
  });

  describe('the control channel, unresolved samples and restarts', () => {
    const onAsk = (rig: Rig) => (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o;
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

    test('no argument, identity, folder-rule or thrown-message canary reaches the control channel, an answer, or any shadow file', async () => {
      const primary = ctx.primary();
      const ids = await privacyFixture(primary);
      const caller = { ...ALICE, identity: ['member:canary-identity-zzz'], satisfiedRuleIds: ['default:canary-rule-zzz'] };
      const rig = await start();
      rig.rust.getPage = async () => ({ id: ids['open/a'], slug: 'canary-args-slug-zzz', source_id: 'default', title: 'canary-title-zzz', type: 'note' });
      const real = onAsk(rig).onAsk;
      onAsk(rig).onAsk = async (ask) => { if (ask.kind === 'rerun') throw new Error('canary-thrown-message-zzz'); return real(ask); };
      await withCallerAccess(caller, () => rig.engine.getPage('canary-args-slug-zzz', { excludePrivate: true } as never));
      const rows = await rig.finish();
      expect(rows[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'skipped:failed' }); // the exception came back as a code
      expect(rig.control.fromChild.some((l) => l.includes('"t":"ask"'))).toBe(true); // there was a conversation to leak into
      const bytes = [rig.control.fromChild.join(''), rig.control.answers.join(''), ...walk(rig.dir).filter((f) => !f.endsWith('child.log')).map((f) => readFileSync(f, 'utf8'))].join('\n');
      for (const canary of ['canary-args-slug-zzz', 'canary-identity-zzz', 'canary-rule-zzz', 'canary-thrown-message-zzz', 'canary-title-zzz']) expect([canary, bytes.includes(canary)]).toEqual([canary, false]);
    });

    test('a SUCCESSFUL rerun and a successful privacy check put no content on the control channel: no body, title, slug, chunk text or member key in any ask or answer', async () => {
      const primary = ctx.primary();
      const canaries = ['canary-ok-slug-zzz', 'canary-ok-title-zzz', 'canary-ok-body-zzz'];
      try {
        await primary.putPage('canary-ok-slug-zzz', { type: 'note', title: 'canary-ok-title-zzz', compiled_truth: 'canary-ok-body-zzz', timeline: '' });
        const ids = await privacyFixture(primary);
        const [canary] = await primary.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'canary-ok-slug-zzz'`);
        // a rerun that succeeds: Rust's first answer is empty, the primary has pages (the canary page among them), and the rerun runs on both
        const rerun = await mismatching('agrees');
        await rerun.settled();
        await sample(rerun);
        expect((await rows(rerun))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'matched' }); // the rerun ran and succeeded
        // a privacy check that succeeds: Rust shows an extra page the caller may read
        const check = await start({ unseeded: true });
        const top = await withCallerAccess(BOB, () => primary.listPages({ excludePrivate: true, limit: 1 }));
        check.rust.listPages = async () => [top[0]!, { id: Number(canary!.id), slug: 'canary-ok-slug-zzz', source_id: 'default', title: 'canary-ok-title-zzz', type: 'note' }, { id: ids['mem/a'], slug: 'mem/a', source_id: 'default', title: 'mem/a', type: 'note' }];
        await withCallerAccess(BOB, () => check.engine.listPages({ excludePrivate: true, limit: 1 }));
        await check.finish();
        for (const rig of [rerun, check]) {
          expect(rig.control.answers.length).toBeGreaterThan(0);
          const bytes = [rig.control.fromChild.join(''), rig.control.answers.join('')].join('\n');
          for (const canary of canaries) expect([canary, bytes.includes(canary)]).toEqual([canary, false]);
        }
        expect(check.control.answers.some((l) => l.includes('"verdict"'))).toBe(true); // a verdict, nothing else, went back for the check
      } finally { await primary.executeRaw(`DELETE FROM pages WHERE slug = 'canary-ok-slug-zzz'`); }
    });

    test('an unresolved comparison is on disk and counted while its rerun waits, and settles when the completion row lands', async () => {
      await privacyFixture(ctx.primary());
      const rig = await mismatching('agrees');
      await rig.settled();
      const hold = gate();
      const real = onAsk(rig).onAsk;
      onAsk(rig).onAsk = async (ask) => { if (ask.kind === 'rerun') await hold.wait; return real(ask); };
      await sample(rig);
      await until(() => rig.pending().length === 1);
      const during = (): { reads: NonNullable<ReturnType<typeof buildEvidenceStatus>['reads']>; row3: { state: string } } => {
        const { evidence, ...ev } = buildEvidenceStatus({ dir: rig.dir });
        return { reads: ev.reads!, row3: evaluateReadiness({ epoch_id: evidence?.epoch_id, epoch_started_at: evidence?.epoch_started_at, ...ev } as never, new Date()).criteria.find((c) => c.n === 3)! };
      };
      expect(rig.rows()).toHaveLength(0); // nothing completed
      expect(during().reads.diverged_unexplained_7d).toBe(1); // yet the status does not read clean
      expect(during().row3.state).toBe('fail');
      hold.open();
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'matched' });
      expect(during().reads.diverged_unexplained_7d).toBe(0); // the completion row with the same sample id settles it
      expect(during().row3.state).toBe('pass');
    });

    test('a child killed while the rerun waits leaves its unresolved row unexplained, after the restart too', async () => {
      await privacyFixture(ctx.primary());
      const rig = await mismatching('agrees');
      await rig.settled();
      const hold = gate();
      const real = onAsk(rig).onAsk;
      onAsk(rig).onAsk = async (ask) => { if (ask.kind === 'rerun') await hold.wait; return real(ask); };
      await sample(rig);
      await until(() => rig.pending().length === 1);
      rig.killChild();
      expect(buildEvidenceStatus({ dir: rig.dir }).reads!.diverged_unexplained_7d).toBe(1);
      await rig.settled(); // a new child starts
      expect(buildEvidenceStatus({ dir: rig.dir }).reads!.diverged_unexplained_7d).toBe(1); // nobody completed it
      hold.open();
    });

    test('an old child\'s late answer never resolves the restarted child\'s ask with the same id', async () => {
      await privacyFixture(ctx.primary());
      const primary = ctx.primary();
      const rig = await start();
      let calls = 0;
      rig.rust.listPages = async () => (++calls <= 2 ? [] : primary.listPages({ limit: 100 })); // both samples mismatch; the rerun after them agrees
      await rig.settled();
      const gates = [gate(), gate()];
      let asks = 0;
      const real = onAsk(rig).onAsk;
      onAsk(rig).onAsk = async (ask) => {
        if (ask.kind !== 'rerun') return real(ask);
        const mine = asks++;
        await gates[mine]!.wait;
        const out = await real(ask) as Record<string, unknown>;
        return mine === 0 ? { ...out, epoch_id: 'from-the-old-child' } : out; // an answer B would reject as another epoch's, had it been delivered
      };
      await sample(rig); // child A asks (id 1) and waits
      await until(() => asks === 1);
      rig.killChild();
      await rig.settled(); // child B
      await sample(rig); // child B asks (id 1 again) and waits
      await until(() => asks === 2);
      gates[0]!.open(); // A's answer arrives late
      await sleep(150);
      expect(rig.rows()).toHaveLength(0); // B's ask was not resolved by it
      gates[1]!.open();
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'matched' }); // B's own answer
    });
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
        const { handler, ask, reference } = await untilNotMoved(async () => { // an unrelated commit moves the token: asked again from a new capture
          const samples = new SampleRegistry();
          const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never });
          // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
          const ask = { id: 1, kind: 'vector', sid: samples.add({ op: 'searchVector', args: encodeValue([embedded.embedding, { limit: 10, exclude_slugs: ['priv/chunked', 'summary/x'] }]), at: Date.now(), lsn: await createLsnWatch(real).live() }, 100) }; // the filters of the caller's own read apply
          return { handler, ask, reference: await handler(ask) as RankedKey[] };
        });
        const cosine = (a: Float32Array, b: Float32Array): number => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
        const exact = [...chunkOf.keys()].sort((p, q) => cosine(vec(3), vec(q)) - cosine(vec(3), vec(p))).map((i) => String(chunkOf.get(i)));
        // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
        expect(reference).toHaveLength(Math.min(RECALL_REFERENCE_LIMIT, 12)); // asked for more than the caller's ten, so a tie at the cutoff is visible
        expect(new Set(reference.slice(0, 10).map((r) => r.k))).toEqual(new Set(exact.slice(0, 10))); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        expect(sql.slice(0, 2)).toEqual(['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off']); // before any search statement
        await expect(handler(ask)).rejects.toMatchObject({ code: 'rate_limited' });
      } finally { await real.close(); }
    });

    test('the reference applies the caller\'s own filters: a slug named in exclude_slugs, a slug prefix and a page type are not in it', async () => {
      const primary = ctx.primary();
      const chunkOf = await vectorFixture(primary);
      const real = openReadSource(primary);
      try {
        const top = String(chunkOf.get(0)); // a chunk of a page the filters below exclude
        const [page] = await primary.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p JOIN content_chunks c ON c.page_id = p.id WHERE c.id = $1`, [Number(top)]);
        const reference = async (opts: Record<string, unknown>): Promise<string[]> => untilNotMoved(async () => {
          const samples = new SampleRegistry();
          const handler = makeAskHandler({ engine: primary, reads: real, dir: '/none', samples, rpc: (async () => ({})) as never });
          const sid = samples.add({ op: 'searchVector', args: encodeValue([vec(3), { limit: 10, ...opts }]), at: Date.now(), lsn: await createLsnWatch(real).live() }, 100); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
          return ((await handler({ id: 1, kind: 'vector', sid })) as RankedKey[]).map((r) => r.k);
        });
        expect(await reference({})).toContain(top); // control: without a filter the chunk is in the reference
        expect(await reference({ exclude_slugs: [page!.slug] })).not.toContain(top);
        expect(await reference({ exclude_slug_prefixes: [page!.slug] })).not.toContain(top);
        expect(await reference({ types: ['person'] })).not.toContain(top);
      } finally { await real.close(); }
    });

    test('a reference is refused (moved) when the corpus changed after the sample was captured, and when no fingerprint was captured with it', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const reads = openReadSource(primary);
      try {
        const watch = createLsnWatch(reads);
        const args = encodeValue([vec(3), { limit: 10 }]);
        const samples = new SampleRegistry();
        const handler = (now: number) => makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => now });
        const proven = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100);
        const unproven = samples.add({ op: 'searchVector', args, at: Date.now() }, 100); // captured before any fingerprint was known
        await expect(handler(0)({ id: 1, kind: 'vector', sid: unproven })).rejects.toMatchObject({ code: 'moved' });
        // a nearer neighbour is added after the capture: the answers the sample holds cannot be scored against a corpus that has it
        await primary.putPage('vec/late', { type: 'note', title: 'late', compiled_truth: 'late vec', timeline: '' });
        await installFixtureChunks(primary, 'vec/late', [{ chunk_index: 0, chunk_text: 'late vec', chunk_source: 'compiled_truth', embedding: vec(3), model: MODEL, token_count: 3 }]);
        await expect(handler(120_000)({ id: 2, kind: 'vector', sid: proven })).rejects.toMatchObject({ code: 'moved' });
        // and a deletion, which no timestamp shows
        const deleted = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100);
        await primary.executeRaw(`DELETE FROM pages WHERE slug = 'vec/late'`);
        await expect(handler(240_000)({ id: 3, kind: 'vector', sid: deleted })).rejects.toMatchObject({ code: 'moved' });
        expect(await untilNotMoved(async () => handler(360_000)({ id: 4, kind: 'vector', sid: samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100) }))).toBeInstanceOf(Array); // unchanged since the capture: scored as before (asked again from a new capture when an unrelated commit moved it)
      } finally { await reads.close(); await primary.executeRaw(`DELETE FROM pages WHERE slug = 'vec/late'`); }
    });

    test('a reference is refused (moved) when only the access policy changed after the capture: a rule, a pending coverage row or a grant, with no page touched', async () => {
      const primary = ctx.primary();
      await privacyFixture(primary);
      await vectorFixture(primary);
      const reads = openReadSource(primary);
      try {
        const watch = createLsnWatch(reads);
        const samples = new SampleRegistry();
        const args = encodeValue([vec(3), { limit: 10, excludePrivate: true }]);
        const handler = (now: number) => makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => now });
        const captured = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100);
        await primary.executeRaw(`UPDATE access_rules SET readable_by = ARRAY['member:carol-example'] WHERE rule_id = 'r1'`); // the policy moves; no page, chunk, link, source or config row does
        await expect(handler(0)({ id: 1, kind: 'vector', sid: captured })).rejects.toMatchObject({ code: 'moved' });
        await primary.executeRaw(`UPDATE access_rules SET readable_by = ARRAY['member:bob-example'] WHERE rule_id = 'r1'`);
        expect(await untilNotMoved(async () => handler(120_000)({ id: 2, kind: 'vector', sid: samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100) }))).toBeInstanceOf(Array); // control: unchanged since the capture (asked again from a new capture when an unrelated commit moved it)
      } finally { await reads.close(); await primary.executeRaw(`UPDATE access_rules SET readable_by = ARRAY['member:bob-example'] WHERE rule_id = 'r1'`); }
    });

    test('a reference is refused (moved) after an embedding-only UPDATE, a modality-only change or an embedding-hash-only change to a chunk: no page timestamp, no metadata shows them', async () => {
      const primary = ctx.primary();
      const chunkOf = await vectorFixture(primary);
      const top = chunkOf.get(3)!;
      const reads = openReadSource(primary);
      const literal = `[${Array.from(vec(77)).join(',')}]`; // another vector for the same chunk
      try {
        const watch = createLsnWatch(reads);
        const samples = new SampleRegistry();
        const args = encodeValue([vec(3), { limit: 10 }]);
        const handler = (now: number) => makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => now });
        const changes: Array<[string, unknown[], string, unknown[]]> = [
          [`embedding = $2::vector`, [top, literal], `embedding = $2::vector`, [top, `[${Array.from(vec(3)).join(',')}]`]],
          [`modality = 'image'`, [top], `modality = 'text'`, [top]],
          [`embedded_text_hash = 'stale-hash'`, [top], `embedded_text_hash = NULL`, [top]],
        ];
        for (const [i, [change, params, undo, undoParams]] of changes.entries()) {
          const captured = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100);
          await primary.executeRaw(`UPDATE content_chunks SET ${change} WHERE id = $1`, params);
          await expect(handler(i * 120_000)({ id: i + 1, kind: 'vector', sid: captured })).rejects.toMatchObject({ code: 'moved' });
          await primary.executeRaw(`UPDATE content_chunks SET ${undo} WHERE id = $1`, undoParams);
        }
      } finally { await reads.close(); await primary.executeRaw(`UPDATE content_chunks SET modality = 'text' WHERE modality <> 'text'`); }
    });

    test('a commit with synchronous_commit=off from another connection moves the position at once: the reference is refused (Postgres only)', async () => {
      if (ctx.dialect !== 'postgres') return; // PGLite has a single connection: no external writer
      const primary = ctx.primary();
      const chunkOf = await vectorFixture(primary);
      const top = chunkOf.get(3)!;
      const reads = openReadSource(primary);
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const other = new PostgresEngine();
      await other.connect({ engine: 'postgres', database_url: (primary as unknown as { connectedDatabaseUrl?: string }).connectedDatabaseUrl, poolSize: 1 } as never);
      try {
        const watch = createLsnWatch(reads);
        const samples = new SampleRegistry();
        const args = encodeValue([vec(3), { limit: 10 }]);
        let clock = 0;
        const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => (clock += 120_000) }); // the reference's one-a-minute gate opens for each
        const literal = `[${Array.from(vec(88)).join(',')}]`;
        for (let i = 0; i < 20; i++) { // the WAL writer flushes every 200 ms: repeat so the commit is not always flushed before the reference ends
          const captured = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100);
          await other.transaction(async (tx) => { await tx.executeRaw(`SET LOCAL synchronous_commit = off`); await tx.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literal]); });
          await expect(handler({ id: i + 1, kind: 'vector', sid: captured, phase: 'sample' })).rejects.toMatchObject({ code: 'moved' });
          await primary.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, `[${Array.from(vec(3)).join(',')}]`]);
          await new Promise((r) => setTimeout(r, 70)); // a different phase of the WAL writer's cycle each time
        }
      } finally { await other.disconnect(); await reads.close(); }
    }, 120_000);

    test('a commit whose COMMIT record is inserted before the capture but becomes visible after it leaves the position unchanged, yet the proof refuses: privacy and the reference are moved (Postgres only)', async () => {
      if (ctx.dialect !== 'postgres') return; // PGLite has one connection: no concurrent transaction
      const primary = ctx.primary();
      const chunkOf = await vectorFixture(primary);
      const ids = await privacyFixture(primary);
      const top = chunkOf.get(3)!;
      const reads = openReadSource(primary);
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const url = (primary as unknown as { connectedDatabaseUrl?: string }).connectedDatabaseUrl;
      const other = new PostgresEngine();
      await other.connect({ engine: 'postgres', database_url: url, poolSize: 1 } as never);
      const admin = new PostgresEngine();
      await admin.connect({ engine: 'postgres', database_url: url, poolSize: 1 } as never);
      // A synchronous standby that never connects holds the writer between its flushed COMMIT record and the moment it becomes visible
      // (Postgres waits for the standby before it ends the transaction), for as long as the test needs instead of commit_delay's 100 ms,
      // which a loaded machine can miss. Every other session commits locally meanwhile. `release` clears it and lets the writer finish.
      const release = async (): Promise<void> => {
        await admin.executeRaw(`ALTER SYSTEM RESET synchronous_standby_names`);
        await admin.executeRaw(`ALTER SYSTEM RESET synchronous_commit`);
        await admin.executeRaw(`SELECT pg_reload_conf()`);
      };
      let writer: Promise<void> | undefined;
      try {
        const watch = createLsnWatch(reads);
        const samples = new SampleRegistry();
        const args = encodeValue([vec(3), { limit: 10, excludePrivate: true }]);
        let clock = 0;
        const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => (clock += 120_000) });
        const literal = `[${Array.from(vec(89)).join(',')}]`;
        await admin.executeRaw(`ALTER SYSTEM SET synchronous_commit = 'local'`);
        await admin.executeRaw(`ALTER SYSTEM SET synchronous_standby_names = 'gbrain_test_never_connects'`);
        await admin.executeRaw(`SELECT pg_reload_conf()`);
        const reloaded = async (): Promise<boolean> => (await admin.executeRaw<{ s: string }>(`SELECT current_setting('synchronous_standby_names') AS s`))[0]!.s === 'gbrain_test_never_connects';
        // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        for (const end = Date.now() + 15_000; !(await reloaded()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 10)); // the server has passed the new settings on
        await admin.executeRaw(`CHECKPOINT`); // the checkpointer takes the reload before this checkpoint, and it is the one that tells committing sessions a standby is named
        let writerPid = 0;
        let settled = false;
        writer = other.transaction(async (tx) => {
          await tx.executeRaw(`SET LOCAL synchronous_commit = on`);
          writerPid = Number((await tx.executeRaw<{ p: number }>(`SELECT pg_backend_pid() AS p`))[0]!.p);
          await tx.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literal]);
        });
        writer.then(() => { settled = true; }, () => { settled = true; });
        let held = false;
        for (const end = Date.now() + 15_000; !held && !settled && Date.now() < end;) {
          held = writerPid > 0 && (await admin.executeRaw<{ w: string | null }>(`SELECT wait_event AS w FROM pg_stat_activity WHERE pid = $1`, [writerPid]))[0]?.w === 'SyncRep';
          if (!held) await new Promise((r) => setTimeout(r, 10)); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        }
        expect(held).toBe(true); // the writer's COMMIT record is flushed and it waits for the standby: still in progress to every snapshot
        const token = await watch.live();
        expect(token).not.toBe(''); expect(token.split('|')[1]).not.toBe(''); // the capture found the writer in progress: its xid is in the token
        const sid = samples.add({ op: 'searchVector', args, result: [], at: Date.now(), lsn: token }, 100);
        const seen = await primary.executeRaw<{ e: string }>(`SELECT embedding::text AS e FROM content_chunks WHERE id = $1`, [top]);
        expect(seen[0]!.e).not.toBe(literal); // the primary read (this one) still sees the old vector
        await release();
        await writer; // the writer becomes visible, with no further WAL from anyone
        expect((await primary.executeRaw<{ e: string }>(`SELECT embedding::text AS e FROM content_chunks WHERE id = $1`, [top]))[0]!.e).toBe(literal);
        const rows = [{ payload: 'p', id: ids['open/a'] }]; // an extra Rust row the caller may read: cleared only if nothing moved
        expect(await handler({ id: 1, kind: 'privacy', sid, phase: 'sample', rows })).toEqual({ verdict: 'privacy_check_moved', complete: false });
        await expect(handler({ id: 2, kind: 'vector', sid, phase: 'sample' })).rejects.toMatchObject({ code: 'moved' });
      } finally {
        await release();
        await writer?.catch(() => undefined);
        await primary.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, `[${Array.from(vec(3)).join(',')}]`]);
        await other.disconnect(); await admin.disconnect(); await reads.close();
      }
    }, 60_000);

    describe('the freshness token holds over writes that commit nothing, and refuses every commit', () => {
      type Probe = { primary: BrainEngine; reads: ReturnType<typeof openReadSource>; watch: ReturnType<typeof createLsnWatch>; top: number; ids: Record<string, number>; check: (token: string) => Promise<{ vector: 'proven' | 'moved'; privacy: string }> };
      /** The primary, a read source and a check that asks the vector reference and the privacy question of a sample held to `token`. */
      const probing = async (fn: (p: Probe) => Promise<void>): Promise<void> => {
        const primary = ctx.primary();
        const chunkOf = await vectorFixture(primary);
        const ids = await privacyFixture(primary);
        const reads = openReadSource(primary);
        try {
          const watch = createLsnWatch(reads);
          const samples = new SampleRegistry();
          const args = encodeValue([vec(3), { limit: 10, excludePrivate: true }]);
          let clock = 0;
          const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => (clock += 120_000) }); // the reference's one-a-minute gate opens for each
          const check: Probe['check'] = async (token) => {
            const sid = samples.add({ op: 'searchVector', args, result: [], at: Date.now(), lsn: token }, 100);
            const vector = await handler({ id: 1, kind: 'vector', sid, phase: 'sample' }).then(() => 'proven' as const, (e: { code?: string }) => { if (e.code !== 'moved') throw e; return 'moved' as const; });
            const answer = await handler({ id: 2, kind: 'privacy', sid, phase: 'sample', rows: [{ payload: 'p', id: ids['open/a'] }] }) as { verdict: string };
            return { vector, privacy: answer.verdict };
          };
          await fn({ primary, reads, watch, top: chunkOf.get(3)!, ids, check });
        } finally { await reads.close(); }
      };
      /** An outcome that refused because the token moved: asked again from a new capture when it was an unrelated commit (harness `untilNotMoved`). */
      const unproven = (o: { vector: string; privacy: string }): boolean => o.vector === 'moved' || o.privacy === 'privacy_check_moved';
      const PROVEN: { vector: 'proven' | 'moved'; privacy: string } = { vector: 'proven', privacy: 'clean' };
      const MOVED: { vector: 'proven' | 'moved'; privacy: string } = { vector: 'moved', privacy: 'privacy_check_moved' };
      const literalOf = (seed: number): string => `[${Array.from(vec(seed)).join(',')}]`;
      const connectOther = async (database?: string) => {
        const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
        const other = new PostgresEngine();
        const url = new URL((ctx.primary() as unknown as { connectedDatabaseUrl?: string }).connectedDatabaseUrl!);
        if (database) url.pathname = `/${database}`;
        await other.connect({ engine: 'postgres', database_url: url.toString(), poolSize: 1 } as never);
        return other;
      };
      const restore = (primary: BrainEngine, top: number): Promise<unknown> => primary.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literalOf(3)]);

      test('a write that moves the WAL position but commits nothing between the capture and the check leaves the proof standing: a logical message, then a plain read', async () => {
        await probing(async ({ primary, watch, check }) => {
          const lsn = async (): Promise<string> => String((await primary.executeRaw<{ l: string }>('SELECT pg_current_wal_insert_lsn()::text AS l'))[0]!.l);
          const out = await untilNotMoved(async () => {
            const token = await watch.live();
            const before = await lsn();
            await primary.executeRaw(`SELECT pg_logical_emit_message(false, 't', 'x')`); // WAL, no transaction, no data
            expect(await lsn()).not.toBe(before); // the position moved
            return check(token);
          }, unproven);
          expect(out).toEqual(PROVEN); // and nothing the check judges did
        });
      });

      test('a read that prunes dead catalog rows (WAL with no transaction id) between the capture and the check leaves the proof standing', async () => {
        await probing(async ({ primary, watch, check }) => {
          const snapshot = async (): Promise<string> => String((await primary.executeRaw<{ s: string }>('SELECT pg_current_snapshot()::text AS s'))[0]!.s);
          const lsn = async (): Promise<string> => String((await primary.executeRaw<{ l: string }>('SELECT pg_current_wal_insert_lsn()::text AS l'))[0]!.l);
          let pruned = false;
          let moves = 0; // attempts an unrelated commit moved: asked again from a new capture, up to 5
          for (let attempt = 0; attempt < 12 && moves < 5 && !pruned; attempt++) { // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
            for (let i = 0; i < 3; i++) await primary.executeRaw('ANALYZE content_chunks'); // each one leaves the old statistics rows dead
            const token = await watch.live();
            const [l0, s0] = [await lsn(), await snapshot()];
            await primary.executeRaw('SELECT count(*) FROM pg_statistic'); // the read may prune the dead rows it finds: WAL, no xid
            if (await lsn() === l0) continue; // nothing was pruned this time: try again with more dead rows
            if (await snapshot() !== s0) { moves++; continue; } // a commit that is none of this test's moved the snapshot
            const out = await check(token); // the position moved and the snapshot did not
            if (unproven(out)) { moves++; continue; }
            expect(out).toEqual(PROVEN);
            pruned = true;
          }
          expect(pruned).toBe(true);
        });
      });

      test('a transaction that began before the capture, holds an xid below xmax and commits after it: the commit moves nothing but its own xid, which the token lists (Postgres only)', async () => {
        if (ctx.dialect !== 'postgres') return;
        await probing(async ({ primary, watch, check, top }) => {
          const run = async () => {
            const other = await connectOther();
            const began = gate(); const commit = gate();
            let xid = '';
            try {
              const writer = other.transaction(async (tx) => {
                await tx.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literalOf(90)]);
                xid = String((await tx.executeRaw<{ x: string }>('SELECT pg_current_xact_id()::text AS x'))[0]!.x);
                began.open(); await commit.wait;
              });
              await began.wait;
              for (let i = 0; i < 3; i++) await primary.executeRaw('SELECT pg_current_xact_id()'); // later transactions finish: xmax is now above the writer's xid
              const token = await watch.live();
              expect(BigInt(token.split('|')[0]!)).toBeGreaterThan(BigInt(xid));
              expect(token.split('|')[1]!.split(',')).toContain(xid); // listed: it is the only thing that can show its commit
              const before = await check(token); // not yet committed
              commit.open(); await writer;
              const xmaxNow = String((await primary.executeRaw<{ x: string }>('SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x'))[0]!.x);
              return { before, held: xmaxNow === token.split('|')[0]!, after: await check(token) }; // xmax did not move: only the list can see this commit
            } finally { commit.open(); await other.disconnect(); await restore(primary, top); }
          };
          const r = await untilNotMoved(run, (o) => unproven(o.before) || !o.held); // an unrelated commit moves xmax or the first check: the whole run again
          expect(r.before).toEqual(PROVEN);
          expect(r.held).toBe(true);
          expect(r.after).toEqual(MOVED);
        });
      }, 60_000);

      test('a subtransaction (SAVEPOINT) cannot become visible on its own: released while the top-level transaction runs it is still proven, and the top-level commit is what moves it (Postgres only)', async () => {
        if (ctx.dialect !== 'postgres') return;
        await probing(async ({ primary, watch, check, top }) => {
          const run = async () => {
            const other = await connectOther();
            const began = gate(); const released = gate(); const commit = gate(); const go = gate();
            try {
              const writer = other.transaction(async (tx) => {
                await tx.executeRaw(`UPDATE content_chunks SET modality = modality WHERE id = $1`, [top]); // the top-level xid
                began.open(); await go.wait;
                await tx.executeRaw('SAVEPOINT inner_work');
                await tx.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literalOf(91)]); // written under the subtransaction's own xid
                await tx.executeRaw('RELEASE SAVEPOINT inner_work'); // the subtransaction "commits" into its parent
                released.open(); await commit.wait;
              });
              await began.wait;
              const token = await watch.live();
              expect(token.split('|')[1]).not.toBe(''); // the top-level xid is listed (a subtransaction's xid never is)
              go.open(); await released.wait;
              const seen = await primary.executeRaw<{ e: string }>(`SELECT embedding::text AS e FROM content_chunks WHERE id = $1`, [top]);
              expect(seen[0]!.e).not.toBe(literalOf(91)); // the released subtransaction's write is not visible
              const before = await check(token);
              commit.open(); await writer;
              expect((await primary.executeRaw<{ e: string }>(`SELECT embedding::text AS e FROM content_chunks WHERE id = $1`, [top]))[0]!.e).toBe(literalOf(91));
              return { before, after: await check(token) };
            } finally { commit.open(); await other.disconnect(); await restore(primary, top); }
          };
          const r = await untilNotMoved(run, (o) => unproven(o.before)); // an unrelated commit moved the first check: the whole run again
          expect(r.before).toEqual(PROVEN);
          expect(r.after).toEqual(MOVED);
        });
      }, 60_000);

      test('a write in another database of the cluster that commits between the capture and the check counts as moved (Postgres only)', async () => {
        if (ctx.dialect !== 'postgres') return;
        await probing(async ({ primary, watch, check }) => {
          const other = await connectOther('postgres');
          try {
            await other.executeRaw('DROP TABLE IF EXISTS gbrain_token_probe');
            await other.executeRaw('CREATE TABLE gbrain_token_probe (x int)');
            const r = await untilNotMoved(async () => {
              const token = await watch.live();
              const control = await check(token); // control: nothing committed anywhere
              await other.executeRaw('INSERT INTO gbrain_token_probe VALUES (1)');
              return { control, after: await check(token) };
            }, (o) => unproven(o.control)); // an unrelated commit moved the control: the whole run again
            expect(r.control).toEqual(PROVEN);
            expect(r.after).toEqual(MOVED);
          } finally { await other.executeRaw('DROP TABLE IF EXISTS gbrain_token_probe').catch(() => undefined); await other.disconnect(); }
        });
      });

      test('COMMIT PREPARED between the capture and the check: a transaction prepared before the capture blinds the token, one prepared after it is listed by its xid (Postgres with max_prepared_transactions > 0 only)', async () => {
        if (ctx.dialect !== 'postgres') return;
        const allowed = Number((await ctx.primary().executeRaw<{ n: string }>(`SELECT current_setting('max_prepared_transactions') AS n`))[0]!.n);
        if (allowed === 0) { console.warn('skipped: this cluster has max_prepared_transactions = 0'); return; }
        await probing(async ({ primary, watch, check, top }) => {
          const other = await connectOther();
          const gid = `gbrain_token_${process.pid}`;
          try {
            // prepared after the capture: the transaction began before it, so its xid is in the token
            await other.executeRaw('BEGIN');
            await other.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literalOf(92)]);
            const token = await watch.live();
            expect(token.split('|')[1]).not.toBe('');
            await other.executeRaw(`PREPARE TRANSACTION '${gid}'`);
            expect(await check(token)).toEqual(MOVED); // prepared: never proven
            await other.executeRaw(`COMMIT PREPARED '${gid}'`);
            expect(await check(token)).toEqual(MOVED); // committed: its xid, listed in the token, has committed
            await restore(primary, top);
            // prepared before the capture: blind, and still refused once it is committed
            await other.executeRaw('BEGIN');
            await other.executeRaw(`UPDATE content_chunks SET embedding = $2::vector WHERE id = $1`, [top, literalOf(93)]);
            await other.executeRaw(`PREPARE TRANSACTION '${gid}'`);
            const blind = await watch.live();
            expect(blind.split('|')[1]).toBe('!');
            await other.executeRaw(`COMMIT PREPARED '${gid}'`);
            expect(await check(blind)).toEqual(MOVED);
            expect(await untilNotMoved(async () => check(await watch.live()), unproven)).toEqual(PROVEN); // control: a fresh token, nothing prepared
          } finally {
            await primary.executeRaw(`ROLLBACK PREPARED '${gid}'`).catch(() => undefined);
            await other.executeRaw('ROLLBACK').catch(() => undefined);
            await other.disconnect(); await restore(primary, top);
          }
        });
      }, 60_000);
    });

    test('a session of another role that the reading role cannot see into makes the token blind, and a blind token is never proven (Postgres only)', async () => {
      if (ctx.dialect !== 'postgres') return;
      const primary = ctx.primary();
      await vectorFixture(primary);
      const url = (primary as unknown as { connectedDatabaseUrl?: string }).connectedDatabaseUrl!;
      const role = `a2_blind_${process.pid}`;
      const secret = (await import('node:crypto')).randomUUID();
      const drop = async (): Promise<void> => { await primary.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined); await primary.executeRaw(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); };
      await drop();
      await primary.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD '${secret}'`);
      await primary.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await primary.executeRaw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const asRoleEngine = new PostgresEngine();
      let reads: ReturnType<typeof openReadSource> | undefined;
      try {
        const asRole = new URL(url);
        Object.assign(asRole, { username: role, password: secret });
        await asRoleEngine.connect({ engine: 'postgres', database_url: asRole.toString(), poolSize: 1 } as never);
        reads = openReadSource(asRoleEngine as never); // the shadow's reads, as a role that is not a superuser and not in pg_read_all_stats; the superuser pool of the brain is another role's session
        const watch = createLsnWatch(reads);
        const token = await watch.live();
        expect(token.split('|')[1]).toBe('!');
        const samples = new SampleRegistry();
        const sid = samples.add({ op: 'searchVector', args: encodeValue([vec(3), { limit: 10 }]), at: Date.now(), lsn: token }, 100); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        let clock = 0;
        const handler = makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => (clock += 120_000) });
        await expect(handler({ id: 1, kind: 'vector', sid, phase: 'sample' })).rejects.toMatchObject({ code: 'moved' });
      } finally { await reads?.close(); await asRoleEngine.disconnect().catch(() => undefined); await drop(); }
    }, 60_000);

    test('a prepared (two-phase) transaction at the capture, or at the end of the check, is never proven: the token is blind and the reference is refused (the capture rows are stubbed: the test cluster has max_prepared_transactions = 0)', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const real = openReadSource(primary);
      let prepared = 0; // what pg_prepared_xacts would count
      const stubbed = { ...real, read: <T>(fn: Parameters<typeof real.read<T>>[0]) => real.read((tx, q) => fn(new Proxy(tx, { get: (t, p) => (p === 'executeRaw' ? async (text: string, ...a: never[]) => {
        const out = await (t.executeRaw as Function).call(t, text, ...a) as Array<Record<string, unknown>>;
        if (!text.includes('pg_prepared_xacts')) return out;
        return out.map((r) => ('prepared' in r ? { ...r, prepared: typeof r.prepared === 'boolean' ? prepared > 0 : prepared } : r)); // the capture row counts them, the end-of-check row says whether any exist
      } : Reflect.get(t, p, t)) }) as BrainEngine, q)) };
      try {
        const watch = createLsnWatch(stubbed);
        const samples = new SampleRegistry();
        const args = encodeValue([vec(3), { limit: 10 }]);
        let clock = 0;
        const handler = makeAskHandler({ engine: primary, reads: stubbed, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => (clock += 120_000) });
        // a prepared transaction exists at the capture: the token is blind, and a blind token is never proven
        prepared = 1;
        const blind = await watch.live();
        expect(blind.split('|')[1]).toBe('!');
        const a = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: blind }, 100);
        await expect(handler({ id: 1, kind: 'vector', sid: a, phase: 'sample' })).rejects.toMatchObject({ code: 'moved' });
        // none at the capture, one at the end of the check: refused as well
        prepared = 0;
        const clear = await watch.live();
        expect(clear.split('|')[1]).not.toBe('!');
        const b = samples.add({ op: 'searchVector', args, at: Date.now(), lsn: clear }, 100);
        const during = handler({ id: 2, kind: 'vector', sid: b, phase: 'sample' });
        prepared = 1; // a transaction is prepared while the reference runs
        await expect(during).rejects.toMatchObject({ code: 'moved' });
        // control: none at either end, the reference is used
        prepared = 0;
        expect(await untilNotMoved(async () => handler({ id: 3, kind: 'vector', sid: samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100), phase: 'sample' }))).toBeInstanceOf(Array);
      } finally { await real.close(); }
    });

    test('a server in recovery (a hot standby) never proves fresh: the token is blind at the capture and the end of the check refuses (pg_is_in_recovery is stubbed: this cluster is a primary)', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const real = openReadSource(primary);
      let recovering = false;
      const stubbed = { ...real, read: <T>(fn: Parameters<typeof real.read<T>>[0]) => real.read((tx, q) => fn(new Proxy(tx, { get: (t, p) => (p === 'executeRaw' ? async (text: string, ...a: never[]) => {
        const out = await (t.executeRaw as Function).call(t, text, ...a) as Array<Record<string, unknown>>;
        return out.map((r) => ('recovery' in r ? { ...r, recovery: recovering } : r)); // the capture row and the end-of-check row both say whether the server is in recovery
      } : Reflect.get(t, p, t)) }) as BrainEngine, q)) };
      try {
        const watch = createLsnWatch(stubbed);
        const samples = new SampleRegistry();
        const args = encodeValue([vec(3), { limit: 10 }]);
        let clock = 0;
        const handler = makeAskHandler({ engine: primary, reads: stubbed, dir: '/none', samples, rpc: (async () => ({})) as never, watch, now: () => (clock += 120_000) });
        recovering = true; // a standby: replayed writers are in no list, so nothing it says about its own xmax proves anything
        const blind = await watch.live();
        expect(blind.split('|')[1]).toBe('!');
        await expect(handler({ id: 1, kind: 'vector', sid: samples.add({ op: 'searchVector', args, at: Date.now(), lsn: blind }, 100), phase: 'sample' })).rejects.toMatchObject({ code: 'moved' });
        recovering = false; // a token taken on a primary, a server that is in recovery at the end of the check: refused as well
        const clear = await watch.live();
        expect(clear.split('|')[1]).not.toBe('!');
        const during = handler({ id: 2, kind: 'vector', sid: samples.add({ op: 'searchVector', args, at: Date.now(), lsn: clear }, 100), phase: 'sample' });
        recovering = true;
        await expect(during).rejects.toMatchObject({ code: 'moved' });
        recovering = false; // control: a primary at both ends
        expect(await untilNotMoved(async () => handler({ id: 3, kind: 'vector', sid: samples.add({ op: 'searchVector', args, at: Date.now(), lsn: await watch.live() }, 100), phase: 'sample' }))).toBeInstanceOf(Array);
      } finally { await real.close(); }
    });

    test('the reference has no candidate window: boosted true top results beyond the engine\'s window are found, and the windowed search misses them', async () => {
      const primary = ctx.primary();
      const unit = (v: Float32Array): Float32Array => { let n = 0; for (const x of v) n += x * x; return v.map((x) => x / Math.sqrt(n)); };
      const mix = (a: number, seed: number): Float32Array => { const [u, r] = [unit(vec(3)), unit(vec(seed))]; return Float32Array.from(u, (x, i) => a * x + Math.sqrt(1 - a * a) * r[i]!); };
      const add = async (slug: string, embedding: Float32Array): Promise<void> => {
        await primary.putPage(slug, { type: 'note', title: slug, compiled_truth: `window ${slug}`, timeline: '' });
        await installFixtureChunks(primary, slug, [{ chunk_index: 0, chunk_text: `window ${slug}`, chunk_source: 'compiled_truth', embedding, model: MODEL, token_count: 3 }]);
      };
      const reads = openReadSource(primary);
      try {
        // 262 pages the query resembles (cosine 0.9 down to 0.5) and 12 it barely resembles (0.3) that the source boost lifts to the top
        for (let i = 0; i < 262; i++) await add(`win/n${i}`, mix(0.9 - i * 0.0015, 1000 + i));
        for (let i = 0; i < 12; i++) await add(`boost/b${i}`, mix(0.3, 2000 + i)); // pregate-literal: SHADOW_ADAPTER_VERSION=12 an unrelated 12 (a count, size or id), not the adapter version
        const boosted = new Set((await primary.executeRaw<{ id: number }>(`SELECT c.id FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug LIKE 'boost/%'`)).map((r) => String(r.id)));
        const opts = { limit: 10, source_boosts: { 'boost/': 5 } };
        const samples = new SampleRegistry();
        const reference = await untilNotMoved(async () => makeAskHandler({ engine: primary, reads, dir: '/none', samples, rpc: (async () => ({})) as never })({ id: 1, kind: 'vector', sid: samples.add({ op: 'searchVector', args: encodeValue([vec(3), opts]), at: Date.now(), lsn: await createLsnWatch(reads).live() }, 100) }) as Promise<RankedKey[]>); // asked again from a new capture when an unrelated commit moved it
        // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        expect(reference.slice(0, 10).filter((r) => boosted.has(r.k))).toHaveLength(10); // the true top ten, all beyond the raw-similarity window
        const windowed = await primary.searchVector(vec(3), { ...opts, limit: 50 });
        // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        expect(windowed.slice(0, 10).filter((r) => boosted.has(String(r.chunk_id))).length).toBeLessThan(10); // the engine's candidate window never saw them
      } finally {
        await reads.close();
        await primary.executeRaw(`DELETE FROM pages WHERE slug LIKE 'win/%' OR slug LIKE 'boost/%'`);
      }
    }, 180_000);

    test('with index and bitmap scans off the statements cannot use the HNSW index, and the settings survive a searchVector call in the same transaction', async () => {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const nodes = (p: { 'Node Type'?: string; 'Index Name'?: string; Plans?: unknown[] }, out: string[] = []): string[] => { out.push(`${p['Node Type']}:${p['Index Name'] ?? ''}`); for (const c of p.Plans ?? []) nodes(c as never, out); return out; };
      const stmt = buildVectorSearchStatement({ dialect: ctx.dialect, embedding: vec(3), limit: 10, offset: 0, opts: { limit: 10 } as never, scope: undefined as never }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
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
      const { rig, epoch } = await untilNotMoved(async () => { // the whole read again with a new child when an unrelated commit kept every run of the first from being scored
        const rig = await start();
        // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        rig.rust.searchVector = async () => [...full.slice(0, 9), full[10]]; // Rust misses the tenth true neighbour and returns the eleventh
        await rig.engine.searchVector(vec(3), { limit: 10 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
        const epoch = readEpoch(rig.dir)?.epoch_id ?? (await until(() => readEpoch(rig.dir) !== null), readEpoch(rig.dir)!.epoch_id);
        const scored = await until(() => (readEpochRecall(rig.dir, epoch)?.length ?? 0) === 1).then(() => true, () => false);
        return { rig, epoch, scored };
      }, (r) => !r.scored);
      await rig.engine.searchVector(vec(3), { limit: 10 }); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
      await sleep(300);
      expect(readEpochRecall(rig.dir, epoch)).toMatchObject([{ vector: 0.9, primary: 1, ref_size: 10 }]); // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
    });
  });
}
