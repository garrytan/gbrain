/**
 * v0.32.2 — migration orchestrator tests.
 *
 * Covers phaseASchema (asserts v51 ran), phaseBFenceFacts (legacy
 * row → fence backfill happy path, idempotent re-run, dry-run, NULL
 * entity_slug skip, missing local_path skip), and phaseCVerify
 * (mismatch detection).
 *
 * Real PGLite + real tempdir filesystem. Engine injected via
 * __setTestEngineOverride so we don't need a configured brain.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  v0_32_2, __setTestEngineOverride, __testing,
  countActiveLegacyRows, detectV0_32_2Drift,
} from '../src/commands/migrations/v0_32_2.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const DRY_OPTS = { ...OPTS, dryRun: true };

async function seedLegacyFact(input: {
  entity_slug: string | null;
  fact: string;
  source_id?: string;
  visibility?: 'private' | 'world';
  notability?: 'high' | 'medium' | 'low';
  /** #2646: seed as soft-expired (what forget_fact leaves behind). */
  expired?: boolean;
  /** #2646: override the `source` column (dedup key half). */
  source?: string;
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence, expired_at)
     VALUES ($1, $2, $3, 'fact', $4, $5, now(), $6, 1.0, $7)
     RETURNING id`,
    [
      input.source_id ?? 'default',
      input.entity_slug,
      input.fact,
      input.visibility ?? 'private',
      input.notability ?? 'medium',
      input.source ?? 'mcp:put_page',
      input.expired ? new Date() : null,
    ],
  );
  return r.rows[0].id;
}

describe('phaseASchema', () => {
  test('passes when schema is at v51', async () => {
    // initSchema ran v51, so the version config + columns are set.
    const r = await __testing.phaseASchema(engine, OPTS);
    expect(r.status).toBe('complete');
  });

  test('skipped under dry-run', async () => {
    const r = await __testing.phaseASchema(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('dry-run');
  });

  test('skipped when no engine is available', async () => {
    const r = await __testing.phaseASchema(null, OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('no_brain_configured');
  });
});

describe('phaseBFenceFacts — dry-run reporting', () => {
  test('reports counts without writing FS or updating DB', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });
    await seedLegacyFact({ entity_slug: 'people/bob', fact: 'Met at YC W22' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented claim' });

    const r = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('dry-run');
    expect(r.detail).toContain('would fence 2 rows');  // 3 total - 1 unparented
    expect(r.detail).toContain('1 unfenceable');

    // No files created.
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
    // DB rows still have NULL row_num.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE entity_slug IS NOT NULL',
    );
    expect(rows.rows.every((r: { row_num: number | null }) => r.row_num === null)).toBe(true);
  });
});

describe('phaseBFenceFacts — happy path backfill', () => {
  test('fences legacy DB rows into entity pages + updates row_num', async () => {
    const id1 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme in 2017' });
    const id2 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Prefers async over meetings' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=2');
    expect(r.detail).toContain('pages=1');

    // Stub-page exists with fence content.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme in 2017');
    expect(body).toContain('Prefers async over meetings');

    // DB rows now have row_num + source_markdown_slug populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, row_num, source_markdown_slug FROM facts ORDER BY id',
    );
    expect(rows.rows[0]).toMatchObject({ id: id1, row_num: 1, source_markdown_slug: 'people/alice' });
    expect(rows.rows[1]).toMatchObject({ id: id2, row_num: 2, source_markdown_slug: 'people/alice' });
  });

  test('groups by entity page — multi-entity batch touches multiple files', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'A1' });
    await seedLegacyFact({ entity_slug: 'companies/acme', fact: 'C1' });
    await seedLegacyFact({ entity_slug: 'deals/seed', fact: 'D1' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=3');
    expect(r.detail).toContain('pages=3');

    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'companies/acme.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'deals/seed.md'))).toBe(true);
  });

  test('appends to existing entity page without overwriting body', async () => {
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(
      join(brainDir, 'people/alice.md'),
      '---\ntype: person\ntitle: Alice\nslug: people/alice\n---\n\n# Alice\n\nNotes about Alice.\n',
      'utf-8',
    );
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('Notes about Alice.');  // preserved
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme');
  });

  test('idempotent: re-running after partial completion does NOT duplicate rows', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'First' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Second' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    // Manually clear one row's row_num to simulate a partial state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
       WHERE fact = 'Second'`,
    );

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');

    // The re-run should reuse the existing row_num=2 (matched by claim
    // content) rather than appending a new row_num=3.
    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    const parsed = parseFactsFence(body);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.map(f => f.claim).sort()).toEqual(['First', 'Second']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE row_num IS NOT NULL ORDER BY row_num',
    );
    expect(rows.rows.map((r: { row_num: number }) => r.row_num)).toEqual([1, 2]);
  });

  test('skips facts with NULL entity_slug (unfenceable)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Fenceable' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unfenceable' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(r.detail).toContain('skipped_no_entity=1');

    // The unparented fact's row_num remains NULL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT entity_slug, row_num FROM facts ORDER BY id`,
    );
    expect(rows.rows[0]).toMatchObject({ entity_slug: 'people/alice', row_num: 1 });
    expect(rows.rows[1]).toMatchObject({ entity_slug: null, row_num: null });
  });

  test('skips when source has no local_path', async () => {
    // Wipe default source's local_path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Whatever' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('skipped_no_local_path=1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
  });
});

