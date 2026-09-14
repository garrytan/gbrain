/**
 * Provenance re-coordinate operator — hermetic tests (bp-u49.4.4.7).
 *
 * PGLite only; no network, no source tree required for the DB-mechanism tests.
 * These prove the accepted crash-safe mechanism and FAIL under the prior
 * lock-only design (where a concurrent insert during the publish→coordinate
 * window duplicates the fact):
 *   - the central `insertFacts` adoption seam coordinates an existing orphan
 *     instead of inserting a new fact, iff a matching durable marker exists;
 *   - process-death-after-publish then a concurrent sync/reconcile does NOT
 *     create a second fact (the seam adopts);
 *   - recovery + apply are idempotent;
 *   - zero new rows + original id preserved;
 *   - single active ownership of fact_id and target coordinate;
 *   - adoption match precision (claim/source/coordinate/live-uncoordinated).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  insertPendingMarker, listPendingMarkers, applyPendingMarker, recoverPending,
  revalidate, recoordinateFact, rollbackPublished, type Durability,
} from '../src/core/facts/recoordinate.ts';
import { atomicWriteFileSync } from '../src/core/atomic-write.ts';
import { upsertFactRow, parseFactsFence } from '../src/core/facts-fence.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHash } from '../src/core/utils.ts';
import { sanitizeText } from '../src/core/batch-rows.ts';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(async () => {
  // Reset shared state between tests (one engine for speed).
  await engine.executeRaw(`DELETE FROM fact_recoordinations`);
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM pages WHERE source_id <> 'default'`);
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
});

const SLUG = 'people/alice-example';
const CLAIM = 'Alice joined the board in 2026';
const SRC = 'mcp:put_page';

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await engine.executeRaw<{ n: number }>(sql, params);
  return Number(r[0].n);
}

/** Insert a live ORPHAN fact (row_num NULL, source_markdown_slug NULL). */
async function insertOrphan(fact = CLAIM, source = SRC, slug = SLUG): Promise<string> {
  const r = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence)
     VALUES ('default', $1, $2, 'fact', 'world', 'medium', $3, 1.0) RETURNING id`,
    [slug, fact, source],
  );
  return String(r[0].id);
}

/** Simulate what a concurrent sync/reconcile (or the operator) does when it
 *  derives the appended fence row: a coordinate-producing insert. */
async function insertCoordinatedRow(rowNum: number, fact = CLAIM, source = SRC, slug = SLUG) {
  return engine.insertFacts(
    [{ fact, source, kind: 'fact', visibility: 'world', notability: 'medium', confidence: 1.0,
       entity_slug: slug, row_num: rowNum, source_markdown_slug: slug } as any],
    { source_id: 'default' },
  );
}

async function factCoord(id: string): Promise<{ row_num: number | null; slug: string | null }> {
  const r = await engine.executeRaw<{ row_num: number | null; slug: string | null }>(
    `SELECT row_num, source_markdown_slug AS slug FROM facts WHERE id = $1`, [id]);
  return { row_num: r[0].row_num == null ? null : Number(r[0].row_num), slug: r[0].slug == null ? null : String(r[0].slug) };
}
async function markerStatus(id: string): Promise<string | null> {
  const r = await engine.executeRaw<{ status: string }>(`SELECT status FROM fact_recoordinations WHERE id = $1`, [id]);
  return r[0] ? String(r[0].status) : null;
}
async function markerPhase(id: string): Promise<string | null> {
  const r = await engine.executeRaw<{ phase: string }>(`SELECT phase FROM fact_recoordinations WHERE id = $1`, [id]);
  return r[0] ? String(r[0].phase) : null;
}
/** Advance a marker's phase directly (round-4: the engine adoption seam only
 *  honours a marker at `published_verified`, the phase the operator enters after
 *  proving durable publication — so DB-mechanism tests promote the marker to the
 *  phase at which the coordinate is authorized). */
async function promote(id: string, phase = 'published_verified'): Promise<void> {
  await engine.executeRaw(`UPDATE fact_recoordinations SET phase = $2 WHERE id = $1`, [id, phase]);
}
/** A PendingMarker-shaped object for the operator-path helpers (applyPendingMarker
 *  reads eligibility from the DB row, not from these fields — only the identity
 *  fields must be correct). */
function mkMarker(o: { id: string; fact_id: string } & Partial<Record<string, unknown>>): any {
  return { source_id: 'default', slug: SLUG, row_num: 1, claim_norm: CLAIM, source_norm: SRC,
    status: 'pending', phase: 'published_verified', preimage_hash: null, postimage_hash: null,
    commit_id: null, remote_ref: null, note: null, ...o };
}

// ── The central discriminator ────────────────────────────────────────────────
test('ADOPTION: a coordinate-producing insert with a matching marker coordinates the orphan (zero new facts, id preserved)', async () => {
  const orphan = await insertOrphan();
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  const markerId = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(markerId); // durable publication proven → coordinate authorized

  const res = await insertCoordinatedRow(1); // what a racing sync would run

  const after = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  expect(after).toBe(before);                       // ZERO new fact rows (the insert became an adoption)
  expect(res.ids).toEqual([Number(orphan)]);        // returned the ORIGINAL id — no new fact id minted
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG }); // orphan coordinated
  expect(await markerStatus(markerId)).toBe('applied');
});

test('DISCRIMINATOR: WITHOUT a marker, the same insert creates a NEW fact (the prior lock-only failure mode)', async () => {
  const orphan = await insertOrphan();
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  const res = await insertCoordinatedRow(1); // no marker → naive insert
  const after = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  expect(after).toBe(before + 1);                   // a DUPLICATE fact was created
  expect(res.inserted).toBe(1);
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null }); // orphan still orphan
});

test('CRASH-AFTER-PUBLISH: marker persists; a concurrent sync adopts instead of duplicating', async () => {
  // Operator wrote the durable marker + published the fence, then died before
  // its own coordinate UPDATE. The next sync derives the appended fence row:
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid); // "published the fence" == durable publication proven (published_verified)
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  await insertCoordinatedRow(1); // the concurrent sync
  expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before); // no duplicate
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG });      // fail-forward completed
});

// ── Match precision (binding detail 1) ───────────────────────────────────────
test('PRECISION: a marker whose claim/source does not match the inserted row is NOT adopted', async () => {
  const orphan = await insertOrphan(CLAIM, SRC);
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid); // published_verified: the ONLY reason for non-adoption below is the claim mismatch
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  const res = await insertCoordinatedRow(1, 'A DIFFERENT CLAIM', SRC); // claim mismatch
  expect(res.inserted).toBe(1);                                        // inserted new, not adopted
  expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before + 1);
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
});
test('PRECISION: a marker at a different coordinate is not adopted by this row', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 2, claim: CLAIM, source: SRC });
  await promote(mid); // published_verified: only the coordinate mismatch (row 1 vs 2) blocks adoption
  const res = await insertCoordinatedRow(1); // row_num 1 vs marker row_num 2
  expect(res.inserted).toBe(1);
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
});
test('PRECISION: adoption never coordinates an already-coordinated (non-orphan) fact', async () => {
  // A fact already at (SLUG, 5); a stale marker points at it for coordinate 1.
  const id = (await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence, row_num, source_markdown_slug)
     VALUES ('default',$1,$2,'fact','world','medium',$3,1.0,5,$1) RETURNING id`, [SLUG, CLAIM, SRC]))[0].id;
  const mid = await insertPendingMarker(engine, { fact_id: String(id), source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid); // published_verified: only the row_num-IS-NULL guard blocks moving a coordinated fact
  const res = await insertCoordinatedRow(1);
  // The guard `row_num IS NULL` refuses to move it; a NEW row is inserted at coord 1 instead.
  expect(res.inserted).toBe(1);
  expect(await factCoord(String(id))).toEqual({ row_num: 5, slug: SLUG }); // untouched
});

