import { describe, expect, test } from 'bun:test';
import { MBrainError } from '../src/core/types.ts';
import type { MBrainConfig } from '../src/core/config.ts';
import {
  assertExplicitRemoteDsn,
  assertPostgresRuntimeFeatureAllowed,
  describeRuntimeDatabaseIdentity,
  resolvePostgresRuntimeProfile,
} from '../src/core/postgres-runtime/connection-profile.ts';
import {
  buildDoctorReport,
} from '../src/core/services/doctor-service.ts';

const postgresConfig = (databaseUrl = 'postgresql://user:secret@localhost:5432/mbrain'): MBrainConfig => ({
  engine: 'postgres',
  database_url: databaseUrl,
  offline: false,
  embedding_provider: 'none',
  query_rewrite_provider: 'none',
});

describe('postgres runtime foundation', () => {
  test('default runtime config selects postgres', () => {
    const profile = resolvePostgresRuntimeProfile(postgresConfig());

    expect(profile.engine).toBe('postgres');
    expect(profile.database.url).toBe('postgresql://user:***@localhost:5432/mbrain');
    expect(profile.database.host).toBe('localhost');
    expect(profile.database.database).toBe('mbrain');
    expect(profile.database.isRemote).toBe(false);
    expect(profile.pool.max).toBeGreaterThanOrEqual(3);
    expect(profile.pool.max).toBeLessThanOrEqual(10);
  });

  test('sqlite and pglite are rejected for postgres runtime features', () => {
    const sqliteConfig: MBrainConfig = {
      engine: 'sqlite',
      database_path: '/tmp/brain.db',
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    };
    const pgliteConfig: MBrainConfig = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    };

    expect(() => assertPostgresRuntimeFeatureAllowed(sqliteConfig, 'source registry')).toThrow(MBrainError);
    expect(() => assertPostgresRuntimeFeatureAllowed(sqliteConfig, 'source registry')).toThrow(
      'source registry requires engine="postgres"',
    );
    expect(() => assertPostgresRuntimeFeatureAllowed(pgliteConfig, 'source registry')).toThrow(MBrainError);
  });

  test('doctor reports active cli mcp and autopilot db identity', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 1,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: postgresConfig('postgresql://runtime:secret@localhost:5432/runtime_brain'),
      profile: null,
      rawPostgresChecksSupported: true,
      pgvector: { status: 'ok', message: 'Extension installed' },
      rls: { status: 'ok', message: 'RLS enabled on all tables' },
      schemaVersion: '4',
      latestVersion: 4,
      health: {
        page_count: 1,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
    });

    const runtimeIdentity = report.checks.find((check) => check.name === 'runtime_db_identity');

    expect(runtimeIdentity?.status).toBe('ok');
    expect(runtimeIdentity?.message).toContain('cli=runtime@localhost:5432/runtime_brain');
    expect(runtimeIdentity?.message).toContain('mcp=runtime@localhost:5432/runtime_brain');
    expect(runtimeIdentity?.message).toContain('autopilot=runtime@localhost:5432/runtime_brain');
    expect(runtimeIdentity?.message).not.toContain('secret');
  });

  test('remote dsn requires explicit user supplied dsn', () => {
    const remote = postgresConfig('postgresql://user:secret@db.example.com:5432/mbrain');

    expect(describeRuntimeDatabaseIdentity(remote)).toMatchObject({
      host: 'db.example.com',
      isRemote: true,
      safeDsn: 'postgresql://user:***@db.example.com:5432/mbrain',
    });
    expect(() => assertExplicitRemoteDsn(remote)).toThrow(MBrainError);
    expect(() => assertExplicitRemoteDsn({ ...remote, database_url_explicit: true })).not.toThrow();
  });

  test('pool size is bounded for cli mcp and daemon usage', () => {
    const profile = resolvePostgresRuntimeProfile(postgresConfig());

    expect(profile.pool.max).toBeGreaterThanOrEqual(3);
    expect(profile.pool.max).toBeLessThanOrEqual(10);
    expect(profile.clients).toEqual({
      cli: 'postgresql://user:***@localhost:5432/mbrain',
      mcp: 'postgresql://user:***@localhost:5432/mbrain',
      autopilot: 'postgresql://user:***@localhost:5432/mbrain',
    });
  });
});