describe('phaseBFenceFacts — dirty-tree refusal scoping (#927)', () => {
  let dirtyDir: string;

  beforeEach(async () => {
    // A second source whose local_path is a git repo with uncommitted changes.
    dirtyDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-dirty-'));
    execFileSync('git', ['-C', dirtyDir, 'init', '-q']);
    writeFileSync(join(dirtyDir, 'uncommitted.md'), 'dirty', 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)`,
      [dirtyDir],
    );
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`DELETE FROM sources WHERE id = 'other'`);
    rmSync(dirtyDir, { recursive: true, force: true });
  });

  test('no legacy facts at all → complete, dirty unrelated source ignored', async () => {
    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('scanned=0');
  });

  test('facts scoped to a clean source fence despite dirty unrelated source', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
  });

  test('still refuses when the TARGETED source is dirty', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1', source_id: 'other' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('"other"');
    expect(r.detail).toContain('uncommitted changes');
  });
});

describe('phaseBFenceFacts — active-only predicate (#2646)', () => {
  test('soft-expired legacy rows are NOT fenced (forget_fact removals stay removed)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Active claim' });
    const expiredId = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Forgotten claim', expired: true });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('scanned=1');
    expect(r.detail).toContain('fenced=1');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('Active claim');
    expect(body).not.toContain('Forgotten claim');

    // The expired row stays in the legacy keyspace, untouched.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (engine as any).db.query(
      `SELECT row_num, source_markdown_slug, expired_at FROM facts WHERE id = $1`, [expiredId],
    );
    expect(row.rows[0].row_num).toBeNull();
    expect(row.rows[0].source_markdown_slug).toBeNull();
    expect(row.rows[0].expired_at).not.toBeNull();
  });

  test('dry-run counts exclude expired rows (predicate parity with the fetch)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Active' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Expired', expired: true });
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented expired', expired: true });

    const r = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(r.detail).toContain('would fence 1 rows');
    expect(r.detail).toContain('0 unfenceable');
  });
});

describe('phaseBFenceFacts — duplicate legacy rows (#2646)', () => {
  test('duplicate (claim, source) rows: one stamped, extras soft-expired, no UNIQUE violation', async () => {
    const id1 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim' });
    const id2 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim' });
    const id3 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(r.detail).toContain('expired_duplicates=2');

    // Fence carries the claim once.
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts).toHaveLength(1);

    // First row stamped; the duplicates soft-expired (never hard-deleted).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT id, row_num, expired_at FROM facts ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows[0]).toMatchObject({ id: id1, row_num: 1 });
    expect(rows.rows[0].expired_at).toBeNull();
    for (const dup of [rows.rows[1], rows.rows[2]]) {
      expect([id2, id3]).toContain(dup.id);
      expect(dup.row_num).toBeNull();
      expect(dup.expired_at).not.toBeNull();
    }

    // The guard's backlog is fully drained.
    expect(await countActiveLegacyRows(engine)).toBe(0);

    // Idempotent: a re-run finds nothing to do.
    const r2 = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r2.status).toBe('complete');
    expect(r2.detail).toContain('scanned=0');
  });

  test('same claim under different sources is NOT a duplicate (two fence rows)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim', source: 'src-a' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim', source: 'src-b' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.detail).toContain('fenced=2');
    expect(r.detail).not.toContain('expired_duplicates');

    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts).toHaveLength(2);
  });
});

describe('phaseBFenceFacts — interrupted-run resume (#2646)', () => {
  test('resume after rename succeeded but DB stamps never ran (fence row_nums consumed as a queue)', async () => {
    // The exact interruption the verdict flags: the atomic rename
    // committed the fence, then the process died before ANY UPDATE.
    // Simulate by running phase B fully, then clearing every stamp.
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'First' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Second' });
    await __testing.phaseBFenceFacts(engine, OPTS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL`,
    );

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=2');

    // No duplicate fence rows appended; each DB row re-claimed its
    // fence row_num exactly once.
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num FROM facts ORDER BY row_num`,
    );
    expect(rows.rows.map((r: { row_num: number }) => r.row_num)).toEqual([1, 2]);
    expect(await countActiveLegacyRows(engine)).toBe(0);
  });

  test('resume mid-stamp with duplicate claims: remaining rows drain without UNIQUE violation', async () => {
    // Duplicate-claim group interrupted after the rename + the FIRST
    // stamp: one row owns fence row_num 1, its duplicate is still
    // active-legacy. The re-run must soft-expire the leftover (the
    // fence row is already backed) instead of re-assigning row_num 1
    // and violating the partial UNIQUE index.
    const id1 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim' });
    const id2 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Same claim' });
    await __testing.phaseBFenceFacts(engine, OPTS);
    // Undo the duplicate's soft-expire to reconstruct the mid-stamp state:
    // id1 stamped, id2 active-legacy, fence already carries the claim.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET expired_at = NULL WHERE id = $1`, [id2],
    );
    expect(await countActiveLegacyRows(engine)).toBe(1);

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('expired_duplicates=1');
    expect(await countActiveLegacyRows(engine)).toBe(0);

    // id1's stamp is untouched; the fence still carries the claim once.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row1 = await (engine as any).db.query(
      `SELECT row_num, expired_at FROM facts WHERE id = $1`, [id1],
    );
    expect(row1.rows[0].row_num).toBe(1);
    expect(row1.rows[0].expired_at).toBeNull();
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts).toHaveLength(1);
  });
});