// ── Single active ownership (binding detail 2) ───────────────────────────────
test('OWNERSHIP: two active markers for the same fact fail closed', async () => {
  const orphan = await insertOrphan();
  await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await expect(insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: 'people/other', row_num: 1, claim: CLAIM, source: SRC })).rejects.toThrow();
});
test('OWNERSHIP: two active markers for the same target coordinate fail closed', async () => {
  const a = await insertOrphan(CLAIM, SRC);
  const b = await insertOrphan('another claim', SRC);
  await insertPendingMarker(engine, { fact_id: a, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await expect(insertPendingMarker(engine, { fact_id: b, source_id: 'default', slug: SLUG, row_num: 1, claim: 'another claim', source: SRC })).rejects.toThrow();
});

// ── Idempotency + lifecycle (binding detail 4) ───────────────────────────────
test('IDEMPOTENT applyPendingMarker: first coordinates, second is a no-op confirm', async () => {
  const orphan = await insertOrphan();
  const markerId = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(markerId); // operator path: applyPendingMarker terminalizes from published_verified
  const m = (await listPendingMarkers(engine, orphan)).find(x => x.id === markerId)!;
  expect(await applyPendingMarker(engine, m)).toBe('coordinated');
  // marker now applied; a re-derived marker object re-applied is a safe confirm
  expect(await applyPendingMarker(engine, { ...m, status: 'pending' })).toBe('already_coordinated');
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG });
});

// (Phase-aware recovery boundaries are exercised in the operator-e2e block,
//  where a source tree + git remote make "durably published" verifiable.)

// ── Unique index backstop still protects the coordinate ──────────────────────
test('ADOPTION serializes with the unique fence index: no two facts at one coordinate', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid);
  await insertCoordinatedRow(1); // adopts
  await insertCoordinatedRow(1); // again (marker now applied) → ON CONFLICT DO NOTHING, no dup
  const n = await count(`SELECT COUNT(*)::int AS n FROM facts WHERE source_markdown_slug = $1 AND row_num = 1`, [SLUG]);
  expect(n).toBe(1);
});

