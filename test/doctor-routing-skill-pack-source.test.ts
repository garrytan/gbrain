/**
 * source_routing_health and the dedicated skills source (#6076).
 *
 * Protects: a non-default source with zero pages that holds an adopted skill
 * pack (a `shared_skill_packs` row for its current incarnation with a live
 * `shared_skill_heads` row) is not reported as a routing collapse, while every
 * other zero-page source still warns: no pack, a pack left by an earlier
 * incarnation, or a pack whose heads are all deleted. A schema without the
 * shared-skills tables keeps the old warning.
 * Fails when: the exemption is dropped (the skills source warns again) or
 * widened (a stale or empty pack hides a real collapse).
 * Seams: none; real PGLite (and Postgres through test/postgres-unit-arms.txt)
 * with the rows written directly (publication triggers suppressed in the
 * fixture transaction), plus a duck-typed engine for the pre-shared-skills
 * schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkSourceRoutingHealth } from '../src/commands/doctor.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

/** The fixture writes with the publication triggers off: real adoption runs through the persistence coordinator, and the check only reads these rows. */
async function withoutTriggers(engine: BrainEngine, run: (tx: BrainEngine) => Promise<void>): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await run(tx);
  });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: checkSourceRoutingHealth and skill-pack sources (#6076)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
    }, 120_000);

    afterAll(async () => {
      await close();
    });

    beforeEach(async () => {
      await withoutTriggers(engine, async (tx) => {
        await tx.executeRaw('DELETE FROM shared_skill_heads');
        await tx.executeRaw('DELETE FROM shared_skill_packs');
        await tx.executeRaw("DELETE FROM pages WHERE source_id <> 'default'");
        await tx.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      });
    });

    async function addSource(id: string): Promise<string> {
      const [row] = await engine.executeRaw<{ incarnation: string }>(
        'INSERT INTO sources (id, name) VALUES ($1, $1) RETURNING incarnation::text AS incarnation', [id]);
      return row!.incarnation;
    }

    async function adoptPack(sourceId: string, incarnation: string, heads: Array<{ name: string; deleted?: boolean }>): Promise<void> {
      await withoutTriggers(engine, async (tx) => {
        await tx.executeRaw(
          `INSERT INTO shared_skill_packs (source_id, source_incarnation, pack_id, revision, manifest, manifest_hash)
           VALUES ($1, $2::uuid, 'pack-example', $3::uuid, '{}'::jsonb, 'hash-example')`,
          [sourceId, incarnation, randomUUID()]);
        for (const head of heads) {
          await tx.executeRaw(
            `INSERT INTO shared_skill_heads (source_id, source_incarnation, pack_id, name, revision, metadata, deleted, policy_epoch)
             VALUES ($1, $2::uuid, 'pack-example', $3, $4::uuid, '{}'::jsonb, $5, 'epoch-example')`,
            [sourceId, incarnation, head.name, randomUUID(), head.deleted === true]);
        }
      });
    }

    test('a zero-page source holding an adopted pack on its current incarnation → ok, named in the message', async () => {
      await adoptPack('skills', await addSource('skills'), [{ name: 'example-skill' }]);
      const r = await checkSourceRoutingHealth(engine);
      expect(r.status).toBe('ok');
      expect(r.message).toBe('Multi-source brain (1 non-default source(s)); all populated (skill-pack sources hold no pages by design: skills)');
    });

    test('a zero-page source with no pack still warns', async () => {
      await adoptPack('skills', await addSource('skills'), [{ name: 'example-skill' }]);
      await addSource('lonely');
      const r = await checkSourceRoutingHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/^1 non-default source\(s\) have zero pages: lonely\./);
    });

    test('a pack left by an earlier incarnation still warns', async () => {
      await addSource('skills');
      await adoptPack('skills', randomUUID(), [{ name: 'example-skill' }]);
      const r = await checkSourceRoutingHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/zero pages: skills\./);
    });

    test('a pack whose heads are all deleted still warns', async () => {
      await adoptPack('skills', await addSource('skills'), [{ name: 'example-skill', deleted: true }]);
      const r = await checkSourceRoutingHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/zero pages: skills\./);
    });
  });
}

describe('checkSourceRoutingHealth on a schema without shared skills', () => {
  test('keeps the zero-page warning', async () => {
    const preSharedSkills = {
      executeRaw: async (sql: string) => {
        if (/shared_skill_packs/.test(sql)) throw Object.assign(new Error('relation "shared_skill_packs" does not exist'), { code: '42P01' });
        if (/FROM pages/.test(sql)) return [{ n: '0' }];
        return [{ id: 'skills' }];
      },
    } as unknown as BrainEngine;
    const r = await checkSourceRoutingHealth(preSharedSkills);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/zero pages: skills\./);
  });
});
