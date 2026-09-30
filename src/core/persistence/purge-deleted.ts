import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { submitPageMutation } from './page-mutations.ts';

/** A tombstone that moved under a concurrent writer; the next run retries it. */
const DEFERRAL_CODES = new Set(['revision_conflict', 'page_not_found', 'page_identity_changed']);

export interface DeletedPagePurge {
  slugs: string[];
  count: number;
  /** Every expired tombstone not purged this run, with its reason. Empty on an unmanaged brain. */
  blocked: Array<{ source_id: string; slug: string; reason: string; code: string | null }>;
  /** Tombstones restored, changed or removed by a concurrent writer; retried next run. */
  deferred: number;
  /** Operational failures (owner, binding, storage, protocol). */
  failed: number;
  /** Present when `failed > 0`, so the caller cannot report success. */
  error?: { class: string; code: string; message: string };
}

/**
 * #5405: hard-delete tombstones older than the recovery window. An unmanaged
 * brain keeps the engine's bulk delete. A managed brain refuses that bulk
 * delete, so each expired tombstone is purged through the coordinator with the
 * trusted-local `delete_page --purge` protocol, bound to the tombstone's
 * revision. Pages in archived sources are left to the source-lifecycle purge.
 * A tombstone that cannot be purged is reported, never forced.
 */
export async function purgeDeletedPagesCoordinated(engine: BrainEngine, olderThanHours: number): Promise<DeletedPagePurge> {
  if (!await managedPersistenceEnabled(engine)) {
    const result = await engine.purgeDeletedPages(olderThanHours);
    return { slugs: result.slugs, count: result.count, blocked: [], deferred: 0, failed: 0 };
  }
  const hours = Math.max(0, Math.floor(olderThanHours));
  const rows = await engine.executeRaw<{ source_id: string; slug: string; cutoff: string }>(
    `SELECT p.source_id, p.slug, (now() - ($1 || ' hours')::interval)::text AS cutoff FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND NOT s.archived
      ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [String(hours)]);
  const config = loadConfig() ?? { engine: engine.kind };
  const slugs: string[] = [];
  const blocked: DeletedPagePurge['blocked'] = [];
  let deferred = 0, failed = 0;
  for (const row of rows) {
    try {
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      if (!snapshot?.page.deleted_at) continue;
      // Restored and deleted again since the scan: its recovery window restarted.
      if (new Date(snapshot.page.deleted_at).getTime() >= new Date(row.cutoff).getTime()) { deferred++; continue; }
      const ctx: OperationContext = { engine, config, remote: false, sourceId: row.source_id, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: row.slug, source_id: row.source_id,
        purge: true, expected_revision: snapshot.revision, request_id: randomUUID() } });
      slugs.push(row.slug);
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null;
      if (code && DEFERRAL_CODES.has(code)) deferred++; else failed++;
      blocked.push({ source_id: row.source_id, slug: row.slug, code, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const failures = blocked.filter(b => !b.code || !DEFERRAL_CODES.has(b.code));
  const error = failed > 0 ? { class: 'ManagedPurgeFailed', code: 'managed_purge_failed',
    message: `${failed} expired page(s) could not be purged through the coordinator: ${failures.slice(0, 3)
      .map(b => `${b.source_id}/${b.slug}: ${b.reason}`).join('; ')}` } : undefined;
  return { slugs, count: slugs.length, blocked, deferred, failed, ...(error ? { error } : {}) };
}