describe('phaseBFenceFacts — raced forget between fetch and stamp (#2646 codex P1)', () => {
  test('unbacked fence row is removed again; the forget is preserved', async () => {
    const id = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Claim being forgotten' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Untouched claim' });

    // Simulate forget_fact winning the race: the moment phase B issues
    // its first stamp UPDATE, expire the target row out from under it.
    let raced = false;
    const racedEngine = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[]) => {
            if (!raced && /UPDATE facts SET row_num/.test(sql) && params?.[2] === id) {
              raced = true;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (engine as any).db.query(
                `UPDATE facts SET expired_at = now() WHERE id = $1`, [id],
              );
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any).executeRaw(sql, params);
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = Reflect.get(target, prop) as any;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await __testing.phaseBFenceFacts(racedEngine as any, OPTS);
    expect(raced).toBe(true);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('raced_forgets=1');
    expect(r.detail).toContain('fenced=1'); // only the untouched claim

    // The fence must NOT carry the forgotten claim — leaving it would
    // let the next extract_facts cycle resurrect it as an active fact.
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts.map(f => f.claim)).toEqual(['Untouched claim']);

    // The DB row stays expired-legacy (forget record intact) and the
    // guard backlog is fully drained.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (engine as any).db.query(
      `SELECT row_num, expired_at FROM facts WHERE id = $1`, [id],
    );
    expect(row.rows[0].row_num).toBeNull();
    expect(row.rows[0].expired_at).not.toBeNull();
    expect(await countActiveLegacyRows(engine)).toBe(0);
  });
});

