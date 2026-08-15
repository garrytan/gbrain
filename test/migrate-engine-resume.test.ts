import { describe, expect, test } from 'bun:test';
import {
  manifestMatchesTarget,
  migrationTargetId,
  type MigrateManifest,
} from '../src/commands/migrate-engine.ts';

describe('migrate-engine resume identity', () => {
  test('crash manifest resumes only against the same PGLite target', () => {
    const targetA = migrationTargetId({ engine: 'pglite', database_path: '/tmp/target-a' });
    const targetB = migrationTargetId({ engine: 'pglite', database_path: '/tmp/target-b' });
    const crashed: MigrateManifest = {
      schema_version: 2,
      target_engine: 'pglite',
      target_id: targetA,
      completed_slugs: ['source-a::people/shared'],
      started_at: '2026-07-10T00:00:00.000Z',
    };

    expect(manifestMatchesTarget(crashed, targetA)).toBe(true);
    expect(manifestMatchesTarget(crashed, targetB)).toBe(false);
  });

  test('legacy engine-only manifest cannot skip pages on a second target', () => {
    const legacy: MigrateManifest = {
      target_engine: 'postgres',
      completed_slugs: ['people/shared'],
      started_at: '2026-07-10T00:00:00.000Z',
    };
    const target = migrationTargetId({
      engine: 'postgres',
      database_url: 'postgresql://user:secret@db.example.invalid/brain-b',
    });

    expect(manifestMatchesTarget(legacy, target)).toBe(false);
    expect(target).not.toContain('user');
    expect(target).not.toContain('secret');
    expect(target).not.toContain('db.example.invalid');
  });
});
