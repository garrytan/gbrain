import { expect, test } from 'bun:test';
import { assertSharedSkillRetentionCapacity, sharedSkillRetentionCapacity, sharedSkillRetentionStatus,
  SHARED_SKILL_RETENTION_LIMITS, type SkillRetentionCapacity } from '../src/core/shared-skills/retention.ts';
import { withTransportFixture } from './fixtures/shared-skills-transports.ts';

async function checkCapacity(databaseUrl?: string) {
  await withTransportFixture(async fixture => {
    await fixture.seed();
    await fixture.seed('hidden');
    const capacity = await sharedSkillRetentionCapacity(fixture.engine, 'default', fixture.incarnation);
    const status = await sharedSkillRetentionStatus(fixture.engine, 'default', fixture.incarnation);
    for (const key of Object.keys(capacity) as Array<keyof SkillRetentionCapacity>) expect(capacity[key]).toBe(status[key]);
    expect(capacity.retained_revisions).toBe(1);
    expect(capacity.brain_retained_revisions).toBe(2);
    expect(capacity.retained_bytes).toBeGreaterThan(0);
    expect(capacity.brain_retained_bytes).toBeGreaterThan(capacity.retained_bytes);
    const blocked = { ...capacity, retained_bytes: SHARED_SKILL_RETENTION_LIMITS.sourceBytes };
    expect(() => assertSharedSkillRetentionCapacity(blocked, 1, 1)).toThrow('storage budget');
    try { assertSharedSkillRetentionCapacity(blocked, 1, 1); }
    catch (error) { expect(error).toMatchObject({ code: 'skill_retention_capacity', detail: undefined }); }
    const indexes = await fixture.engine.executeRaw<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='shared_skill_revision_lease_target_idx'");
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('(source_id, source_incarnation, pack_id, name, revision, expires_at)');
  }, databaseUrl);
}

test('lightweight capacity matches exact scoped and global retention accounting on PGLite', () => checkCapacity(), 120_000);
test.skipIf(!process.env.DATABASE_URL)('Postgres capacity and target-lease indexing match full retention accounting',
  () => checkCapacity(process.env.DATABASE_URL), 120_000);