describe('drift detection (#2646 repair lane)', () => {
  test('detectV0_32_2Drift counts only active legacy rows with an entity', async () => {
    expect(await detectV0_32_2Drift()).toBe(0);

    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Active drift' });
    await seedLegacyFact({ entity_slug: 'people/bob', fact: 'Forgotten', expired: true });
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented' });
    expect(await detectV0_32_2Drift()).toBe(1);

    // Running the backfill drains the drift to zero.
    await __testing.phaseBFenceFacts(engine, OPTS);
    expect(await detectV0_32_2Drift()).toBe(0);
  });
});

describe('phaseCVerify', () => {
  test('returns complete when fence + DB row counts match', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F2' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('pages_checked=1');
  });

  test('returns failed when fence row count drifts from DB', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    // Corrupt the fence: append a row manually that's not in the DB.
    const path = join(brainDir, 'people/alice.md');
    const body = readFileSync(path, 'utf-8');
    const corrupted = body.replace(
      '<!--- gbrain:facts:end -->',
      '| 99 | extra row | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->',
    );
    writeFileSync(path, corrupted, 'utf-8');

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('drifted');
    expect(r.detail).toContain('people/alice');
  });

  test('touched-pages scoping (#2646): pre-existing drift on an untouched page does not fail the run', async () => {
    // A page with fence↔DB drift that THIS run never touched.
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(
      join(brainDir, 'people/stale.md'),
      `---\ntype: person\ntitle: Stale\nslug: people/stale\n---\n\n# Stale\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | drifted row | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n| 2 | second drifted row | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->\n`,
      'utf-8',
    );
    // DB knows only ONE fenced row for people/stale → count mismatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', 'people/stale', 'drifted row', 'fact', 'private', 'medium',
               now(), 'manual', 1.0, 1, 'people/stale')`,
    );

    // This run touches only people/alice.
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Fresh claim' });
    const b = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(b.status).toBe('complete');

    // Scoped verify: complete despite the stale page's drift.
    const scoped = await __testing.phaseCVerify(engine, OPTS, b.touchedPages);
    expect(scoped.status).toBe('complete');
    expect(scoped.detail).toContain('pages_checked=1');
    expect(scoped.detail).toContain('active_legacy_remaining=0');

    // Unscoped verify (legacy behavior) still sees it.
    const full = await __testing.phaseCVerify(engine, OPTS);
    expect(full.status).toBe('failed');
    expect(full.detail).toContain('people/stale');
  });
});

describe('orchestrator end-to-end', () => {
  test('clean run returns status:complete with 3 phases', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    const result = await v0_32_2.orchestrator(OPTS);
    expect(result.version).toBe('0.32.2');
    expect(result.status).toBe('complete');
    expect(result.phases.map(p => p.name)).toEqual(['schema', 'fence_facts', 'verify']);
    expect(result.phases.every(p => p.status === 'complete')).toBe(true);
  });

  test('dry-run returns 3 phases all skipped (no FS or DB changes)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Should not get fenced' });

    const result = await v0_32_2.orchestrator(DRY_OPTS);
    expect(result.status).toBe('complete');
    expect(result.phases.every(p => p.status === 'skipped')).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
  });
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});
