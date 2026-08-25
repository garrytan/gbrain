/**
 * #550 — pages(source_id, slug) unique-arbiter self-heal.
 *
 * Repro chain pinned here: DROP the pages_source_slug_key constraint →
 * putPage fails with "no unique or exclusion constraint" and re-initSchema
 * does NOT restore it (version counter is already stamped past v21/v23).
 * The arbiter module detects the drift by index SHAPE and repairs ADD-only;
 * runMigrations self-heals on every pass; doctor fails loudly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  checkPagesUpsertArbiter,
  repairPagesUpsertArbiter,
} from '../src/core/pages-upsert-arbiter.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { pagesUpsertArbiterCheck } from '../src/commands/doctor/checks/core-health.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Restore the arbiter in case a prior test dropped it.
  await repairPagesUpsertArbiter(engine);
});

async function putProbePage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'concept',
    frontmatter: {},
    compiled_truth: `body for ${slug}`,
    timeline: '',
  });
}

async function dropArbiter(): Promise<void> {
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key`);
}

describe('checkPagesUpsertArbiter (#550)', () => {
  test('healthy brain: arbiter present, no repair needed', async () => {
    const s = await checkPagesUpsertArbiter(engine);
    expect(s.tablePresent).toBe(true);
    expect(s.arbiterPresent).toBe(true);
    expect(s.needsRepair).toBe(false);
  });

  test('dropped constraint: putPage fails and check flags needsRepair', async () => {
    await putProbePage('probe/before-drop');
    await dropArbiter();
    await expect(putProbePage('probe/after-drop')).rejects.toThrow(/no unique or exclusion constraint/);
    const s = await checkPagesUpsertArbiter(engine);
    expect(s.needsRepair).toBe(true);
    expect(s.duplicateGroups).toBe(0);
  });

  test('by-shape: a differently-named non-partial unique index counts as the arbiter', async () => {
    await dropArbiter();
    await engine.executeRaw(
      `CREATE UNIQUE INDEX pages_custom_arbiter ON pages(slug, source_id)`,
    );
    const s = await checkPagesUpsertArbiter(engine);
    expect(s.arbiterPresent).toBe(true);
    expect(s.needsRepair).toBe(false);
    await engine.executeRaw(`DROP INDEX pages_custom_arbiter`);
  });

  test('by-shape: a PARTIAL unique index does NOT count (cannot arbitrate)', async () => {
    await dropArbiter();
    await engine.executeRaw(
      `CREATE UNIQUE INDEX pages_partial_nope ON pages(source_id, slug) WHERE deleted_at IS NULL`,
    );
    const s = await checkPagesUpsertArbiter(engine);
    expect(s.needsRepair).toBe(true);
    await engine.executeRaw(`DROP INDEX pages_partial_nope`);
  });
});

describe('repairPagesUpsertArbiter (#550)', () => {
  test('drop -> putPage fails -> repair -> putPage works again', async () => {
    await dropArbiter();
    await expect(putProbePage('probe/broken')).rejects.toThrow(/no unique or exclusion constraint/);

    const r = await repairPagesUpsertArbiter(engine);
    expect(r.repaired).toBe(true);
    expect(r.reason).toBe('restored');

    await putProbePage('probe/healed');
    // Upsert (same slug twice) exercises the restored ON CONFLICT arbiter.
    await putProbePage('probe/healed');
    const page = await engine.getPage('probe/healed', { sourceId: 'default' });
    expect(page).toBeTruthy();
  });

  test('no-op on a healthy brain', async () => {
    const r = await repairPagesUpsertArbiter(engine);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('already_correct');
  });

  test('refuses when duplicate (source_id, slug) rows exist — never deletes rows', async () => {
    await putProbePage('probe/dup');
    await dropArbiter();
    // Sneak a duplicate in through the unprotected window.
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, title, type, frontmatter, compiled_truth, timeline)
       SELECT slug, source_id, title, type, frontmatter, compiled_truth, timeline
         FROM pages WHERE slug = 'probe/dup'`,
    );
    const r = await repairPagesUpsertArbiter(engine);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('duplicates');
    expect(r.duplicateGroups).toBe(1);
    // Both duplicate rows survive — the repair never deletes.
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pages WHERE slug = 'probe/dup'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(2);
    // Clean up the duplicate so the beforeEach repair succeeds for later tests.
    await engine.executeRaw(
      `DELETE FROM pages WHERE id = (SELECT MAX(id) FROM pages WHERE slug = 'probe/dup')`,
    );
  });
});

describe('runMigrations self-heal (#550)', () => {
  test('a fully-migrated brain with a dropped arbiter heals on the next migrate pass', async () => {
    // Stamp the version counter to fully-migrated first (resetPgliteState
    // clears config): the drift must heal on a NO-PENDING pass.
    await runMigrations(engine);
    await dropArbiter();
    await expect(putProbePage('probe/premigrate')).rejects.toThrow(/no unique or exclusion constraint/);

    const out = await runMigrations(engine);
    expect(out.applied).toBe(0); // nothing pending — the self-heal ran anyway

    await putProbePage('probe/postmigrate');
    const page = await engine.getPage('probe/postmigrate', { sourceId: 'default' });
    expect(page).toBeTruthy();
  });
});

describe('doctor pages_upsert_arbiter check (#550)', () => {
  test('ok on a healthy brain', async () => {
    const check = await pagesUpsertArbiterCheck(engine);
    expect(check.status).toBe('ok');
  });

  test('fail with actionable message when the arbiter is missing', async () => {
    await dropArbiter();
    const check = await pagesUpsertArbiterCheck(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('UNIQUE(source_id, slug)');
    expect(check.message).toContain('apply-migrations');
  });
});

describe('#550 residual — catalog validity gates on the arbiter probe', () => {
  test('an INVALID arbiter index does not count (failed CONCURRENTLY remnant shape)', async () => {
    // Healthy first, then flip the catalog validity bit — the exact state a
    // failed CREATE INDEX CONCURRENTLY leaves behind. pg_indexes still
    // renders a normal-looking indexdef for it, but ON CONFLICT cannot use
    // it, so the check must flag needsRepair instead of masking the outage.
    expect((await checkPagesUpsertArbiter(engine)).arbiterPresent).toBe(true);
    await engine.executeRaw(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = 'pages_source_slug_key'::regclass`,
    );
    try {
      const st = await checkPagesUpsertArbiter(engine);
      expect(st.arbiterPresent).toBe(false);
      expect(st.needsRepair).toBe(true);
    } finally {
      await engine.executeRaw(
        `UPDATE pg_index SET indisvalid = true
          WHERE indexrelid = 'pages_source_slug_key'::regclass`,
      );
    }
  });

  test('repair replaces an INVALID arbiter and putPage works again', async () => {
    await engine.executeRaw(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = 'pages_source_slug_key'::regclass`,
    );
    const r = await repairPagesUpsertArbiter(engine);
    expect(r.repaired).toBe(true);
    expect((await checkPagesUpsertArbiter(engine)).arbiterPresent).toBe(true);
    await putProbePage('probe/invalid-heal');
  });

  test('a DEFERRABLE unique constraint does not count (indimmediate = false)', async () => {
    await dropArbiter();
    await engine.executeRaw(
      `ALTER TABLE pages ADD CONSTRAINT pages_deferrable_probe
         UNIQUE (source_id, slug) DEFERRABLE INITIALLY IMMEDIATE`,
    );
    try {
      const st = await checkPagesUpsertArbiter(engine);
      expect(st.arbiterPresent).toBe(false);
      expect(st.needsRepair).toBe(true);
    } finally {
      await engine.executeRaw(
        `ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_deferrable_probe`,
      );
    }
  });

  test('an arbiter on a same-named table in ANOTHER schema does not count', async () => {
    await engine.executeRaw(`CREATE SCHEMA IF NOT EXISTS arbiter_decoy`);
    await engine.executeRaw(
      `CREATE TABLE IF NOT EXISTS arbiter_decoy.pages (
         source_id TEXT NOT NULL, slug TEXT NOT NULL,
         CONSTRAINT decoy_source_slug_key UNIQUE (source_id, slug)
       )`,
    );
    await dropArbiter();
    try {
      const st = await checkPagesUpsertArbiter(engine);
      expect(st.arbiterPresent).toBe(false);
      expect(st.needsRepair).toBe(true);
    } finally {
      await engine.executeRaw(`DROP TABLE IF EXISTS arbiter_decoy.pages`);
      await engine.executeRaw(`DROP SCHEMA IF EXISTS arbiter_decoy`);
    }
  });
});
