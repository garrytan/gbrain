import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildDoctorReport } from '../src/core/services/doctor-service.ts';
import { resolveOfflineProfile } from '../src/core/offline-profile.ts';


const originalEnv = { ...process.env };
let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-doctor-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.mbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

describe('doctor command', () => {
  test('buildDoctorReport marks sqlite local profile honestly', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 10,
        chunk_count: 20,
        embedded_count: 5,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'sqlite',
        database_path: '/tmp/brain.db',
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      },
      profile: {
        status: 'local_offline',
        offline: true,
        engine: { type: 'sqlite' },
        embedding: {
          mode: 'local',
          available: true,
          implementation: 'local-http',
          model: 'nomic-embed-text',
          dimensions: 768,
        },
        rewrite: {
          mode: 'heuristic',
          available: true,
          implementation: 'heuristic',
          model: null,
        },
        capabilities: {
          check_update: { supported: false, reason: 'disabled locally' },
          files: { supported: false, reason: 'no raw postgres access' },
        },
      },
      rawPostgresChecksSupported: false,
      schemaVersion: '4',
      latestVersion: 4,
      health: {
        page_count: 10,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
    });

    expect(report.status).toBe('healthy');
    expect(report.checks.some((check) => check.name === 'offline_profile')).toBe(true);
  });

  test('buildDoctorReport surfaces the execution envelope and contract surface', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 12,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'sqlite',
        database_path: '/tmp/brain.db',
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      },
      profile: {
        status: 'local_offline',
        offline: true,
        engine: { type: 'sqlite' },
        embedding: {
          mode: 'local',
          available: true,
          implementation: 'local-http',
          model: 'nomic-embed-text',
          dimensions: 768,
        },
        rewrite: {
          mode: 'heuristic',
          available: true,
          implementation: 'heuristic',
          model: null,
        },
        capabilities: {
          check_update: { supported: false, reason: 'disabled offline' },
          files: { supported: false, reason: 'unsupported in sqlite mode' },
        },
      },
      rawPostgresChecksSupported: false,
      latestVersion: 7,
      schemaVersion: '7',
      health: {
        page_count: 12,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
    });

    expect(report.checks.some((check) => check.name === 'execution_envelope')).toBe(true);
    expect(report.checks.some((check) => check.name === 'contract_surface')).toBe(true);
  });

  test('buildDoctorReport keeps pglite doctor output aligned with the execution envelope', () => {
    const config = {
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    } as const;

    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 4,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config,
      profile: resolveOfflineProfile(config),
      rawPostgresChecksSupported: false,
      latestVersion: 7,
      schemaVersion: '7',
      health: {
        page_count: 4,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
    });

    const offlineProfile = report.checks.find((check) => check.name === 'offline_profile');
    const unsupportedCapabilities = report.checks.find((check) => check.name === 'unsupported_capabilities');

    expect(offlineProfile?.message).toContain('local/offline');
    expect(unsupportedCapabilities?.message).toContain('file/storage');
    expect(unsupportedCapabilities?.message).toContain('check-update');
  });

  test('buildDoctorReport points embedding remediation to mbrain embed --stale', () => {
    const partial = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 3,
        chunk_count: 6,
        embedded_count: 2,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: null,
      profile: null,
      rawPostgresChecksSupported: false,
      schemaVersion: '4',
      latestVersion: 4,
      health: {
        page_count: 3,
        embed_coverage: 0.5,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 3,
      },
    });
    const none = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 3,
        chunk_count: 6,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: null,
      profile: null,
      rawPostgresChecksSupported: false,
      schemaVersion: '4',
      latestVersion: 4,
      health: {
        page_count: 3,
        embed_coverage: 0,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 3,
      },
    });

    const partialEmbeddings = partial.checks.find((check) => check.name === 'embeddings');
    const noEmbeddings = none.checks.find((check) => check.name === 'embeddings');

    expect(partialEmbeddings?.message).toContain('mbrain embed --stale');
    expect(partialEmbeddings?.message).not.toContain('embed refresh');
    expect(noEmbeddings?.message).toContain('mbrain embed --stale');
    expect(noEmbeddings?.message).not.toContain('embed refresh');
  });

  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('LATEST_VERSION is importable from migrate', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    expect(typeof LATEST_VERSION).toBe('number');
  });


  test('SQLite-configured doctor reports local providers and skips Postgres-only checks', async () => {
    writeConfig({
      engine: 'sqlite',
      database_path: join(tempHome, 'brain.db'),
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const logs: string[] = [];
    const logSpy = mock((msg: string) => { logs.push(msg); });
    const exitSpy = mock((_code?: number) => undefined as never);
    const consoleLog = console.log;
    const processExit = process.exit;
    console.log = logSpy as typeof console.log;
    process.exit = exitSpy as typeof process.exit;

    try {
      const { runDoctor } = await import('../src/commands/doctor.ts');
      await runDoctor({
        getStats: async () => ({
          page_count: 0,
          chunk_count: 0,
          embedded_count: 0,
          link_count: 0,
          tag_count: 0,
          timeline_entry_count: 0,
          pages_by_type: {},
        }),
        getHealth: async () => ({
          page_count: 0,
          embed_coverage: 0,
          stale_pages: 0,
          orphan_pages: 0,
          dead_links: 0,
          missing_embeddings: 0,
        }),
        getConfig: async (key: string) => key === 'version' ? '4' : null,
      } as any, []);
    } finally {
      console.log = consoleLog;
      process.exit = processExit;
    }

    const output = logs.join('\n');
    expect(output).toContain('engine: sqlite');
    expect(output).toContain('embedding_provider: local');
    expect(output).toContain('query_rewrite_provider: heuristic');
    expect(output).toContain('offline_profile');
    expect(output).toContain('local/offline profile active');
    expect(output).toContain('unsupported_capabilities');
    expect(output).toContain('files/storage commands require Postgres raw database access');
    expect(output).toContain('pgvector');
    expect(output).toContain('Skipped: pgvector check is Postgres-only for sqlite mode');
    expect(output).toContain('Skipped: RLS check is Postgres-only for sqlite mode');
  });

  test('doctor reports offline profile provider details for local sqlite mode', async () => {
    writeConfig({
      engine: 'sqlite',
      database_path: join(tempHome, 'brain.db'),
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const logs: string[] = [];
    const logSpy = mock((msg: string) => { logs.push(msg); });
    const exitSpy = mock((_code?: number) => undefined as never);
    const consoleLog = console.log;
    const processExit = process.exit;
    console.log = logSpy as typeof console.log;
    process.exit = exitSpy as typeof process.exit;

    try {
      const { runDoctor } = await import('../src/commands/doctor.ts');
      await runDoctor({
        getStats: async () => ({
          page_count: 3,
          chunk_count: 6,
          embedded_count: 2,
          link_count: 0,
          tag_count: 0,
          timeline_entry_count: 0,
          pages_by_type: {},
        }),
        getHealth: async () => ({
          page_count: 3,
          embed_coverage: 0.5,
          stale_pages: 0,
          orphan_pages: 0,
          dead_links: 0,
          missing_embeddings: 3,
        }),
        getConfig: async (key: string) => key === 'version' ? '4' : null,
      } as any, ['--json']);
    } finally {
      console.log = consoleLog;
      process.exit = processExit;
    }

    const payload = JSON.parse(logs[0] || '{}');
    const checksByName = Object.fromEntries(payload.checks.map((check: any) => [check.name, check]));

    expect(checksByName.engine.message).toContain('sqlite');
    expect(checksByName.embedding_provider.message).toContain('local');
    expect(checksByName.query_rewrite_provider.message).toContain('heuristic');
    expect(checksByName.offline_profile.message).toContain('enabled');
    expect(checksByName.unsupported_capabilities.message).toContain('file/storage');
    expect(checksByName.unsupported_capabilities.message).toContain('check-update');
  });


  test('CLI registers doctor command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('doctor');
  });
});