// ── Round-4 #1: adoption is gated on `published_verified` (durable proof) ──────
// Before durable publication is proven, a concurrent reconcile must do ZERO
// adoption (else a failed push + rollback could strand the fact on an absent
// row). The locks close this window while the operator is alive; the phase gate
// closes it across a crash.
for (const phase of ['marker_created', 'written', 'committed'] as const) {
  test(`ROUND4#1: reconcile at ${phase} does NOT adopt (zero adoption before durable proof)`, async () => {
    const orphan = await insertOrphan();
    const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
    const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
    if (phase !== 'marker_created') await promote(mid, phase);
    const res = await insertCoordinatedRow(1);
    expect(res.inserted).toBe(1);                                            // inserted new — NOT adopted
    expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before + 1);
    expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });  // orphan untouched
    expect(await markerStatus(mid)).toBe('pending');                         // marker still active
    expect(await markerPhase(mid)).toBe(phase);                              // never terminalized
  });
}
test('ROUND4#1: reconcile at published_verified adopts — original id preserved, zero new rows', async () => {
  const orphan = await insertOrphan();
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid);
  const res = await insertCoordinatedRow(1);
  expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before);  // ZERO new rows
  expect(res.ids).toEqual([Number(orphan)]);                                // ORIGINAL id preserved
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG });
  expect(await markerStatus(mid)).toBe('applied');
  expect(await markerPhase(mid)).toBe('applied');
});

// ── Round-4 #4: marker transitions are compare-and-set (never overwrite terminal)
test('ROUND4#4: applyPendingMarker never overwrites an already-terminal marker (applied-between-proof/coordinate race)', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid);
  // A concurrent adoption seam coordinates + terminalizes the marker FIRST:
  await insertCoordinatedRow(1);
  expect(await markerStatus(mid)).toBe('applied');
  // The operator's own final step then runs on its (now stale) published_verified marker:
  const stale = { id: mid, fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim_norm: CLAIM, source_norm: SRC,
    status: 'pending', phase: 'published_verified', preimage_hash: null, postimage_hash: null, commit_id: null, remote_ref: null, note: null } as const;
  expect(await applyPendingMarker(engine, stale as any)).toBe('already_coordinated'); // truthful, from live fact state
  expect(await markerStatus(mid)).toBe('applied');                                     // NOT re-mutated / not rolled back
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG });
});
test('ROUND4#4: a CAS transition against a terminalized marker is a no-op (status guard)', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid);
  await insertCoordinatedRow(1); // terminalizes → applied
  // A stale writer trying to journal a rollback on the terminal marker changes nothing.
  await engine.executeRaw(`UPDATE fact_recoordinations SET phase='rolling_back' WHERE id=$1 AND status='pending'`, [mid]);
  expect(await markerStatus(mid)).toBe('applied');
  expect(await markerPhase(mid)).toBe('applied');
});

// ── Round-5 #1: direct coordination is atomic + gated on published_verified ────
// applyPendingMarker must lock the marker, require EXACTLY (pending,
// published_verified), and coordinate + apply in one transaction — never from
// committed/rolling_back, and never leave a coordinated fact behind a
// non-applied marker.
test('ROUND5#1: applyPendingMarker at committed does NOT coordinate (not_eligible, zero fact mutation)', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid, 'committed');
  expect(await applyPendingMarker(engine, mkMarker({ id: mid, fact_id: orphan }))).toBe('not_eligible');
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null }); // ZERO fact mutation
  expect(await markerStatus(mid)).toBe('pending');
  expect(await markerPhase(mid)).toBe('committed'); // untouched
});
test('ROUND5#1: applyPendingMarker at rolling_back does NOT coordinate (not_eligible, zero fact mutation)', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid, 'rolling_back');
  expect(await applyPendingMarker(engine, mkMarker({ id: mid, fact_id: orphan }))).toBe('not_eligible');
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
  expect(await markerStatus(mid)).toBe('pending');
  expect(await markerPhase(mid)).toBe('rolling_back');
});
test('ROUND5#1: applyPendingMarker on a terminalized (rolled_back) marker → not_eligible, zero mutation', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await engine.executeRaw(`UPDATE fact_recoordinations SET status='rolled_back', phase='rolled_back' WHERE id=$1`, [mid]);
  expect(await applyPendingMarker(engine, mkMarker({ id: mid, fact_id: orphan }))).toBe('not_eligible');
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
  expect(await markerStatus(mid)).toBe('rolled_back'); // terminal honoured, not overwritten
});
test('ROUND5#1: applyPendingMarker from published_verified coordinates + applies atomically', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid);
  expect(await applyPendingMarker(engine, mkMarker({ id: mid, fact_id: orphan }))).toBe('coordinated');
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG });
  expect(await markerStatus(mid)).toBe('applied');
  expect(await markerPhase(mid)).toBe('applied'); // coordinate + applied landed together
});

// ── Round-5 #3: engine adoption locks the marker + applies it exactly once ─────
test('ROUND5#3: engine adoption applies the locked marker exactly once (no double-apply, one fact at the coordinate)', async () => {
  const orphan = await insertOrphan();
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid);
  await insertCoordinatedRow(1); // adopts under FOR UPDATE, applies the marker exactly once
  expect(await markerStatus(mid)).toBe('applied');
  expect(await markerPhase(mid)).toBe('applied');
  expect(await factCoord(orphan)).toEqual({ row_num: 1, slug: SLUG });
  // A second reconcile of the same row finds no pending+published_verified marker →
  // no re-adoption; the unique fence index no-ops the duplicate insert.
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  await insertCoordinatedRow(1);
  expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before);
  expect(await count(`SELECT COUNT(*)::int AS n FROM facts WHERE source_markdown_slug = $1 AND row_num = 1`, [SLUG])).toBe(1);
});

