/**
 * v0.26.5 — destructive-guard unit tests.
 *
 * Source-level guard against accidental data loss. Three layers:
 *  1. Impact assessment (counts pages/chunks/embeddings/files for a source)
 *  2. Confirmation gate (`--confirm-destructive` required when data exists;
 *     `--yes` alone rejected)
 *  3. Soft-delete with 72h TTL (column-based as of v0.26.5; JSONB shape was
 *     migrated in v33)
 *
 * Run against PGLite — the contract logic is identical on Postgres but
 * PGLite is fast + DATABASE_URL-free. Postgres-specific paths (CONCURRENTLY,
 * RLS) are covered separately by E2E tests.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gbrainPath } from '../src/core/config.ts';
import {
  assessDestructiveImpact,
  checkDestructiveConfirmation,
  softDeleteSource,
  restoreSource,
  listArchivedSources,
  purgeExpiredSources,
  formatImpact,
  formatSoftDelete,
  clientsReferencingSource,
  formatClientReferentsBlock,
  SOFT_DELETE_TTL_HOURS,
  type DestructiveImpact,
} from '../src/core/destructive-guard.ts';

// Tier 3 opt-out — these tests need the cold-init schema path so the v33
// migration columns exist on the brain under test.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

async function setupBrain(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function seedSource(engine: PGLiteEngine, id: string, opts?: { withPages?: number }): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [id, id],
  );
  const count = opts?.withPages ?? 0;
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ($1, $2, 'note', $3)`,
      [id, `${id}/page-${i}`, `Page ${i}`],
    );
  }
}

async function setRawSourceConfig(engine: PGLiteEngine, id: string, rawJson: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = $2::text::jsonb WHERE id = $1`,
    [id, rawJson],
  );
}

async function readSourceConfig(engine: PGLiteEngine, id: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [id],
  );
  const config = rows[0].config;
  return typeof config === 'string' ? JSON.parse(config) : config as Record<string, unknown>;
}

describe('assessDestructiveImpact', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('returns null for a non-existent source', async () => {
    const impact = await assessDestructiveImpact(engine, 'aim-does-not-exist');
    expect(impact).toBeNull();
  });

  test('counts zero across the board for an empty source', async () => {
    await seedSource(engine, 'aim-empty', { withPages: 0 });
    const impact = await assessDestructiveImpact(engine, 'aim-empty');
    expect(impact).not.toBeNull();
    expect(impact!.pageCount).toBe(0);
    expect(impact!.chunkCount).toBe(0);
    expect(impact!.embeddingCount).toBe(0);
    expect(impact!.fileCount).toBe(0);
    // Empty-source summary is the safe message, not the "permanently delete" warning.
    expect(impact!.summary).toContain('safe to remove');
  });

  test('counts pages correctly for a populated source', async () => {
    await seedSource(engine, 'aim-populated', { withPages: 3 });
    const impact = await assessDestructiveImpact(engine, 'aim-populated');
    expect(impact!.pageCount).toBe(3);
    expect(impact!.summary).toContain('3 pages');
    expect(impact!.summary).toContain('permanently delete');
  });

  test('source-scopes pages — multi-source isolation', async () => {
    await seedSource(engine, 'aim-src-a', { withPages: 2 });
    await seedSource(engine, 'aim-src-b', { withPages: 5 });
    const a = await assessDestructiveImpact(engine, 'aim-src-a');
    const b = await assessDestructiveImpact(engine, 'aim-src-b');
    expect(a!.pageCount).toBe(2);
    expect(b!.pageCount).toBe(5);
  });

  test('counts facts — a zero-page fact-holding source is data at risk, not "safe to remove"', async () => {
    // Revoked-agent-workspace shape: zero pages, facts present (the primary
    // agent write lane). Pre-fix the preview said "safe to remove" while the
    // delete would cascade the facts away.
    await seedSource(engine, 'aim-facts-only', { withPages: 0 });
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source) VALUES ($1, 'agent memory row', 'test'), ($1, 'second memory row', 'test')`,
      ['aim-facts-only'],
    );
    const impact = await assessDestructiveImpact(engine, 'aim-facts-only');
    expect(impact!.pageCount).toBe(0);
    expect(impact!.factCount).toBe(2);
    expect(impact!.summary).toContain('2 facts');
    expect(impact!.summary).toContain('permanently delete');
    expect(impact!.summary).not.toContain('safe to remove');
  });
});

describe('checkDestructiveConfirmation (gate truth table)', () => {
  const populated: DestructiveImpact = {
    sourceId: 'has-data',
    sourceName: 'has-data',
    pageCount: 100,
    chunkCount: 500,
    embeddingCount: 500,
    fileCount: 0,
    summary: '⚠️  This will permanently delete: 100 pages, 500 chunks, 500 embeddings',
  };

  const empty: DestructiveImpact = {
    sourceId: 'no-data',
    sourceName: 'no-data',
    pageCount: 0,
    chunkCount: 0,
    embeddingCount: 0,
    fileCount: 0,
    summary: 'Source "no-data" has no data (safe to remove).',
  };

  test('dry-run always passes regardless of flags', () => {
    expect(checkDestructiveConfirmation(populated, { dryRun: true })).toBeNull();
    expect(checkDestructiveConfirmation(populated, { yes: true, dryRun: true })).toBeNull();
  });

  test('empty source passes without --confirm-destructive', () => {
    expect(checkDestructiveConfirmation(empty, {})).toBeNull();
    expect(checkDestructiveConfirmation(empty, { yes: true })).toBeNull();
  });

  test('--confirm-destructive passes regardless of --yes', () => {
    expect(checkDestructiveConfirmation(populated, { confirmDestructive: true })).toBeNull();
    expect(checkDestructiveConfirmation(populated, { yes: true, confirmDestructive: true })).toBeNull();
  });

  test('--yes alone with data is REJECTED with guidance message', () => {
    const msg = checkDestructiveConfirmation(populated, { yes: true });
    expect(msg).not.toBeNull();
    expect(msg).toContain('--confirm-destructive');
    expect(msg).toContain('archive');
  });

  test('no flags + populated source rejects', () => {
    const msg = checkDestructiveConfirmation(populated, {});
    expect(msg).not.toBeNull();
    expect(msg).toContain('--confirm-destructive');
  });

  test('a fact-only source requires --confirm-destructive (facts gate exactly like pages)', () => {
    const factOnly: DestructiveImpact = {
      sourceId: 'revoked-agent-workspace',
      sourceName: 'revoked-agent-workspace',
      pageCount: 0,
      chunkCount: 0,
      embeddingCount: 0,
      fileCount: 0,
      factCount: 7,
      summary: '⚠️  This will permanently delete: 7 facts',
    };
    // No flags → blocked; --yes alone → still blocked (mirrors pages).
    expect(checkDestructiveConfirmation(factOnly, {})).toContain('--confirm-destructive');
    expect(checkDestructiveConfirmation(factOnly, { yes: true })).toContain('--confirm-destructive');
    // --confirm-destructive and --dry-run pass.
    expect(checkDestructiveConfirmation(factOnly, { confirmDestructive: true })).toBeNull();
    expect(checkDestructiveConfirmation(factOnly, { dryRun: true })).toBeNull();
    // Hand-built literal WITHOUT factCount stays valid (optional field, ?? 0).
    expect(checkDestructiveConfirmation({ ...factOnly, factCount: undefined }, { yes: true })).toBeNull();
  });
});

describe('soft-delete + restore lifecycle (column-based v0.26.5)', () => {
  // ONE engine for the whole describe — cold init runs ~29 migrations, ~3s.
  // Each test uses a unique source id so they don't cross-pollute.
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('softDeleteSource flips column shape + sets TTL', async () => {
    const id = 'sd-flips';
    await seedSource(engine, id, { withPages: 2 });
    const before = Date.now();
    const result = await softDeleteSource(engine, id);
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.pageCount).toBe(2);
    const ttlMs = SOFT_DELETE_TTL_HOURS * 60 * 60 * 1000;
    expect(result!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 1000);
    expect(result!.expiresAt.getTime()).toBeLessThanOrEqual(after + ttlMs + 1000);
    const rows = await engine.executeRaw<{ archived: boolean; archived_at: string }>(
      `SELECT archived, archived_at FROM sources WHERE id = $1`,
      [id],
    );
    expect(rows[0].archived).toBe(true);
    expect(rows[0].archived_at).not.toBeNull();
  });

  test('softDeleteSource is idempotent-as-null on already-archived', async () => {
    const id = 'sd-idem';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    expect(await softDeleteSource(engine, id)).toBeNull();
  });

  test('softDeleteSource returns null for unknown source', async () => {
    expect(await softDeleteSource(engine, 'sd-unknown-xyz')).toBeNull();
  });

  test('softDeleteSource flips federated:false in JSONB but archived state is column-based', async () => {
    const id = 'sd-jsonb';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    const rows = await engine.executeRaw<{ config: any; archived: boolean }>(
      `SELECT config, archived FROM sources WHERE id = $1`,
      [id],
    );
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(false);
    expect(rows[0].archived).toBe(true);
    // Issue 5 contract: archived must NOT live in config any more.
    expect(config.archived).toBeUndefined();
    expect(config.archived_at).toBeUndefined();
  });

  test('softDeleteSource normalizes nested-string config without dropping keys', async () => {
    const id = 'sd-string-config';
    await seedSource(engine, id);
    await setRawSourceConfig(
      engine,
      id,
      JSON.stringify(JSON.stringify({ federated: true, remote_url: 'https://example.invalid/repo' })),
    );
    await softDeleteSource(engine, id);
    expect(await readSourceConfig(engine, id)).toEqual({
      federated: false,
      remote_url: 'https://example.invalid/repo',
    });
  });

  test('softDeleteSource flattens recoverable array config without dropping keys', async () => {
    const id = 'sd-array-config';
    await seedSource(engine, id);
    await setRawSourceConfig(engine, id, JSON.stringify([
      '{"remote_url":"https://example.invalid/repo"}',
      { tracked_branch: 'main' },
      { federated: true },
      'not-json',
    ]));
    await softDeleteSource(engine, id);
    expect(await readSourceConfig(engine, id)).toEqual({
      federated: false,
      remote_url: 'https://example.invalid/repo',
      tracked_branch: 'main',
    });
  });

  test('restoreSource clears the column state and re-federates by default', async () => {
    const id = 'sd-restore-fed';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    expect(await restoreSource(engine, id)).toBe(true);
    const rows = await engine.executeRaw<{ archived: boolean; archived_at: string | null; config: any }>(
      `SELECT archived, archived_at, config FROM sources WHERE id = $1`,
      [id],
    );
    expect(rows[0].archived).toBe(false);
    expect(rows[0].archived_at).toBeNull();
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(true);
  });

  test('restoreSource respects --no-federate (refederate=false)', async () => {
    const id = 'sd-no-fed';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    await restoreSource(engine, id, false);
    const rows = await engine.executeRaw<{ config: any }>(
      `SELECT config FROM sources WHERE id = $1`,
      [id],
    );
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(false);
  });

  test('restoreSource repairs array config and preserves recoverable keys', async () => {
    const id = 'sd-restore-array';
    await seedSource(engine, id);
    await engine.executeRaw(
      `UPDATE sources
          SET archived = true,
              archived_at = now(),
              archive_expires_at = now() + interval '1 hour'
        WHERE id = $1`,
      [id],
    );
    await setRawSourceConfig(engine, id, JSON.stringify([
      { remote_url: 'https://example.invalid/repo' },
      '{"federated":false,"tracked_branch":"main"}',
    ]));
    expect(await restoreSource(engine, id)).toBe(true);
    expect(await readSourceConfig(engine, id)).toEqual({
      federated: true,
      remote_url: 'https://example.invalid/repo',
      tracked_branch: 'main',
    });
  });

  test('restoreSource is idempotent-as-false on already-active', async () => {
    const id = 'sd-active';
    await seedSource(engine, id);
    expect(await restoreSource(engine, id)).toBe(false);
  });

  test('listArchivedSources filters via the archived column, not JSONB', async () => {
    const archivedId = 'la-archived';
    const liveId = 'la-live';
    await seedSource(engine, archivedId, { withPages: 3 });
    await seedSource(engine, liveId, { withPages: 1 });
    await softDeleteSource(engine, archivedId);
    const archived = await listArchivedSources(engine);
    const ids = archived.map((a) => a.id);
    expect(ids).toContain(archivedId);
    expect(ids).not.toContain(liveId);
    const archivedRow = archived.find((a) => a.id === archivedId)!;
    expect(archivedRow.pageCount).toBe(3);
  });

  test('purgeExpiredSources only deletes rows with archive_expires_at <= now()', async () => {
    const expiredId = 'pe-expired';
    const recoverableId = 'pe-recoverable';
    await seedSource(engine, expiredId, { withPages: 2 });
    await seedSource(engine, recoverableId, { withPages: 1 });
    await softDeleteSource(engine, expiredId);
    await softDeleteSource(engine, recoverableId);
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() - INTERVAL '1 hour' WHERE id = $1`,
      [expiredId],
    );
    const { purged, blocked } = await purgeExpiredSources(engine);
    expect(purged).toContain(expiredId);
    expect(purged).not.toContain(recoverableId);
    expect(blocked).toEqual([]);
    const remainingPages = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      [expiredId],
    );
    expect(remainingPages[0].n).toBe(0);
  });

  test('gbrain#4115 — an FK-blocked source is reported and skipped; the deletable one still purges', async () => {
    const blockedId = 'pe-fk-blocked';
    const deletableId = 'pe-fk-deletable';
    await seedSource(engine, blockedId, { withPages: 1 });
    await seedSource(engine, deletableId, { withPages: 1 });
    await softDeleteSource(engine, blockedId);
    await softDeleteSource(engine, deletableId);
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() - INTERVAL '1 hour' WHERE id IN ($1, $2)`,
      [blockedId, deletableId],
    );
    // A revoked-but-retained oauth client (soft-deleted via deleted_at) under
    // v64's ON DELETE RESTRICT — the exact production shape from the report.
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, source_id, deleted_at)
       VALUES ('cl-4115-test', 'test client', $1, now())`,
      [blockedId],
    );
    const { purged, blocked } = await purgeExpiredSources(engine);
    expect(purged).toContain(deletableId);
    expect(purged).not.toContain(blockedId);
    expect(blocked.map((b) => b.id)).toEqual([blockedId]);
    expect(blocked[0].reason).toContain('RESTRICT');
    // The blocked source is untouched (still archived, still expired) — the
    // next sweep retries it after the operator clears the client.
    const still = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sources WHERE id = $1 AND archived = true`,
      [blockedId],
    );
    expect(still[0].n).toBe(1);
    // Cleanup so later tests are unaffected.
    await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = 'cl-4115-test'`);
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [blockedId]);
  });

  test('purgeExpiredSources is no-op when nothing is past TTL', async () => {
    // After all earlier tests, there may still be archived rows whose
    // archive_expires_at is in the future. Force-update any leftover-past
    // rows OUT of expiration before this assertion (we only want to test
    // the no-op return here, not interfere with prior test state).
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() + INTERVAL '72 hours' WHERE archived = true`,
    );
    const result = await purgeExpiredSources(engine);
    expect(result.purged).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  test('gbrain#4115 — a NON-FK error re-raises instead of reading as blocked (review gap G8)', async () => {
    const stub = {
      async executeRaw(sql: string): Promise<Array<{ id: string }>> {
        if (sql.trimStart().startsWith('SELECT')) return [{ id: 'boom' }];
        const err = new Error('canceling statement due to statement timeout') as Error & { code: string };
        err.code = '57014'; // query_canceled — NOT the FK class
        throw err;
      },
    } as never;
    await expect(purgeExpiredSources(stub)).rejects.toThrow('statement timeout');
  });

  test('gbrain#4115 — a source restored between SELECT and DELETE is neither purged nor blocked (review gap G8)', async () => {
    const stub = {
      async executeRaw(sql: string): Promise<Array<{ id: string }>> {
        if (sql.trimStart().startsWith('SELECT')) return [{ id: 'restored-mid-sweep' }];
        return []; // per-id DELETE re-checks the expiry predicate → 0 rows
      },
    } as never;
    const { purged, blocked } = await purgeExpiredSources(stub);
    expect(purged).toEqual([]);
    expect(blocked).toEqual([]);
  });
});

// ── PR6 D5b: FK-RESTRICT lifecycle ──────────────────────────
// oauth_clients.source_id is ON DELETE RESTRICT; the guard must surface the
// block BEFORE a hard delete instead of letting the raw FK violation escape.

describe('FK-RESTRICT lifecycle (clientsReferencingSource + purge skip)', () => {
  // Own engine — the soft-delete describe's purge tests mutate every
  // archived row's expiry; don't cross-pollute.
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  async function seedClient(
    clientId: string,
    sourceId: string | null,
    opts?: { deleted?: boolean },
  ): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, source_id, deleted_at)
       VALUES ($1, $2, $3, ${opts?.deleted ? 'now()' : 'NULL'})
       ON CONFLICT (client_id) DO NOTHING`,
      [clientId, `${clientId}-name`, sourceId],
    );
  }

  test('clientsReferencingSource returns ALL physical referents (soft-deleted tagged), scoped to the source', async () => {
    await seedSource(engine, 'fk-ref-a');
    await seedSource(engine, 'fk-ref-b');
    await seedClient('cl-live-1', 'fk-ref-a');
    await seedClient('cl-live-2', 'fk-ref-a');
    await seedClient('cl-dead', 'fk-ref-a', { deleted: true });
    await seedClient('cl-other-src', 'fk-ref-b');
    await seedClient('cl-no-src', null);

    // PHYSICAL semantics: the soft-deleted row still holds the FK, so it is
    // returned too — tagged deleted:true, never silently dropped.
    const refs = await clientsReferencingSource(engine, 'fk-ref-a');
    expect(refs).toEqual([
      { clientId: 'cl-dead', clientName: 'cl-dead-name', deleted: true },
      { clientId: 'cl-live-1', clientName: 'cl-live-1-name', deleted: false },
      { clientId: 'cl-live-2', clientName: 'cl-live-2-name', deleted: false },
    ]);
    expect(await clientsReferencingSource(engine, 'fk-ref-none')).toEqual([]);
  });

  test('a soft-deleted referent alone BLOCKS the remove/purge pre-check with the retained-row guidance', async () => {
    await seedSource(engine, 'fk-soft-only', { withPages: 1 });
    await seedClient('cl-soft-only', 'fk-soft-only', { deleted: true });

    // The pre-check truth (sources.ts blocks on referents.length > 0): the
    // helper must return the soft-deleted row, because the FK ignores
    // deleted_at and the hard delete WOULD fail at the database.
    const refs = await clientsReferencingSource(engine, 'fk-soft-only');
    expect(refs).toEqual([
      { clientId: 'cl-soft-only', clientName: 'cl-soft-only-name', deleted: true },
    ]);

    const block = formatClientReferentsBlock('fk-soft-only', refs);
    expect(block).toContain('Cannot delete source "fk-soft-only"');
    expect(block).toContain('Revoked-but-retained rows still block the FK');
    expect(block).toContain('hard-deletes them');
    expect(block).toContain('gbrain auth revoke-client "cl-soft-only"');
    // No live rows → no live-revoke section.
    expect(block).not.toContain('Revoke each live client first');
  });

  test('assessDestructiveImpact folds the referent count; formatImpact shows it', async () => {
    await seedSource(engine, 'fk-impact', { withPages: 1 });
    await seedClient('cl-impact', 'fk-impact');

    const impact = await assessDestructiveImpact(engine, 'fk-impact');
    expect(impact).not.toBeNull();
    expect(impact!.oauthClientCount).toBe(1);

    const out = formatImpact(impact!);
    expect(out).toContain('1 OAuth client(s) reference this source');
    expect(out).toContain('revoke-client');
  });

  test('assessDestructiveImpact reports zero referents for an unreferenced source', async () => {
    await seedSource(engine, 'fk-unref', { withPages: 1 });
    const impact = await assessDestructiveImpact(engine, 'fk-unref');
    expect(impact!.oauthClientCount).toBe(0);
    expect(formatImpact(impact!)).not.toContain('OAuth client');
  });

  test('purgeExpiredSources purges only the unreferenced expired source and reports the FK-held one as blocked', async () => {
    // Ported from #4238's string[]-contract version at merge: the sweep now
    // returns {purged, blocked} (chennai #4115 fix) — the skipped id and its
    // revoke guidance live in the structured result, not a stderr warn
    // (callers render it).
    await seedSource(engine, 'fk-purge-ref', { withPages: 1 });
    await seedSource(engine, 'fk-purge-free', { withPages: 1 });
    await seedClient('cl-purge-ref', 'fk-purge-ref');
    await softDeleteSource(engine, 'fk-purge-ref');
    await softDeleteSource(engine, 'fk-purge-free');
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() - INTERVAL '1 hour' WHERE id = ANY($1::text[])`,
      [['fk-purge-ref', 'fk-purge-free']],
    );

    const { purged, blocked } = await purgeExpiredSources(engine);

    expect(purged).toEqual(['fk-purge-free']);
    expect(blocked.map((b) => b.id)).toEqual(['fk-purge-ref']);
    expect(blocked[0].reason).toContain('revoke-client');

    // Referenced source survives (blocked, not FK-crashed).
    const remaining = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = ANY($1::text[])`,
      [['fk-purge-ref', 'fk-purge-free']],
    );
    expect(remaining.map((r) => r.id)).toEqual(['fk-purge-ref']);
  });

  test('purge block is PHYSICAL: a soft-deleted client row still blocks (FK ignores deleted_at)', async () => {
    await seedSource(engine, 'fk-purge-dead', { withPages: 1 });
    await seedClient('cl-purge-dead', 'fk-purge-dead', { deleted: true });
    await softDeleteSource(engine, 'fk-purge-dead');
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() - INTERVAL '1 hour' WHERE id = $1`,
      ['fk-purge-dead'],
    );

    const { purged, blocked } = await purgeExpiredSources(engine);

    expect(purged).not.toContain('fk-purge-dead');
    expect(blocked.map((b) => b.id)).toContain('fk-purge-dead');
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1`, ['fk-purge-dead'],
    );
    expect(rows.length).toBe(1);
  });

  test('formatClientReferentsBlock lists clients + per-client revoke commands, split by liveness', () => {
    const block = formatClientReferentsBlock('acme-example', [
      { clientId: 'client-1', clientName: 'Agent One', deleted: false },
      { clientId: 'client-2', clientName: 'Agent Two', deleted: true },
    ]);
    expect(block).toContain('Cannot delete source "acme-example"');
    expect(block).toContain('2 OAuth client(s) reference this source');
    expect(block).toContain('Agent One (client-1)');
    expect(block).toContain('Agent Two (client-2)  [revoked, retained]');
    // Live rows get the hard-delete revoke guidance...
    expect(block).toContain('Revoke each live client first');
    expect(block).toContain('gbrain auth revoke-client "client-1"');
    // ...soft-deleted rows get the retained-rows-still-block guidance.
    expect(block).toContain('Revoked-but-retained rows still block the FK');
    expect(block).toContain('gbrain auth revoke-client "client-2"');
  });

  test('degrade ladder: missing oauth_clients table → [], missing deleted_at → all referents, other errors propagate', async () => {
    // Pre-oauth brain: no oauth_clients table at all → no referents by
    // construction (isUndefinedTableError arm).
    const noTable = {
      executeRaw: async () => {
        throw Object.assign(new Error('relation "oauth_clients" does not exist'), { code: '42P01' });
      },
    } as any;
    expect(await clientsReferencingSource(noTable, 'x')).toEqual([]);

    // Pre-migration brain: deleted_at column missing → falls back to ALL
    // referents (the 42703-retry idiom), tagged live (deleted:false — the
    // column that would say otherwise doesn't exist).
    const noColumn = {
      executeRaw: async (sql: string) => {
        if (sql.includes('deleted_at')) {
          throw Object.assign(new Error('column "deleted_at" does not exist'), { code: '42703' });
        }
        return [{ client_id: 'c1', client_name: 'n1' }];
      },
    } as any;
    expect(await clientsReferencingSource(noColumn, 'x')).toEqual([
      { clientId: 'c1', clientName: 'n1', deleted: false },
    ]);

    // Anything else (e.g. a dropped connection) must PROPAGATE — a swallowed
    // error here would let a hard delete proceed past live referents.
    const broken = {
      executeRaw: async () => { throw new Error('connection reset'); },
    } as any;
    await expect(clientsReferencingSource(broken, 'x')).rejects.toThrow('connection reset');
  });

  test('missing source_id column → [] (no column ⇒ no FK ⇒ no referents)', async () => {
    // Pre-v61 brain: oauth_clients exists but has no source_id column at all.
    const noSourceId = {
      executeRaw: async () => {
        throw Object.assign(new Error('column "source_id" does not exist'), { code: '42703' });
      },
    } as any;
    expect(await clientsReferencingSource(noSourceId, 'x')).toEqual([]);

    // Same brain shape must not break the purge path either. The per-source
    // sweep (chennai #4115) never queries oauth_clients at all — the FK, if
    // present, surfaces as SQLSTATE 23503 on the DELETE — so a pre-v61 brain
    // shape purges through the exact same code path.
    let sawOauthQuery = false;
    const purgeStub = {
      executeRaw: async (sql: string) => {
        if (sql.includes('oauth_clients')) sawOauthQuery = true;
        return [];
      },
    } as any;
    expect(await purgeExpiredSources(purgeStub)).toEqual({ purged: [], blocked: [] });
    expect(sawOauthQuery).toBe(false);
  });
});

describe('formatters (display helpers)', () => {
  test('formatImpact renders the boxed preview with the source id and counts', () => {
    const impact: DestructiveImpact = {
      sourceId: 'media-corpus',
      sourceName: 'Media Corpus',
      pageCount: 5033,
      chunkCount: 22000,
      embeddingCount: 22000,
      fileCount: 0,
      summary: '⚠️  This will permanently delete: 5,033 pages, 22,000 chunks, 22,000 embeddings',
    };
    const out = formatImpact(impact);
    expect(out).toContain('Media Corpus');
    expect(out).toContain('media-corpus');
    expect(out).toContain('5,033');
    expect(out).toContain('22,000');
    expect(out).toContain('DESTRUCTIVE OPERATION');
    // cathedral-6: the box renders a Facts row (0 for a literal without it).
    expect(out).toMatch(/Facts:\s+0/);
  });

  test('formatImpact renders the facts count (mirrors the page-count line)', () => {
    const impact: DestructiveImpact = {
      sourceId: 'revoked-agent-workspace',
      sourceName: 'revoked-agent-workspace',
      pageCount: 0,
      chunkCount: 0,
      embeddingCount: 0,
      fileCount: 0,
      factCount: 1234,
      summary: '⚠️  This will permanently delete: 1,234 facts',
    };
    const out = formatImpact(impact);
    expect(out).toMatch(/Facts:\s+1,234/);
  });

  test('sources remove orders the row DELETE (in-tx) BEFORE external teardown (F1 structural pin)', () => {
    // A concurrent registration between the referents pre-check and the
    // DELETE must surface as the refusal, never as destroyed scaffolding
    // with the row still present — so the tx'd DELETE precedes unharden.
    const { readFileSync } = require('fs');
    const src = readFileSync(new URL('../src/commands/sources.ts', import.meta.url), 'utf-8');
    const removeStart = src.indexOf('async function runRemove');
    const removeEnd = src.indexOf('async function', removeStart + 1);
    const body = src.slice(removeStart, removeEnd);
    const deleteIdx = body.indexOf(`DELETE FROM sources WHERE id = $1`);
    const teardownIdx = body.indexOf('unhardenBrainRepo');
    expect(deleteIdx).toBeGreaterThan(0);
    expect(teardownIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeLessThan(teardownIdx);
    // And the DELETE runs inside engine.transaction (atomic with the re-check).
    const txIdx = body.indexOf('engine.transaction');
    expect(txIdx).toBeGreaterThan(0);
    expect(txIdx).toBeLessThan(deleteIdx);
  });

  test('formatSoftDelete renders the post-archive guidance with restore command', () => {
    const out = formatSoftDelete({
      id: 'src-a',
      name: 'src-a',
      deletedAt: new Date(),
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      pageCount: 100,
    });
    expect(out).toContain('archived');
    expect(out).toContain('restore src-a');
    expect(out).toContain('72');
  });
});

// ── Purge clone-cleanup containment ─────────────────────────
// gh_managed cleanup must never rm -rf the clone root itself (a corrupt row
// with local_path = the root would wipe every mirror), and only deletes the
// exact defaultCloneDir('<id>-github') shape the creation path pins.

describe('purgeExpiredSources — clone cleanup containment', () => {
  function purgeStubFor(id: string, localPath: string) {
    return {
      executeRaw: async (sql: string) => {
        if (sql.trimStart().startsWith('SELECT')) {
          return [{ id, config: { kind: 'github', gh_managed: true }, local_path: localPath }];
        }
        return [{ id }];
      },
    } as never;
  }

  test('a corrupt row whose local_path IS the clone root never deletes sibling mirrors; the pinned shape still cleans up', async () => {
    const prevHome = process.env.GBRAIN_HOME;
    const homeParent = mkdtempSync(join(tmpdir(), 'gb-purge-guard-'));
    process.env.GBRAIN_HOME = homeParent;
    try {
      const cloneRoot = gbrainPath('clones');
      const sibling = join(cloneRoot, 'sibling-mirror-github');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'page.md'), 'survives');

      // Corrupt row: local_path = the managed clone root itself. Pre-fix this
      // passed isPathContained (equality accepted) and rm -rf'd every mirror.
      const r1 = await purgeExpiredSources(purgeStubFor('corrupt-src', cloneRoot));
      expect(r1.purged).toEqual(['corrupt-src']);
      expect(existsSync(join(sibling, 'page.md'))).toBe(true);

      // Strictly contained but NOT the pinned '<id>-github' shape → refused.
      const r2 = await purgeExpiredSources(purgeStubFor('other-src', sibling));
      expect(r2.purged).toEqual(['other-src']);
      expect(existsSync(sibling)).toBe(true);

      // The exact gh_managed creation shape still gets cleaned up.
      const owned = join(cloneRoot, 'gone-src-github');
      mkdirSync(owned, { recursive: true });
      writeFileSync(join(owned, 'page.md'), 'removed');
      const r3 = await purgeExpiredSources(purgeStubFor('gone-src', owned));
      expect(r3.purged).toEqual(['gone-src']);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(cloneRoot)).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prevHome;
      rmSync(homeParent, { recursive: true, force: true });
    }
  });
});
