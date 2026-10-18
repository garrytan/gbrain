/**
 * The default worktree recovery budget leaves room for a page at the ceiling (Wave B PR 2, fix lane M, item 4).
 *
 * 1. Protects: with `pages.segmented_storage on`, an unset `persistence.limits.worktree_recovery_bytes` reads as twice
 *    the effective `pages.max_bytes` (the engine ceiling when unset) plus headroom per copy, never below 256 MiB, so
 *    a restore of a page at the ceiling (which reserves its file twice) fits; with the switch off it stays 256 MiB. A
 *    configured value is kept as the user's choice, and the 1 GiB brain budget already holds the largest default. A
 *    page already stored in segments keeps the default at twice its body plus headroom after the switch goes off or
 *    `pages.max_bytes` is lowered (soft-deleted too, since a restore brings it back). With the size index missing or
 *    INVALID the limit read leaves `pages` unread (EXPLAIN: never executed) and assumes a page at the ceiling.
 * 2. Fails when: the default stays a flat 256 MiB under a 256 MiB (Postgres) or 128 MiB (PGLite) ceiling, follows a
 *    `pages.max_bytes` above the ceiling, drops below 256 MiB for a lowered `pages.max_bytes`, or overrides a configured
 *    value.
 * 3. Existing coverage: segmented-delete-restore-file.slow.test.ts deletes and restores 27 and 90 MiB pages within the
 *    old budget; recovery-budget-ceiling.slow.test.ts deletes and restores a page the old budget refused.
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { RECOVERY_FILE_HEADROOM_BYTES, SEGMENTED_PAGE_CEILING_BYTES, SEGMENTED_STORAGE_DEFAULT } from '../../src/core/page-body/limits.ts';
import { JOURNAL_LIMITS_SQL, readJournalLimits } from '../../src/core/persistence/limits.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 * 1024;
const OLD_DEFAULT = 256 * MiB;

for (const kind of testBackends()) describe(`worktree recovery default follows the page ceiling (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const ceiling = SEGMENTED_PAGE_CEILING_BYTES[kind];
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%' OR key IN ('pages.segmented_storage','pages.max_bytes')");
  });
  const worktree = async () => (await readJournalLimits(engine)).worktreeRecoveryBytes;

  test('unset follows the default switch: twice the ceiling plus headroom', async () => {
    expect(SEGMENTED_STORAGE_DEFAULT).toBe('on');
    expect(await worktree()).toBe(2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES));
  });

  test('switch off: 256 MiB', async () => {
    await engine.setConfig('pages.segmented_storage', 'off');
    expect(await worktree()).toBe(OLD_DEFAULT);
    await engine.setConfig('pages.max_bytes', String(ceiling));
    expect(await worktree()).toBe(OLD_DEFAULT);
  });

  test('switch on: twice the ceiling plus headroom, so a restore of a page at the ceiling fits', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    const expected = 2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES);
    expect(await worktree()).toBe(expected);
    expect(expected).toBeGreaterThan(OLD_DEFAULT);
    // A restore reserves its file twice plus the record's 4 KiB (coordinator.ts pageRecoveryRecord); a file at the ceiling
    // with a 64 KiB frontmatter fits, which the old default refused on both engines.
    const restoreOfCeilingPage = 2 * (ceiling + 64 * 1024) + 4096;
    expect(restoreOfCeilingPage).toBeLessThanOrEqual(expected);
    expect(restoreOfCeilingPage).toBeGreaterThan(OLD_DEFAULT);
    // The brain-wide budget already holds the largest default, so it is left as it is.
    expect((await readJournalLimits(engine)).brainRecoveryBytes).toBeGreaterThanOrEqual(expected);
  });

  test('pages.max_bytes: a lowered value never drops below 256 MiB, a value above the ceiling clamps to it', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('pages.max_bytes', String(64 * MiB));
    expect(await worktree()).toBe(OLD_DEFAULT);
    await engine.setConfig('pages.max_bytes', String(200 * MiB));
    expect(await worktree()).toBe(Math.max(OLD_DEFAULT, 2 * (Math.min(200 * MiB, ceiling) + RECOVERY_FILE_HEADROOM_BYTES)));
    await engine.setConfig('pages.max_bytes', String(4 * ceiling));
    expect(await worktree()).toBe(2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES));
  });

  test('a stored segmented page keeps room for its restore after the switch goes off or pages.max_bytes is lowered', async () => {
    const slug = 'notes/stored-at-ceiling';
    try {
      expect((await importFromContent(engine, slug, conversationPage(2 * MiB, { seed: 71 }), { noEmbed: true })).status).toBe('imported');
      expect((await engine.executeRaw<{ s: string }>('SELECT body_storage AS s FROM pages WHERE slug=$1', [slug]))[0]!.s).toBe('segmented');
      // A page stored at the ceiling while the switch was on (only its recorded size is read).
      await engine.executeRaw('UPDATE pages SET body_bytes=$2 WHERE slug=$1', [slug, ceiling]);
      const expected = 2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES);
      expect(expected).toBeGreaterThan(OLD_DEFAULT);
      await engine.setConfig('pages.segmented_storage', 'off');
      expect(await worktree()).toBe(expected);
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.setConfig('pages.max_bytes', String(64 * MiB));
      expect(await worktree()).toBe(expected);
      // A soft-deleted page can still be restored, so it still counts; a purged one does not.
      await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE slug=$1', [slug]);
      expect(await worktree()).toBe(expected);
      await engine.setConfig('persistence.limits.worktree_recovery_bytes', String(OLD_DEFAULT));
      expect(await worktree()).toBe(OLD_DEFAULT);
    } finally {
      await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
    }
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.worktree_recovery_bytes'");
    expect(await worktree()).toBe(OLD_DEFAULT);
  }, 120_000);

  test('with pages_segmented_body_bytes_idx missing or invalid, the default never scans pages: it assumes a stored page at the ceiling', async () => {
    const slug = 'notes/stored-unindexed';
    const plan = async () => (await engine.executeRaw<Record<string, string>>(`EXPLAIN (ANALYZE, COSTS OFF) ${JOURNAL_LIMITS_SQL}`)).map(row => Object.values(row)[0]!);
    const pagesNodes = async () => (await plan()).filter(line => / on pages\b/.test(line));
    try {
      expect((await importFromContent(engine, slug, conversationPage(2 * MiB, { seed: 72 }), { noEmbed: true })).status).toBe('imported');
      await engine.setConfig('pages.segmented_storage', 'off');
      expect(await worktree()).toBe(OLD_DEFAULT);
      await engine.executeRaw('DROP INDEX pages_segmented_body_bytes_idx');
      const nodes = await pagesNodes();
      expect(nodes.length).toBeGreaterThan(0);
      for (const line of nodes) expect(line).toContain('never executed');
      expect(await worktree()).toBe(2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES));
    } finally {
      await engine.executeRaw("CREATE INDEX IF NOT EXISTS pages_segmented_body_bytes_idx ON pages (body_bytes) WHERE body_storage = 'segmented'");
      await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
    }
    expect(await worktree()).toBe(OLD_DEFAULT);
  }, 120_000);

  test('a configured worktree_recovery_bytes is the user\'s choice', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('persistence.limits.worktree_recovery_bytes', String(OLD_DEFAULT));
    expect(await worktree()).toBe(OLD_DEFAULT);
    await engine.setConfig('persistence.limits.worktree_recovery_bytes', '1048576');
    expect(await worktree()).toBe(1048576);
  });
});