// ── Correction 3: native valid_until live semantics ──────────────────────────
async function insertOrphanVU(validUntilSql: string): Promise<string> {
  const r = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence, valid_until)
     VALUES ('default', $1, $2, 'fact', 'world', 'medium', $3, 1.0, ${validUntilSql}) RETURNING id`,
    [SLUG, CLAIM, SRC]);
  return String(r[0].id);
}
test('CORRECTION3: a FUTURE valid_until fact is LIVE (revalidation passes the liveness gate)', async () => {
  const id = await insertOrphanVU(`now() + interval '30 days'`);
  const r = await revalidate(engine, id);
  expect(r.reason).not.toBe('fact_not_live'); // proceeds past liveness (fails later on absent test page)
});
test('CORRECTION3: a PAST valid_until fact is NOT live', async () => {
  const id = await insertOrphanVU(`now() - interval '1 day'`);
  expect((await revalidate(engine, id)).reason).toBe('fact_not_live');
});
test('CORRECTION3: valid_until exactly now() is expired (not live)', async () => {
  const id = await insertOrphanVU(`now()`);
  expect((await revalidate(engine, id)).reason).toBe('fact_not_live');
});

// ── Correction 8: adoption revalidates live exact target identity + values ────
test('CORRECTION8: a changed claim on the orphan blocks adoption (new insert instead)', async () => {
  const orphan = await insertOrphan(CLAIM, SRC);
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid); // published_verified: only the drifted claim blocks adoption
  await engine.executeRaw(`UPDATE facts SET fact = 'CHANGED CLAIM' WHERE id = $1`, [orphan]);
  const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
  const res = await insertCoordinatedRow(1, CLAIM, SRC); // fence row still carries the original claim
  expect(res.inserted).toBe(1);                          // NOT adopted — identity drifted
  expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before + 1);
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
});
test('CORRECTION8: an expired orphan blocks adoption', async () => {
  const orphan = await insertOrphan(CLAIM, SRC);
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid); // published_verified: only the expiry blocks adoption
  await engine.executeRaw(`UPDATE facts SET valid_until = now() - interval '1 day' WHERE id = $1`, [orphan]);
  const res = await insertCoordinatedRow(1, CLAIM, SRC);
  expect(res.inserted).toBe(1);
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
});
test('CORRECTION8: an entity_slug mismatch blocks adoption', async () => {
  const orphan = await insertOrphan(CLAIM, SRC);
  await engine.executeRaw(`UPDATE facts SET entity_slug = 'people/someone-else' WHERE id = $1`, [orphan]);
  const mid = await insertPendingMarker(engine, { fact_id: orphan, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
  await promote(mid); // published_verified: only the entity_slug drift blocks adoption
  const res = await insertCoordinatedRow(1, CLAIM, SRC); // targets SLUG
  expect(res.inserted).toBe(1);
  expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
});

// ── Correction 2: native mode-preserving atomic writer ───────────────────────
test('CORRECTION2: atomicWriteFileSync preserves the target file mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-atomic-'));
  try {
    const f = join(dir, 'page.md'); writeFileSync(f, 'old', { mode: 0o640 });
    atomicWriteFileSync(f, 'new content');
    expect(readFileSync(f, 'utf8')).toBe('new content');
    expect(statSync(f).mode & 0o777).toBe(0o640); // mode preserved across rename
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CORRECTION2: atomicWriteFileSync verify-throw leaves the target untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-atomic-'));
  try {
    const f = join(dir, 'page.md'); writeFileSync(f, 'original');
    expect(() => atomicWriteFileSync(f, 'bad', { verify: () => { throw new Error('reject'); } })).toThrow();
    expect(readFileSync(f, 'utf8')).toBe('original'); // aborted write never installs
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Operator e2e (corrections 1,4,5,6,7): source tree + git repo ─────────────
const FENCE_FILE = [
  '---', 'type: person', 'title: Alice Example', '---', '',
  '# Alice Example', '', '## Facts', '',
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| 1 | Existing row | fact | 0.9 | world | medium |  |  | mcp:put_page |  |',
  '<!--- gbrain:facts:end -->', '',
].join('\n');

function g(wr: string, a: string[]): string { return execFileSync('git', ['-C', wr, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }

describe('operator e2e + phase-aware recovery (source tree + git remote)', () => {
  let dir = '', bare = '';
  const SRC_ID = 'rc', PSLUG = 'people/alice-example', PCLAIM = 'Alice raised a seed round', PSRC = 'mcp:put_page';

  const dur: Durability = {
    isHardened: () => true,
    commitAndPush: async (fp, wr) => {
      g(wr, ['add', '--', fp]);
      let staged = false;
      try { g(wr, ['diff', '--cached', '--quiet', '--', fp]); } catch { staged = true; } // PATH-SCOPED (305#4)
      if (staged) g(wr, ['commit', '-q', '-m', 'recoordinate']);
      g(wr, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      return { commitId: g(wr, ['rev-parse', 'HEAD']), ref: 'main' };
    },
    currentRemoteFileHash: async (wr, ref, fp) => {
      try { g(wr, ['fetch', '-q', 'origin', ref]); return sha(execFileSync('git', ['-C', wr, 'show', `origin/${ref}:${relative(wr, fp)}`], { encoding: 'utf8' })); } catch { return null; }
    },
  };

  async function seed(): Promise<{ orphan: string; filePath: string }> {
    dir = mkdtempSync(join(tmpdir(), 'rc-e2e-')); bare = mkdtempSync(join(tmpdir(), 'rc-bare-'));
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    g(dir, ['init', '-q', '-b', 'main']); g(dir, ['config', 'user.email', 't@t.co']); g(dir, ['config', 'user.name', 't']);
    mkdirSync(join(dir, 'people'), { recursive: true });
    const filePath = join(dir, `${PSLUG}.md`);
    writeFileSync(filePath, FENCE_FILE, { mode: 0o640 });
    g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'seed']);
    g(dir, ['remote', 'add', 'origin', bare]); g(dir, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ($1,$2,$3)`, [SRC_ID, SRC_ID, dir]);
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash) VALUES ($1,$2,'person','Alice Example','',$3)`, [SRC_ID, PSLUG, 'h0']);
    const r = await engine.executeRaw<{ id: string | number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence, claim_metric, claim_value, claim_unit, claim_period)
       VALUES ($1,$2,$3,'fact','world','high',$4,0.73,'mrr',50000,'USD','monthly') RETURNING id`, [SRC_ID, PSLUG, PCLAIM, PSRC]);
    return { orphan: String(r[0].id), filePath };
  }
  function cleanup() { for (const d of [dir, bare]) if (d) rmSync(d, { recursive: true, force: true }); dir = ''; bare = ''; }
  async function markerRow(orphan: string) { return (await engine.executeRaw<Record<string, unknown>>(`SELECT id, status, phase, commit_id, postimage_hash FROM fact_recoordinations WHERE fact_id=$1 ORDER BY created_at DESC LIMIT 1`, [orphan]))[0]; }
  // Build the exact appended body/hash the operator would produce (via reval + upsertFactRow).
  async function buildAppend(orphan: string) {
    const c = (await revalidate(engine, orphan)).ctx!;
    const { body, rowNum } = upsertFactRow(c.body, { claim: c.claim, kind: c.kind, confidence: c.confidence, visibility: c.visibility,
      notability: c.notability, validFrom: c.valid_from ?? undefined, validUntil: c.valid_until ?? undefined, source: c.source, context: c.context ?? undefined,
      claimMetric: c.claim_metric ?? undefined, claimValue: c.claim_value ?? undefined, claimUnit: c.claim_unit ?? undefined, claimPeriod: c.claim_period ?? undefined });
    return { body, rowNum, hash: sha(body), preHash: c.preimage_fence_sha256, filePath: c.filePath };
  }

  test('CORR 1/4/5: coordinates orphan; preserves confidence + typed fields; refreshes compiled_truth; zero new facts', async () => {
    const { orphan, filePath } = await seed();
    try {
      const before = await count(`SELECT COUNT(*)::int AS n FROM facts`);
      const res = await recoordinateFact(engine, orphan, { durability: dur });
      expect(res.ok).toBe(true); expect(res.coordinate_outcome).toBe('coordinated'); expect(res.phase).toBe('applied');
      expect(await count(`SELECT COUNT(*)::int AS n FROM facts`)).toBe(before);
      expect(await factCoord(orphan)).toEqual({ row_num: 2, slug: PSLUG });
      const row = parseFactsFence(readFileSync(filePath, 'utf8')).facts.find(f => f.claim === PCLAIM)!;
      expect(row.confidence).toBeCloseTo(0.73, 2); expect(row.claimMetric).toBe('mrr'); expect(row.claimValue).toBe(50000);
      expect(statSync(filePath).mode & 0o777).toBe(0o640);
      const pg = await engine.executeRaw<{ ct: string }>(`SELECT compiled_truth AS ct FROM pages WHERE source_id=$1 AND slug=$2`, [SRC_ID, PSLUG]);
      expect(String(pg[0].ct)).toContain(PCLAIM);
    } finally { cleanup(); }
  }, 30_000);

  test('CORR 6: refuses to apply on a non-hardened repo (no marker, no mutation)', async () => {
    const { orphan, filePath } = await seed();
    try {
      const res = await recoordinateFact(engine, orphan, { durability: { ...dur, isHardened: () => false } });
      expect(res.reason).toBe('durability_not_hardened');
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
      expect(readFileSync(filePath, 'utf8')).toBe(FENCE_FILE);
      expect(await count(`SELECT COUNT(*)::int AS n FROM fact_recoordinations`)).toBe(0);
    } finally { cleanup(); }
  }, 30_000);

  test('CORR 7 truthful rollback: commit fails AND restoring commit fails → rollback_failed + marker failed', async () => {
    const { orphan, filePath } = await seed();
    try {
      const res = await recoordinateFact(engine, orphan, { durability: { ...dur, commitAndPush: async () => { throw new Error('push rejected'); } } });
      expect(res.reason).toBe('commit_failed');
      expect(res.coordinate_outcome).toBe('rollback_failed'); // restoring commit could not be proven durable
      // 298#1: on an unproven rollback the guard is KEPT (marker stays pending), never falsely released.
      expect((await markerRow(orphan)).status).toBe('pending');
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
      expect(readFileSync(filePath, 'utf8')).toBe(FENCE_FILE); // file restored locally
    } finally { cleanup(); }
  }, 30_000);

  // ── Phase-aware recovery boundaries ──
  test('RECOVERY marker-only crash: safe ABORT so a rerun can proceed', async () => {
    const { orphan, filePath } = await seed();
    try {
      const ap = await buildAppend(orphan);
      await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('aborted_marker_only');
      expect((await markerRow(orphan)).status).toBe('rolled_back');
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
      expect(readFileSync(filePath, 'utf8')).toBe(FENCE_FILE);
    } finally { cleanup(); }
  }, 30_000);

  test('RECOVERY local-rename-only crash (bytes match): resume-forward → commit, push, coordinate', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(ap.filePath, ap.body); // rename happened; crash before commit
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='written' WHERE id=$1`, [id]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('coordinated');
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG });
    } finally { cleanup(); }
  }, 30_000);

  test('298#5 RECOVERY written + AMBIGUOUS bytes: keep guard PENDING (never release, never coordinate)', async () => {
    const { orphan, filePath } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(filePath, FENCE_FILE + '\n<!-- tampered -->\n'); // neither preimage NOR postimage
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='written' WHERE id=$1`, [id]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('deferred_ambiguous_written');
      expect((await markerRow(orphan)).status).toBe('pending'); // guard HELD on ambiguous bytes
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
    } finally { cleanup(); }
  }, 30_000);
  test('298#5 RECOVERY written + reverted-to-PREIMAGE: proven-gone → safe rolled_back', async () => {
    const { orphan, filePath } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(filePath, FENCE_FILE); // append is gone → exactly preimage
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='written' WHERE id=$1`, [id]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('rolled_back_append_gone');
      expect((await markerRow(orphan)).status).toBe('rolled_back');
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
    } finally { cleanup(); }
  }, 30_000);
  test('298#2 RECOVERY marker_created + POSTIMAGE on disk (crash after rename, before phase): resume → coordinated', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(ap.filePath, ap.body); // rename landed; crash BEFORE setPhase('written')
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('coordinated'); // never blindly rolled back while append present
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG });
    } finally { cleanup(); }
  }, 30_000);
  test('298#2 RECOVERY marker_created + AMBIGUOUS on disk: keep guard PENDING', async () => {
    const { orphan, filePath } = await seed();
    try {
      const ap = await buildAppend(orphan);
      await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(filePath, FENCE_FILE + '\n<!-- half-written -->\n');
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('deferred_ambiguous_marker_created');
      expect((await markerRow(orphan)).status).toBe('pending');
    } finally { cleanup(); }
  }, 30_000);
  test('298#3 RECOVERY written + already durably committed (crash after commit, before phase): idempotent → coordinated', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(ap.filePath, ap.body);
      g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'durable']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']); // durable, but phase never advanced
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='written' WHERE id=$1`, [id]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan }); // commitAndPush finds nothing to commit → pushes HEAD → durable → coordinate
      expect(out[0].outcome).toBe('coordinated');
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG });
    } finally { cleanup(); }
  }, 30_000);
  test('305#1 durability gate: current remote does NOT carry postimage → operator refuses to coordinate', async () => {
    const { orphan, filePath } = await seed();
    try {
      // Simulate an async/background push that never landed on the current remote tip.
      const asyncDur: Durability = { ...dur, currentRemoteFileHash: async () => 'deadbeef'.repeat(8) };
      const res = await recoordinateFact(engine, orphan, { durability: asyncDur });
      expect(res.reason).toBe('not_durably_published');
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null }); // never coordinated on unconfirmed remote state
    } finally { cleanup(); }
  }, 30_000);

  test('305#1 CURRENT-remote-restored: old append commit is still an ancestor, but current remote has preimage → NOT coordinated', async () => {
    const { orphan, filePath } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      // Append committed + pushed (remote had postimage)...
      atomicWriteFileSync(ap.filePath, ap.body); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'append']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      const appendCid = g(dir, ['rev-parse', 'HEAD']);
      // ...then a restoring commit removed it + pushed → current remote tip carries PREIMAGE.
      atomicWriteFileSync(filePath, FENCE_FILE); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'restore']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='committed', commit_id=$2, remote_ref='main' WHERE id=$1`, [id, appendCid]); // stale old commit
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('rolled_back'); // decided by CURRENT remote (preimage), not old-commit ancestry
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
    } finally { cleanup(); }
  }, 30_000);

  test('305#2 crash after local restore (before restoring push): local preimage vs remote postimage → NOT coordinated (reconciled to preimage)', async () => {
    const { orphan, filePath } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      // Append pushed (remote=postimage), rollback restored the file LOCALLY only, phase journaled rolling_back.
      atomicWriteFileSync(ap.filePath, ap.body); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'append']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      atomicWriteFileSync(filePath, FENCE_FILE); // local restored to preimage, NOT committed/pushed
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='rolling_back', remote_ref='main' WHERE id=$1`, [id]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      // Recovery pushes the current local (preimage) → remote becomes preimage → rolled_back; never coordinates while they disagreed.
      expect(out[0].outcome).toBe('rolled_back');
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
    } finally { cleanup(); }
  }, 30_000);

  test('305#4 unrelated staged file during no-change recovery: path-scoped diff still coordinates', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(ap.filePath, ap.body); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'append']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='written' WHERE id=$1`, [id]);
      writeFileSync(join(dir, 'unrelated.md'), 'unrelated'); g(dir, ['add', '--', join(dir, 'unrelated.md')]); // UNRELATED staged file
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('coordinated'); // path-scoped cached-diff on the target → no forced commit failure
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG });
    } finally { cleanup(); }
  }, 30_000);

  test('305#3 central adoption sets phase=applied (not just status) — engine parity', async () => {
    // The DB adoption seam must set phase='applied' in the same txn as status.
    const o = await insertOrphan();
    const mid = await insertPendingMarker(engine, { fact_id: o, source_id: 'default', slug: SLUG, row_num: 1, claim: CLAIM, source: SRC });
    await promote(mid);
    await insertCoordinatedRow(1);
    const m = (await engine.executeRaw<{ status: string; phase: string }>(`SELECT status, phase FROM fact_recoordinations WHERE id=$1`, [mid]))[0];
    expect(m.status).toBe('applied');
    expect(m.phase).toBe('applied');
  }, 30_000);

  test('RECOVERY post-push/pre-coordinate death: durable + exact → coordinate (fail-forward)', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      atomicWriteFileSync(ap.filePath, ap.body);
      g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'pushed']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      const cid = g(dir, ['rev-parse', 'HEAD']);
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='committed', commit_id=$2 WHERE id=$1`, [id, cid]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('coordinated');
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG });
    } finally { cleanup(); }
  }, 30_000);

  test('ROUND4#2 recovery preimage but DB body cannot be proven restored: marker stays PENDING (never rolled_back)', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      // Local file is the seeded preimage and the remote already carries it (seed
      // pushed) — i.e. local+remote both preimage = "append gone".
      await engine.executeRaw(`UPDATE fact_recoordinations SET phase='committed', remote_ref='main' WHERE id=$1`, [id]);
      // ...but the page row is gone, so the DB compiled body CANNOT be proven back to preimage.
      await engine.executeRaw(`UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2`, [SRC_ID, PSLUG]);
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out[0].outcome).toBe('deferred_refresh_failed_preimage'); // round-4 #2: NOT terminalized on an unverified DB body
      expect((await markerRow(orphan)).status).toBe('pending');        // guard HELD
    } finally { cleanup(); }
  }, 30_000);

  test('ROUND4#3 subsequent native import is a no-op: DB content_hash equals the canonical hash of the coordinated file', async () => {
    const { orphan, filePath } = await seed();
    try {
      const res = await recoordinateFact(engine, orphan, { durability: dur });
      expect(res.ok).toBe(true);
      // Recompute exactly as native import does: parse the ACTUAL file, sanitize, sort tags, canonical shape.
      const parsed = parseMarkdown(readFileSync(filePath, 'utf8'), `${PSLUG}.md`, { validate: true });
      parsed.tags.sort();
      const canonical = contentHash({
        title: sanitizeText(parsed.title), type: parsed.type,
        compiled_truth: sanitizeText(parsed.compiled_truth), timeline: sanitizeText(parsed.timeline) || '',
        frontmatter: parsed.frontmatter, tags: parsed.tags,
      });
      const pg = (await engine.executeRaw<{ ch: string; ct: string }>(`SELECT content_hash AS ch, compiled_truth AS ct FROM pages WHERE source_id=$1 AND slug=$2`, [SRC_ID, PSLUG]))[0];
      expect(String(pg.ch)).toBe(canonical);        // next `gbrain sync` short-circuits (existing.content_hash === hash)
      expect(String(pg.ct)).toContain(PCLAIM);      // forward control: compiled truth carries the coordinated claim
      expect(String(pg.ct)).toBe(sanitizeText(parsed.compiled_truth)); // byte-for-byte compiled_truth
    } finally { cleanup(); }
  }, 30_000);

  test('ROUND4#4 recovery honours an already-terminal marker (applied-before-recovery-lock): no overwrite, no re-open', async () => {
    const { orphan } = await seed();
    try {
      const ap = await buildAppend(orphan);
      // A completed operator coordinated + terminalized the marker durably.
      atomicWriteFileSync(ap.filePath, ap.body); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'done']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      await promote(id); await applyPendingMarker(engine, (await listPendingMarkers(engine, orphan))[0]);
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG });
      expect(await markerStatus(id)).toBe('applied');
      // A late recovery pass must not resurrect or rollback the terminal coordinate.
      const out = await recoverPending(engine, { durability: dur, factId: orphan });
      expect(out).toEqual([]);                                                  // nothing pending to recover
      expect(await markerStatus(id)).toBe('applied');                          // untouched
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG }); // still coordinated
    } finally { cleanup(); }
  }, 30_000);

  test('ROUND4 hardening: detached HEAD is refused (no push of a branch named HEAD)', async () => {
    const { orphan } = await seed();
    try {
      const detachedDur: Durability = {
        ...dur,
        commitAndPush: async (fp, wr) => {
          const ref = g(wr, ['rev-parse', '--abbrev-ref', 'HEAD']);
          if (!ref || ref === 'HEAD') throw new Error('detached HEAD is not durable');
          return { commitId: g(wr, ['rev-parse', 'HEAD']), ref };
        },
      };
      g(dir, ['checkout', '-q', '--detach']); // detach HEAD
      const res = await recoordinateFact(engine, orphan, { durability: detachedDur });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('commit_failed');               // fail-closed, no coordinate
      expect(await factCoord(orphan)).toEqual({ row_num: null, slug: null });
    } finally { cleanup(); }
  }, 30_000);

  test('ROUND5#2 rollback-intent CAS lost to a concurrent adoption → NO restore/push (file+remote stay postimage)', async () => {
    const { orphan } = await seed();
    try {
      const c = (await revalidate(engine, orphan)).ctx!; // capture ctx while file=preimage, orphan uncoordinated
      const ap = await buildAppend(orphan);
      // Append is durably published (local+remote = postimage):
      atomicWriteFileSync(ap.filePath, ap.body); g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'append']); g(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      expect(await dur.currentRemoteFileHash(dir, 'main', ap.filePath)).toBe(ap.hash);
      const id = await insertPendingMarker(engine, { fact_id: orphan, source_id: SRC_ID, slug: PSLUG, row_num: ap.rowNum, claim: PCLAIM, source: PSRC, preimage_hash: ap.preHash, postimage_hash: ap.hash });
      await promote(id); // published_verified
      // A concurrent adoption coordinated the fact + terminalized the marker:
      await engine.executeRaw(`UPDATE facts SET row_num=$2, source_markdown_slug=$3 WHERE id=$1`, [orphan, ap.rowNum, PSLUG]);
      await engine.executeRaw(`UPDATE fact_recoordinations SET status='applied', phase='applied', applied_at=now() WHERE id=$1`, [id]);
      // A late rollback attempt MUST abort before any restore/push (round-5 #2):
      const outcome = await rollbackPublished(engine, dur, c, id, 'late_rollback');
      expect(outcome).toBe('rollback_failed');                              // marker is applied, not rolled_back
      expect(sha(readFileSync(ap.filePath, 'utf8'))).toBe(ap.hash);         // file NOT restored — evidence intact
      expect(await dur.currentRemoteFileHash(dir, 'main', ap.filePath)).toBe(ap.hash); // remote NOT restored
      expect(await markerStatus(id)).toBe('applied');                       // terminal honoured
      expect(await factCoord(orphan)).toEqual({ row_num: ap.rowNum, slug: PSLUG }); // fact still coordinated
    } finally { cleanup(); }
  }, 30_000);

  test('ROUND5#4 implicit-type page: refresh stamps existing.type so the next native import is a genuine no-op', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rc-it-')); const b = mkdtempSync(join(tmpdir(), 'rc-itb-'));
    const SID = 'it', SL = 'notes/curated-thing', CL = 'Implicit-type page fact', SO = 'mcp:put_page';
    // NO frontmatter `type:` — an implicit-type page. Stored type is curated and
    // DIFFERS from anything path/pack inference would produce.
    const IMPLICIT_FILE = [
      '# Curated Thing', '', '## Facts', '',
      '<!--- gbrain:facts:begin -->',
      '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| 1 | Seed row | fact | 0.9 | world | medium |  |  | mcp:put_page |  |',
      '<!--- gbrain:facts:end -->', '',
    ].join('\n');
    try {
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', b]);
      g(d, ['init', '-q', '-b', 'main']); g(d, ['config', 'user.email', 't@t.co']); g(d, ['config', 'user.name', 't']);
      mkdirSync(join(d, 'notes'), { recursive: true });
      const fp = join(d, `${SL}.md`);
      writeFileSync(fp, IMPLICIT_FILE, { mode: 0o640 });
      g(d, ['add', '-A']); g(d, ['commit', '-q', '-m', 'seed']); g(d, ['remote', 'add', 'origin', b]); g(d, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ($1,$2,$3)`, [SID, SID, d]);
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash) VALUES ($1,$2,'curatedxyz','Curated Thing','',$3)`, [SID, SL, 'h0']);
      const r = await engine.executeRaw<{ id: string | number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence) VALUES ($1,$2,$3,'fact','world','medium',$4,1.0) RETURNING id`, [SID, SL, CL, SO]);
      const orphan = String(r[0].id);
      const res = await recoordinateFact(engine, orphan, { durability: dur });
      expect(res.ok).toBe(true);
      // Recompute the hash the way the NEXT native import will: preserve existing.type (#1035) for implicit type.
      const parsed = parseMarkdown(readFileSync(fp, 'utf8'), `${SL}.md`, { validate: true });
      expect(parsed.typeExplicit).toBe(false);
      parsed.type = 'curatedxyz'; parsed.tags.sort();
      const canonical = contentHash({ title: sanitizeText(parsed.title), type: parsed.type, compiled_truth: sanitizeText(parsed.compiled_truth), timeline: sanitizeText(parsed.timeline) || '', frontmatter: parsed.frontmatter, tags: parsed.tags });
      const pg = (await engine.executeRaw<{ ch: string; ty: string }>(`SELECT content_hash AS ch, type AS ty FROM pages WHERE source_id=$1 AND slug=$2`, [SID, SL]))[0];
      expect(String(pg.ty)).toBe('curatedxyz');   // stored type preserved (refreshPageBody never touches it)
      expect(String(pg.ch)).toBe(canonical);       // hash bound to existing.type → next import short-circuits
    } finally { for (const x of [d, b]) rmSync(x, { recursive: true, force: true }); }
  }, 30_000);
});
