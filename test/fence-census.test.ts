/**
 * #6188 PR3 fence census (`src/core/fence-repair/census.ts`, `census-store.ts`).
 *
 * Protects: the candidate finder sees every malformed facts or takes fence
 * once (an `invalid_fence` hold, a stored page, an unsynced working-tree
 * file), with its planned tier, bound to the bytes it judged and location
 * only; the DB scan's watermark never skips a page whose transaction
 * committed after a pass that started later than its `updated_at`; the
 * one-time backfill and the file walk resume across deadlines instead of
 * restarting, so damage beyond several deadlines is found; a later walk reads
 * only changed, untracked and stored files; census, candidate and attempt
 * rows survive the 7-day purge while their source incarnation lives; the
 * normalization trend counts a resumed sync run and a replayed write once.
 * Fails when: the watermark advances to the pass start (late commits lost),
 * a cursor restarts at the prefix, dedup counts a page twice, a finding keeps
 * cell text, or the purge drops live census state.
 * Seams: a ticking clock for deadlines; PGLite always, Postgres through
 * test/e2e/fence-census-postgres.test.ts (a second session holds a real open
 * transaction). Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { FENCE_REPAIR_ATTEMPT_OP } from '../src/core/fence-repair/attempts.ts';
import { listFenceCandidates, runFenceCensus, summarizeFenceCensus } from '../src/core/fence-repair/census.ts';
import {
  FENCE_CANDIDATE_OP, FENCE_SCAN_OP, FENCE_TREND_OP, readScanRecord, readTrend, recordPublicationFenceTrend, recordSyncRunTrend,
} from '../src/core/fence-repair/census-store.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const FB = '<!--- gbrain:facts:begin -->', FE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const FS = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
// Unique strings that must never leave the page: a claim, a holder and a kind.
const CLAIM = 'Sentinelclaimzq8 ships quarterly', HOLDER = 'Sentinelholderzq8 Example', KIND = 'sentinelkindzq8';
const SECRETS = [CLAIM, HOLDER, KIND, 'Sentinelclaimzq8', 'Sentinelholderzq8'];
const factsRow = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2026-01-01 |  | call |  |`;
/** Missing end marker after the table: Tier 1 closes it (deterministic). */
const DETERMINISTIC = ['## Facts', '', FB, FH, FS, factsRow(1, 'Synthetic fact'), factsRow(2, 'Second synthetic fact'), '', ''].join('\n');
/** A display-name holder: the resolver tier. */
const RESOLVER = `${T}\n${TH}\n| 1 | ${CLAIM} | take | ${HOLDER} | 0.7 | 2026-01 | chat |\n${TE}\n`;
/** A takes kind gbrain never chooses: a manual edit. */
const MANUAL = `${T}\n${TH}\n| 1 | Synthetic take | ${KIND} | brain | 0.7 | 2026-01 | chat |\n${TE}\n`;
/** Rows with no header: the model tier. */
const LLM = ['## Facts', '', FB, factsRow(1, 'Synthetic fact'), factsRow(2, 'Another synthetic fact'), FE, ''].join('\n');
const CLEAN = ['## Facts', '', FB, FH, FS, factsRow(1, 'Clean synthetic fact'), FE, ''].join('\n');
const md = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}`;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const roots: string[] = [];

/** A deterministic clock that moves `step` ms on every read, so deadlines stop scans after a fixed amount of work. */
function ticking(step = 1) {
  let t = Date.parse('2026-10-06T12:00:00Z');
  return { now: () => new Date(t += step), at: () => t };
}

for (const backend of backends) {
  describe(`${backend}: fence census`, () => {
    let engine: BrainEngine;
    let second: PostgresEngine | undefined;
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
        return;
      }
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine;
      second = new PostgresEngine();
      await second.connect({ database_url: pg.databaseUrl, poolSize: 2 });
      close = async () => { await second!.disconnect(); await pg.close(); };
    }, 120_000);

    afterAll(async () => { await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

    async function source(files: Record<string, string> | null, opts: { git?: boolean } = {}) {
      const id = `cen-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const root = files ? mkdtempSync(join(tmpdir(), 'fence-census-')) : null;
      const write = (path: string, content: string) => { mkdirSync(join(root!, path, '..'), { recursive: true }); writeFileSync(join(root!, path), content); };
      const commit = () => { git(root!, 'add', '-A'); git(root!, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root!, 'rev-parse', 'HEAD'); };
      if (root) {
        roots.push(root);
        for (const [path, content] of Object.entries(files!)) write(path, content);
        if (opts.git !== false) { git(root, 'init', '-q'); commit(); }
      }
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
      const stored = (slug: string, body: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' }, { sourceId: id });
      const census = (extra: Partial<Parameters<typeof runFenceCensus>[1]> = {}) => runFenceCensus(engine, { sourceIds: [id], deadline: Date.now() + 120_000, ...extra });
      const keys = async () => (await listFenceCandidates(engine, [id])).map(c => c.key);
      return { id, root: root!, incarnation, write, commit, stored, census, keys };
    }

    const expectNoSecrets = (text: string) => { for (const secret of SECRETS) expect(text).not.toContain(secret); };

    test('holds, stored pages and files are found once each, tiered, bound to their bytes and location-only', async () => {
      const s = await source({ 'notes/det.md': md('Det', DETERMINISTIC), 'notes/both.md': md('Both', RESOLVER), 'notes/held.md': md('Held', MANUAL),
        'notes/clean.md': md('Clean', CLEAN), 'notes/model.md': md('Model', LLM) });
      await s.stored('notes/both', RESOLVER);
      await s.stored('notes/stored-only', DETERMINISTIC);
      await s.stored('notes/clean', CLEAN);
      const observed = new Date().toISOString();
      await engine.transaction(tx => writeGitHold(tx, { source_id: s.id, incarnation: s.incarnation, path: 'notes/held.md', source_path: 'notes/held.md', slug: 'notes/held',
        page_id: null, code: 'invalid_fence', message: 'Fence takes_kind_unsupported: in the takes fence (body), row 1, column kind.', upstream_version: 'v1',
        observed_at: observed, run_id: 'run-1', mode: 'managed',
        meta: { reason: 'takes_kind_unsupported', recovery_version: 1, fence_version: 1,
          fence: { reason: 'takes_kind_unsupported', fence: 'takes', section: 'body', rows: [1], columns: ['kind'], line: 4 } } }));

      expect(await s.census()).toEqual([{ source_id: s.id, complete: true, fresh_at: expect.any(String), backfill_done: true, pages_caught_up: true, files: 'done' }]);
      const list = await listFenceCandidates(engine, [s.id]);
      expect(list.map(c => [c.key, c.bucket, c.origins, c.tier])).toEqual([
        ['notes/both', 'page', ['page', 'file'], 'resolver'],
        ['notes/det', 'file', ['file'], 'deterministic'],
        ['notes/held', 'hold', ['hold', 'file'], 'manual'],
        ['notes/model', 'file', ['file'], 'llm'],
        ['notes/stored-only', 'page', ['page'], 'deterministic'],
      ]);
      const both = list.find(c => c.key === 'notes/both')!;
      expect(both).toMatchObject({ reasons: ['holder_unresolved'], location: { fence: 'takes', section: 'body', rows: [1], columns: ['who'] }, path: 'notes/both.md' });
      expect(both.bound.page_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(both.bound.file_sha256).toBe(sha256(md('Both', RESOLVER)));
      expect(typeof both.bound.updated_at).toBe('string');
      expect(list.find(c => c.key === 'notes/held')!).toMatchObject({ path: 'notes/held.md', bound: { upstream_version: 'v1' } });

      const [census] = await summarizeFenceCensus(engine, [s.id]);
      expect(census).toMatchObject({ source_id: s.id, total: 5, holds: { manual: 1, total: 1 }, pages: { resolver: 1, deterministic: 1, total: 2 },
        files: { deterministic: 1, llm: 1, total: 2 }, by_tier: { deterministic: 2, resolver: 1, llm: 1, manual: 1, total: 5 },
        scan: { complete: true, backfill_done: true, walking: false } });
      expect(census!.oldest_hold_at).toBeTruthy();

      // Fixing the file and the stored copy clears both parts; the stored-only page stays.
      s.write('notes/both.md', md('Both', CLEAN)); s.commit();
      await s.stored('notes/both', CLEAN);
      await s.census();
      expect(await s.keys()).toEqual(['notes/det', 'notes/held', 'notes/model', 'notes/stored-only']);

      const rows = await engine.executeRaw<{ completed_keys: unknown }>('SELECT completed_keys FROM op_checkpoints WHERE op=ANY($1::text[]) AND fingerprint LIKE $2',
        [[FENCE_CANDIDATE_OP, FENCE_SCAN_OP], `${s.id}:%`]);
      for (const blob of [JSON.stringify(rows), JSON.stringify(list), JSON.stringify(await summarizeFenceCensus(engine, [s.id]))]) expectNoSecrets(blob);
    }, 60_000);

    test('the incremental pass reads pages updated since the watermark, including a late commit older than the previous pass', async () => {
      const s = await source(null);
      for (const slug of ['notes/a', 'notes/b', 'notes/c']) await s.stored(slug, CLEAN);
      expect((await s.census())[0]).toMatchObject({ complete: true, files: 'none' });
      expect(await s.keys()).toEqual([]);

      await s.stored('notes/a', DETERMINISTIC);
      await s.census();
      expect(await s.keys()).toEqual(['notes/a']);

      // A transaction that set updated_at before the previous pass started and committed after it ended.
      const { watermark } = (await readScanRecord(engine, s.id, s.incarnation))!.pages;
      const [late] = await engine.executeRaw<{ before_now: boolean }>(`UPDATE pages SET compiled_truth=$1, updated_at=$2::timestamptz + interval '90 seconds'
        WHERE source_id=$3 AND slug='notes/b' RETURNING updated_at < now() - interval '1 second' AS before_now`, [RESOLVER, watermark, s.id]);
      expect(late!.before_now).toBe(true);
      await s.census();
      expect(await s.keys()).toEqual(['notes/a', 'notes/b']);

      await s.stored('notes/a', CLEAN);
      await engine.executeRaw('UPDATE pages SET deleted_at=now(), updated_at=now() WHERE source_id=$1 AND slug=$2', [s.id, 'notes/b']);
      await s.census();
      expect(await s.keys()).toEqual([]);
    }, 60_000);

    if (backend === 'postgres') {
      test('a writer transaction open during a pass is read after it commits, with no grace period', async () => {
        const s = await source(null);
        await s.stored('notes/late', CLEAN);
        await s.census({ lateCommitGraceMs: 0 });
        let release!: () => void;
        let updated!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const wrote = new Promise<void>(resolve => { updated = resolve; });
        const writer = second!.transaction(async tx => {
          await tx.executeRaw('UPDATE pages SET compiled_truth=$1, updated_at=now() WHERE source_id=$2 AND slug=$3', [MANUAL, s.id, 'notes/late']);
          updated();
          await gate;
        });
        await wrote;
        await new Promise(resolve => setTimeout(resolve, 50));
        await s.census({ lateCommitGraceMs: 0 });
        expect(await s.keys()).toEqual([]);
        release();
        await writer;
        await s.census({ lateCommitGraceMs: 0 });
        expect(await s.keys()).toEqual(['notes/late']);
      }, 60_000);
    }

    test('the backfill resumes across deadlines and finds damage past several of them', async () => {
      const s = await source(null);
      for (let i = 0; i < 30; i++) await s.stored(`notes/p-${String(i).padStart(2, '0')}`, CLEAN);
      await s.stored('notes/z-late', LLM);
      const clock = ticking();
      const progress: number[] = [];
      let partial = 0;
      for (let run = 0; run < 60; run++) {
        const [result] = await s.census({ now: clock.now, deadline: clock.at() + 6, batchSize: 4 });
        const record = (await readScanRecord(engine, s.id, s.incarnation))!;
        if (result!.complete) break;
        partial++;
        expect((await summarizeFenceCensus(engine, [s.id]))[0]!.scan.complete).toBe(false);
        progress.push(record.pages.backfill.done ? Number.MAX_SAFE_INTEGER : record.pages.backfill.after_id);
      }
      expect(partial).toBeGreaterThanOrEqual(3);
      // Never restarted: every partial run ended further along than the last.
      for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
      expect(new Set(progress).size).toBeGreaterThanOrEqual(3);
      expect(await s.keys()).toEqual(['notes/z-late']);
    }, 120_000);

    test('the file walk resumes from its cursor across several deadlines and finds damage past them', async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 24; i++) files[`notes/a-${String(i).padStart(2, '0')}.md`] = md(`A${i}`, CLEAN);
      files['notes/z-one.md'] = md('Z1', DETERMINISTIC);
      files['notes/z-two.md'] = md('Z2', MANUAL);
      const s = await source(files);
      const clock = ticking();
      const cursors: string[] = [];
      let partial = 0;
      for (let run = 0; run < 60; run++) {
        const [result] = await s.census({ now: clock.now, deadline: clock.at() + 12 });
        if (result!.complete) break;
        partial++;
        const pass = (await readScanRecord(engine, s.id, s.incarnation))!.files?.pass;
        if (pass?.after) cursors.push(pass.after);
        expect((await summarizeFenceCensus(engine, [s.id]))[0]!.scan).toMatchObject({ complete: false });
      }
      expect(partial).toBeGreaterThanOrEqual(3);
      expect(cursors.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < cursors.length; i++) expect(cursors[i]! > cursors[i - 1]!).toBe(true);
      expect(await s.keys()).toEqual(['notes/z-one', 'notes/z-two']);
      expect((await readScanRecord(engine, s.id, s.incarnation))!.files).toMatchObject({ pass: null, walked: { commit: git(s.root, 'rev-parse', 'HEAD') } });
    }, 120_000);

    test('after the first walk, changed, untracked and deleted files are read again', async () => {
      const s = await source({ 'notes/one.md': md('One', CLEAN), 'notes/two.md': md('Two', CLEAN), 'notes/gone.md': md('Gone', DETERMINISTIC) });
      await s.census();
      expect(await s.keys()).toEqual(['notes/gone']);
      s.write('notes/one.md', md('One', RESOLVER));
      unlinkSync(join(s.root, 'notes/gone.md'));
      const head = s.commit();
      s.write('notes/fresh.md', md('Fresh', DETERMINISTIC));
      s.write('notes/two.md', md('Two', MANUAL));
      await s.census();
      expect(await s.keys()).toEqual(['notes/fresh', 'notes/one', 'notes/two']);
      expect((await readScanRecord(engine, s.id, s.incarnation))!.files!.walked!.commit).toBe(head);

      const plain = await source({ 'notes/old.md': md('Old', CLEAN) }, { git: false });
      await plain.census();
      expect(await plain.keys()).toEqual([]);
      plain.write('notes/new.md', md('New', LLM));
      await plain.census();
      expect(await plain.keys()).toEqual(['notes/new']);
    }, 60_000);

    test('a source with nothing to scan stores nothing, so an empty brain stays empty (graduation target check)', async () => {
      const s = await source(null);
      const runs = await s.census();
      expect(runs).toMatchObject([{ source_id: s.id, complete: true, files: 'none' }]);
      expect(await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE fingerprint LIKE $1', [`${s.id}:%`])).toEqual([]);
      expect((await summarizeFenceCensus(engine, [s.id], runs))[0]!.scan).toMatchObject({ complete: true });
      expect((await summarizeFenceCensus(engine, [s.id]))[0]!.scan).toMatchObject({ complete: false });
      // Once it holds a page, its cursors are kept so later runs scan incrementally.
      await s.stored('notes/one', CLEAN);
      await s.census();
      expect((await readScanRecord(engine, s.id, s.incarnation))!.census).toMatchObject({ complete: true });
    }, 60_000);

    test('census, candidate and attempt rows survive the 7-day purge while their source incarnation lives; trend rows age out', async () => {
      const s = await source(null);
      const dead = randomUUID();
      const insert = (op: string, fingerprint: string, incarnation: string) => engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
        VALUES($1,$2,$3::text::jsonb,now() - interval '10 days')`, [op, fingerprint, JSON.stringify([{ source_id: s.id, incarnation, day: '2026-01-01', count: 1 }])]);
      for (const op of [FENCE_CANDIDATE_OP, FENCE_SCAN_OP, FENCE_REPAIR_ATTEMPT_OP]) {
        await insert(op, `${s.id}:${s.incarnation}:live`, s.incarnation);
        await insert(op, `${s.id}:${dead}:dead`, dead);
      }
      await insert(FENCE_TREND_OP, `${s.id}:run:old`, s.incarnation);
      await purgeStaleCheckpoints(engine);
      const left = await engine.executeRaw<{ op: string; fingerprint: string }>('SELECT op, fingerprint FROM op_checkpoints WHERE fingerprint LIKE $1 ORDER BY op, fingerprint', [`${s.id}:%`]);
      expect(left).toEqual([FENCE_CANDIDATE_OP, FENCE_REPAIR_ATTEMPT_OP, FENCE_SCAN_OP].sort().map(op => ({ op, fingerprint: `${s.id}:${s.incarnation}:live` })));
    }, 60_000);

    test('the trend counts a resumed sync run and a replayed page write once, and skips per-file sync outcomes', async () => {
      const s = await source(null);
      await recordSyncRunTrend(engine, { sourceId: s.id, runId: 'run-1', day: '2026-10-05', count: 3, byClass: { close_fence: 3 }, writers: { 'notes/': 3 } });
      await recordSyncRunTrend(engine, { sourceId: s.id, runId: 'run-1', day: '2026-10-06', count: 5, byClass: { close_fence: 4, renumber: 1 }, writers: { 'notes/': 5 } });
      const row = { id: randomUUID(), source_id: s.id, principal_kind: 'local_cli' };
      const at = new Date('2026-10-06T10:00:00Z');
      await recordPublicationFenceTrend(engine, row, { fences_normalized: { count: 1, by_class: { renumber: 1 } } }, at);
      await recordPublicationFenceTrend(engine, row, { fences_normalized: { count: 1, by_class: { renumber: 1 } } }, at);
      await recordPublicationFenceTrend(engine, { ...row, id: randomUUID() }, { fences_normalized: [{ class: 'renumber' }] }, at);
      await recordPublicationFenceTrend(engine, { ...row, id: randomUUID() }, { status: 'imported' }, at);
      expect((await readTrend(engine, [s.id], '2026-09-30')).get(s.id)).toEqual([
        { day: '2026-10-05', count: 5, by_class: { close_fence: 4, renumber: 1 }, writers: { 'notes/': 5 } },
        { day: '2026-10-06', count: 1, by_class: { renumber: 1 }, writers: { local_cli: 1 } },
      ]);
      expect((await readTrend(engine, [s.id], '2026-10-06')).get(s.id)!.map(day => day.day)).toEqual(['2026-10-06']);
    }, 60_000);
  });
}
