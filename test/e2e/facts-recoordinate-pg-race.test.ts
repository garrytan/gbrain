/**
 * Provenance re-coordinate operator — REAL PostgreSQL concurrency proofs
 * (bp-u49.4.4.7, round-6). DATABASE_URL-gated: skips cleanly without a real
 * Postgres, and MUST show actual passes (not skips) when run against a disposable
 * test DB (see scripts/run-recoordinate-pg-race.sh).
 *
 * Two INDEPENDENT sessions (two PostgresEngine pools) + deterministic barriers
 * prove the `FOR UPDATE` marker-lock ordering that PGLite (single in-process
 * connection, no cross-session row-lock blocking) cannot exercise:
 *
 *   (1) published_verified engine adoption preserves the original fact id,
 *       creates zero new rows, and applies the marker exactly once;
 *   (2) adoption-first: a concurrent rollback BLOCKS on the locked marker, then
 *       LOSES its journal CAS after adoption commits `applied` — so it restores
 *       and pushes NOTHING (evidence for the now-coordinated fact is preserved);
 *   (3) rollback-first: adoption then finds the marker terminal, DECLINES, and
 *       the orphan is left uncoordinated.
 *
 * The barrier in (2) uses the seam's EXACT sql (SELECT … FOR UPDATE the marker →
 * guarded coordinate → applied CAS) held open inside one session's transaction
 * while the other session's rollback contends for the same row.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  revalidate, insertPendingMarker, rollbackPublished, GUARDED_COORDINATE_UPDATE,
  normalizeClaim, normalizeSource, type Durability,
} from '../../src/core/facts/recoordinate.ts';
import { upsertFactRow } from '../../src/core/facts-fence.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describePg = DATABASE_URL ? describe : describe.skip;

function g(wr: string, a: string[]): string { return execFileSync('git', ['-C', wr, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const FENCE_FILE = [
  '---', 'type: person', 'title: Alice Example', '---', '',
  '# Alice Example', '', '## Facts', '',
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| 1 | Existing row | fact | 0.9 | world | medium |  |  | mcp:put_page |  |',
  '<!--- gbrain:facts:end -->', '',
].join('\n');

const PSLUG = 'people/alice-example', PCLAIM = 'Alice raised a seed round', PSRC = 'mcp:put_page';

describePg('provenance re-coordinate — PostgreSQL FOR UPDATE race proofs', () => {
  let engineA: PostgresEngine, engineB: PostgresEngine;
  let dir = '', bare = '';

  const dur: Durability = {
    isHardened: () => true,
    commitAndPush: async (fp, wr) => {
      g(wr, ['add', '--', fp]);
      let staged = false;
      try { g(wr, ['diff', '--cached', '--quiet', '--', fp]); } catch { staged = true; }
      if (staged) g(wr, ['commit', '-q', '-m', 'recoordinate']);
      g(wr, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      return { commitId: g(wr, ['rev-parse', 'HEAD']), ref: 'main' };
    },
    currentRemoteFileHash: async (wr, ref, fp) => {
      try { g(wr, ['fetch', '-q', 'origin', ref]); return sha(execFileSync('git', ['-C', wr, 'show', `origin/${ref}:${relative(wr, fp)}`], { encoding: 'utf8' })); } catch { return null; }
    },
  };

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!); // refuse anything not a *_test DB
    engineA = new PostgresEngine(); await engineA.connect({ database_url: DATABASE_URL!, poolSize: 4 });
    await engineA.initSchema();
    engineB = new PostgresEngine(); await engineB.connect({ database_url: DATABASE_URL!, poolSize: 4 }); // independent session/pool
  }, 120_000);

  afterAll(async () => { await engineA?.disconnect(); await engineB?.disconnect(); });

  afterEach(async () => {
    await engineA.executeRaw(`DELETE FROM fact_recoordinations`);
    await engineA.executeRaw(`DELETE FROM facts`);
    await engineA.executeRaw(`DELETE FROM pages WHERE source_id <> 'default'`);
    await engineA.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
    for (const d of [dir, bare]) if (d) rmSync(d, { recursive: true, force: true });
    dir = ''; bare = '';
  });

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await engineA.executeRaw<{ n: number }>(sql, params))[0].n);
  }
  async function factCoord(id: string): Promise<{ row_num: number | null; slug: string | null }> {
    const r = (await engineA.executeRaw<{ row_num: number | null; slug: string | null }>(
      `SELECT row_num, source_markdown_slug AS slug FROM facts WHERE id = $1`, [id]))[0];
    return { row_num: r.row_num == null ? null : Number(r.row_num), slug: r.slug == null ? null : String(r.slug) };
  }
  async function marker(id: string): Promise<{ status: string; phase: string }> {
    return (await engineA.executeRaw<{ status: string; phase: string }>(`SELECT status, phase FROM fact_recoordinations WHERE id = $1`, [id]))[0];
  }

  const SID = 'rc';
  /** Seed a source tree + git remote + page + live orphan fact. */
  async function seed(): Promise<{ orphan: string; filePath: string }> {
    dir = mkdtempSync(join(tmpdir(), 'rcpg-')); bare = mkdtempSync(join(tmpdir(), 'rcpgb-'));
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    g(dir, ['init', '-q', '-b', 'main']); g(dir, ['config', 'user.email', 't@t.co']); g(dir, ['config', 'user.name', 't']);
    mkdirSync(join(dir, 'people'), { recursive: true });
    const filePath = join(dir, `${PSLUG}.md`);
    writeFileSync(filePath, FENCE_FILE, { mode: 0o640 });
    g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'seed']); g(dir, ['remote', 'add', 'origin', bare]); g(dir, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
    await engineA.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ($1,$2,$3)`, [SID, SID, dir]);
    await engineA.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash) VALUES ($1,$2,'person','Alice Example','',$3)`, [SID, PSLUG, 'h0']);
    const r = await engineA.executeRaw<{ id: string | number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence)
       VALUES ($1,$2,$3,'fact','world','high',$4,0.73) RETURNING id`, [SID, PSLUG, PCLAIM, PSRC]);
    return { orphan: String(r[0].id), filePath };
  }
  async function buildAppend(orphan: string, eng: PostgresEngine) {
    const c = (await revalidate(eng, orphan)).ctx!;
    const { body, rowNum } = upsertFactRow(c.body, { claim: c.claim, kind: c.kind, confidence: c.confidence, visibility: c.visibility,
      notability: c.notability, validFrom: c.valid_from ?? undefined, validUntil: c.valid_until ?? undefined, source: c.source, context: c.context ?? undefined });
    return { c, body, rowNum, hash: sha(body), preHash: c.preimage_fence_sha256, filePath: c.filePath };
  }
  const coordRow = (rowNum: number) => ({ fact: PCLAIM, source: PSRC, kind: 'fact', visibility: 'world', notability: 'high', confidence: 0.73,
    entity_slug: PSLUG, row_num: rowNum, source_markdown_slug: PSLUG } as any);

  // ── (1) published_verified adoption: original id, zero rows, applied once ─────
  test('PG-1: published_verified engine adoption preserves the original id, creates zero rows, applies once (cross-session)', async () => {
    const { orphan } = await seed();
    const mid = await insertPendingMarker(engineA, { fact_id: orphan, source_id: SID, slug: PSLUG, row_num: 2, claim: PCLAIM, source: PSRC });
    await engineA.executeRaw(`UPDATE fact_recoordinations SET phase='published_verified' WHERE id=$1`, [mid]);
    const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);

    const res = await engineB.insertFacts([coordRow(2)], { source_id: SID }); // adoption on the OTHER session

    expect(res.ids).toEqual([Number(orphan)]);                                   // original id, no new fact minted
    expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before);     // zero new rows
    expect(await factCoord(orphan)).toEqual({ row_num: 2, slug: PSLUG });
    expect(await marker(mid)).toEqual({ status: 'applied', phase: 'applied' });   // applied exactly once
    // A second reconcile finds no eligible marker → unique fence index no-ops it.
    await engineA.insertFacts([coordRow(2)], { source_id: SID });
    expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before);
    expect(await count(`SELECT COUNT(*)::int AS n FROM facts WHERE source_markdown_slug=$1 AND row_num=2`, [PSLUG])).toBe(1);
  }, 60_000);

  // ── (2) adoption-first: rollback BLOCKS on the lock, then LOSES (no restore) ──
  test('PG-2: adoption holding the marker lock makes a concurrent rollback block, then lose its CAS → no restore/push', async () => {
    const { orphan, filePath } = await seed();
    const ap = await buildAppend(orphan, engineB);
    const c = ap.c;
    // Append is durably published: file + remote both carry the postimage.
    writeFileSync(ap.filePath, ap.body, { mode: 0o640 }); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'append']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    expect(await dur.currentRemoteFileHash(dir, 'main', filePath)).toBe(ap.hash);
    const mid = await insertPendingMarker(engineA, { fact_id: orphan, source_id: SID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
    await engineA.executeRaw(`UPDATE fact_recoordinations SET phase='published_verified' WHERE id=$1`, [mid]);

    // Session A opens the adoption transaction and holds the marker FOR UPDATE —
    // the seam's EXACT sequence (lock → guarded coordinate → applied CAS) staged
    // uncommitted — then signals it holds the lock and waits. Only AFTER A holds
    // the lock do we start B, so the barrier is deterministic (no start race).
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let signalLocked!: () => void; const locked = new Promise<void>(r => { signalLocked = r; });
    const aTx = engineA.transaction(async (txA) => {
      await txA.executeRaw(`SELECT id FROM fact_recoordinations WHERE id=$1 FOR UPDATE`, [mid]);
      await txA.executeRaw(GUARDED_COORDINATE_UPDATE, [ap.rowNum, PSLUG, orphan, normalizeClaim(PCLAIM), normalizeSource(PSRC), SID]);
      await txA.executeRaw(`UPDATE fact_recoordinations SET status='applied', phase='applied', applied_at=now() WHERE id=$1 AND status='pending' AND phase='published_verified'`, [mid]);
      signalLocked();
      await gate; // hold the row lock (and the uncommitted applied) open
    });
    await locked; // A now holds the marker lock with coordinate+applied staged (uncommitted)

    // Session B attempts a rollback; its journal CAS UPDATE blocks on A's lock.
    const bRollback = rollbackPublished(engineB, dur, c, mid, 'concurrent');
    const raced = await Promise.race([bRollback.then(() => 'b-returned'), sleep(500).then(() => 'b-blocked')]);
    expect(raced).toBe('b-blocked'); // deterministically blocked on the locked marker row

    release(); await aTx;             // A commits `applied`
    const bOutcome = await bRollback; // B unblocks: journal CAS now affects 0 rows → declines
    expect(bOutcome).toBe('rollback_failed');

    expect(sha(readFileSync(filePath, 'utf8'))).toBe(ap.hash);                 // file NOT restored — evidence intact
    expect(await dur.currentRemoteFileHash(dir, 'main', filePath)).toBe(ap.hash); // remote NOT restored
    expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG }); // fact coordinated by A
    expect(await marker(mid)).toEqual({ status: 'applied', phase: 'applied' });
  }, 60_000);

  // ── (3) rollback-first: adoption then finds the marker terminal and DECLINES ──
  test('PG-3: a completed rollback makes a later adoption decline — orphan left uncoordinated', async () => {
    const { orphan, filePath } = await seed();
    const ap = await buildAppend(orphan, engineB);
    const c = ap.c;
    writeFileSync(ap.filePath, ap.body, { mode: 0o640 }); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'append']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const mid = await insertPendingMarker(engineA, { fact_id: orphan, source_id: SID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
    await engineA.executeRaw(`UPDATE fact_recoordinations SET phase='published_verified' WHERE id=$1`, [mid]);

    // Session B rolls back FIRST (restores preimage, pushes, terminalizes rolled_back).
    const rb = await rollbackPublished(engineB, dur, c, mid, 'first');
    expect(rb).toBe('rolled_back');
    expect(await marker(mid)).toEqual({ status: 'rolled_back', phase: 'rolled_back' });
    expect(sha(readFileSync(filePath, 'utf8'))).toBe(ap.preHash); // preimage restored

    // Session A adoption now finds no (pending, published_verified) marker → declines.
    const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
    await engineA.insertFacts([coordRow(ap.rowNum)], { source_id: SID });
    expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });   // orphan LEFT UNCOORDINATED
    expect(await marker(mid)).toEqual({ status: 'rolled_back', phase: 'rolled_back' }); // terminal untouched
    // (A separate fact may be inserted for the reconcile row; the orphan itself is never adopted.)
    expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBeGreaterThanOrEqual(before);
  }, 60_000);
});
