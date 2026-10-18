/**
 * sync_freshness and read-only skill-pack sources (#6076, wave 18b 1.3).
 *
 * Protects: a source holding an adopted skill pack whose content is a
 * read-only catalog (no commit history: `last_commit` NULL, and no `.git`
 * under its root when doctor may read the checkout) is exempt from freshness,
 * next to writer-owned content, while a git-backed pack or a source with no
 * pack is still judged stale. A failing adopted-pack read exempts nothing and
 * leaves a note instead of failing the whole check.
 * Fails when: the exemption is dropped (the catalog fails freshness after 3
 * days) or widened (a git-backed pack hides staleness).
 * Seams: real PGLite (and Postgres through test/postgres-unit-arms.txt) with
 * the pack rows written directly (publication triggers suppressed), plus an
 * engine proxy whose adopted-pack read throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

async function withoutTriggers(engine: BrainEngine, run: (tx: BrainEngine) => Promise<void>): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await run(tx);
  });
}

const FIVE_DAYS_AGO = new Date(Date.now() - 5 * 24 * 3600_000);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: sync_freshness and read-only skill-pack sources (#6076)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
    }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      await withoutTriggers(engine, async (tx) => {
        await tx.executeRaw('DELETE FROM shared_skill_heads');
        await tx.executeRaw('DELETE FROM shared_skill_packs');
        await tx.executeRaw("DELETE FROM pages WHERE source_id <> 'default'");
        await tx.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      });
    });

    async function addSource(id: string, opts: { lastCommit?: string | null; localPath?: string } = {}): Promise<string> {
      const [row] = await engine.executeRaw<{ incarnation: string }>(
        `INSERT INTO sources (id, name, local_path, last_sync_at, last_commit, config)
         VALUES ($1, $1, $2, $3, $4, '{"federated":false}'::jsonb) RETURNING incarnation::text AS incarnation`,
        [id, opts.localPath ?? `/tmp/gbrain-test-${id}`, FIVE_DAYS_AGO, opts.lastCommit ?? null]);
      return row!.incarnation;
    }

    async function adoptPack(sourceId: string, incarnation: string): Promise<void> {
      await withoutTriggers(engine, async (tx) => {
        await tx.executeRaw(
          `INSERT INTO shared_skill_packs (source_id, source_incarnation, pack_id, revision, manifest, manifest_hash)
           VALUES ($1, $2::uuid, 'pack-example', $3::uuid, '{}'::jsonb, 'hash-example')`,
          [sourceId, incarnation, randomUUID()]);
        await tx.executeRaw(
          `INSERT INTO shared_skill_heads (source_id, source_incarnation, pack_id, name, revision, metadata, deleted, policy_epoch)
           VALUES ($1, $2::uuid, 'pack-example', 'example-skill', $3::uuid, '{}'::jsonb, false, 'epoch-example')`,
          [sourceId, incarnation, randomUUID()]);
      });
    }

    test('an adopted catalog pack synced 5 days ago is ok, counted as read-only', async () => {
      await adoptPack('shared-skills', await addSource('shared-skills'));
      const result = await checkSyncFreshness(engine);
      expect(result.status).toBe('ok');
      expect(result.details).toMatchObject({ read_only_pack_count: 1, stale_count: 0 });
      expect(result.message).toContain('1 read-only skill-pack source(s): no commits to sync');
    });

    test('a git-backed pack (commit history) still reports staleness', async () => {
      await adoptPack('pack-git', await addSource('pack-git', { lastCommit: 'a'.repeat(40) }));
      const result = await checkSyncFreshness(engine);
      expect(result.status).toBe('fail');
      expect(result.message).toContain("Source 'pack-git' last synced 5d ago");
      expect(result.details?.read_only_pack_count).toBeUndefined();
    });

    test('a pack root that is a Git checkout is judged when doctor may read it (localOnly)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-pack-git-'));
      mkdirSync(join(root, '.git'));
      await adoptPack('pack-root', await addSource('pack-root', { localPath: root }));
      const result = await checkSyncFreshness(engine, { localOnly: true });
      expect(result.status).toBe('fail');
      expect(result.message).toContain("Source 'pack-root' last synced 5d ago");
    });

    test('a source with no pack and no commits is still stale', async () => {
      await adoptPack('shared-skills', await addSource('shared-skills'));
      await addSource('plain');
      const result = await checkSyncFreshness(engine);
      expect(result.status).toBe('fail');
      expect(result.message).toContain("Source 'plain' last synced 5d ago");
      expect(result.details).toMatchObject({ read_only_pack_count: 1, stale_count: 1 });
    });

    test('a failing adopted-pack read exempts nothing and is a note, not a check error', async () => {
      await adoptPack('shared-skills', await addSource('shared-skills'));
      const failing = new Proxy(engine, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes('FROM shared_skill_packs')) throw Object.assign(new Error('permission denied for table shared_skill_packs'), { code: '42501' });
            return (value as BrainEngine['executeRaw']).call(target, sql, params);
          };
        },
      }) as BrainEngine;
      const result = await checkSyncFreshness(failing);
      expect(result.status).toBe('fail');
      expect(result.message).toContain("Source 'shared-skills' last synced 5d ago");
      expect(result.message).toContain('read-only skill-pack exemption unavailable (permission denied for table shared_skill_packs)');
      expect(result.details?.read_only_pack_note).toContain('permission denied');
    });
  });
}
