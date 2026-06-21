import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildDoctorReport,
  collectDoctorInputs,
  doctorExitCode,
  parseEtimeSeconds,
  parseServeProcessTable,
} from '../src/core/services/doctor-service.ts';
import { resolveOfflineProfile } from '../src/core/offline-profile.ts';
import type {
  DoctorRemediationAction,
  DoctorRemediationPlan,
} from '../src/core/services/doctor-remediation-service.ts';
import {
  EMBEDDED_AGENT_RULES_VERSION,
  getAgentRulesCandidatePaths,
  getExpectedAgentRulesVersion,
  getExpectedAgentRulesVersionFromCandidates,
  parseDoctorAgentArgs,
} from '../src/commands/doctor.ts';


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
  test('collectDoctorInputs includes Postgres system-of-record projection health', async () => {
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('pg_extension')) return [{ extname: 'vector' }];
      if (query.includes('pg_tables')) return [];
      if (query.includes('to_regclass')) return [{ table_name: 'canonical_projection_targets' }];
      if (query.includes('FROM canonical_projection_targets')) {
        return [
          { status: 'pending_reconcile', count: 2 },
          { status: 'failed', count: 1 },
          { status: 'conflict', count: 3 },
        ];
      }
      return [];
    };
    const engine = {
      getStats: async () => ({
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      }),
      getConfig: async () => '43',
      getHealth: async () => ({
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      }),
    };

    const inputs = await collectDoctorInputs(engine as any, {
      getConnection: () => sql as any,
      loadConfig: () => ({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      resolveOfflineProfile,
      supportsRawPostgresAccess: () => true,
    });

    expect(inputs.systemOfRecord).toEqual({
      pending_reconcile: 2,
      failed: 1,
      conflict: 3,
    });
    expect(inputs.rls?.message).toBe('RLS enabled on configured core tables');
  });

  test('collectDoctorInputs detects active jobs with expired lock leases as stuck runtime work', async () => {
    const observedQueries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join('');
      observedQueries.push(query.replace(/\s+/g, ' ').trim());
      if (query.includes('pg_extension')) return [{ extname: 'vector' }];
      if (query.includes('pg_tables')) return [];
      if (query.includes('to_regclass')) return [{ table_name: 'memory_jobs' }];
      if (query.includes("status = 'active'") && query.includes('lock_expires_at <= now()')) {
        return [{ count: 2 }];
      }
      return [{ count: 0 }];
    };
    const engine = {
      getStats: async () => ({
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      }),
      getConfig: async () => '44',
      getHealth: async () => ({
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      }),
    };

    const inputs = await collectDoctorInputs(engine as any, {
      getConnection: () => sql as any,
      loadConfig: () => ({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      resolveOfflineProfile,
      supportsRawPostgresAccess: () => true,
    });

    expect(inputs.memoryRuntime?.stuck_locks).toBe(2);
    expect(observedQueries.some((query) => query.includes("status = 'active'") && query.includes('lock_expires_at <= now()'))).toBe(true);
  });

  test('collectDoctorInputs includes autopilot last cycle and stuck job health', async () => {
    const observedQueries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join('');
      observedQueries.push(query.replace(/\s+/g, ' ').trim());
      if (query.includes('pg_extension')) return [{ extname: 'vector' }];
      if (query.includes('pg_tables')) return [];
      if (query.includes('to_regclass')) return [{ table_name: 'memory_jobs' }];
      if (
        query.includes("name IN ('autopilot_cycle', 'autopilot-cycle')")
        && query.includes("status = 'active'")
      ) {
        return [{ count: 1 }];
      }
      if (
        query.includes('FROM memory_jobs')
        && query.includes("status IN ('completed', 'failed', 'dead', 'cancelled')")
      ) {
        return [{
          id: 'job:autopilot-cycle',
          status: 'failed',
          failure_class: 'internal',
          last_error: 'forgetting review failed',
          updated_at: '2026-06-13T00:00:00.000Z',
          finished_at: '2026-06-13T00:01:00.000Z',
        }];
      }
      return [{ count: 0 }];
    };
    const engine = {
      getStats: async () => ({
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      }),
      getConfig: async () => '44',
      getHealth: async () => ({
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      }),
    };

    const inputs = await collectDoctorInputs(engine as any, {
      getConnection: () => sql as any,
      loadConfig: () => ({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: true },
      }) as any,
      resolveOfflineProfile,
      supportsRawPostgresAccess: () => true,
    });

    expect(inputs.memoryRuntime?.autopilot_stuck_jobs).toBe(1);
    expect(inputs.memoryRuntime?.autopilot_last_cycle).toMatchObject({
      id: 'job:autopilot-cycle',
      status: 'failed',
      failure_class: 'internal',
      last_error: 'forgetting review failed',
    });
    expect(observedQueries.some((query) =>
      query.includes("name IN ('autopilot_cycle', 'autopilot-cycle')")
      && query.includes("status = 'active'")
    )).toBe(true);
  });

  test('collectDoctorInputs counts flagged prompt-injection flags in safety health', async () => {
    const observedQueries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join('');
      observedQueries.push(query.replace(/\s+/g, ' ').trim());
      if (query.includes('pg_extension')) return [{ extname: 'vector' }];
      if (query.includes('pg_tables')) return [];
      if (query.includes('to_regclass')) return [{ table_name: 'prompt_injection_flags' }];
      if (query.includes('FROM prompt_injection_flags')) {
        if (query.includes("risk IN ('flagged', 'quarantined')")) return [{ count: 3 }];
        return [{ count: 1 }];
      }
      return [{ count: 0 }];
    };
    const engine = {
      getStats: async () => ({
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      }),
      getConfig: async () => '44',
      getHealth: async () => ({
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      }),
    };

    const inputs = await collectDoctorInputs(engine as any, {
      getConnection: () => sql as any,
      loadConfig: () => ({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      resolveOfflineProfile,
      supportsRawPostgresAccess: () => true,
    });

    expect(inputs.memoryRuntime?.prompt_injection_safety_count).toBe(3);
    expect(observedQueries.some((query) =>
      query.includes('FROM prompt_injection_flags')
      && query.includes("risk IN ('flagged', 'quarantined')")
    )).toBe(true);
  });

  test('buildDoctorReport detects stuck memory runtime locks and failed runtime work', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      },
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      latestVersion: 44,
      schemaVersion: '44',
      health: {
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
      memoryRuntime: {
        queue_depth: 7,
        failed_jobs: 2,
        dead_jobs: 1,
        stuck_locks: 1,
        unavailable_runners: 1,
        unhealthy_connectors: 1,
        credential_warnings: 1,
        prompt_injection_safety_count: 2,
        purge_candidates: 3,
      },
    });

    const check = report.checks.find((candidate) => candidate.name === 'memory_runtime');
    expect(check).toMatchObject({
      status: 'fail',
    });
    expect(check?.message).toContain('7 queued');
    expect(check?.message).toContain('2 failed jobs');
    expect(check?.message).toContain('1 dead job');
    expect(check?.message).toContain('1 stuck lock');
    expect(check?.message).toContain('1 unhealthy connector');
    expect(check?.message).toContain('2 prompt-injection safety flags');
    expect(check?.message).toContain('3 purge candidates');
  });

  test('buildDoctorReport warns when prompt-injection safety flags are present', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      },
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      latestVersion: 44,
      schemaVersion: '44',
      memoryRuntime: {
        queue_depth: 0,
        failed_jobs: 0,
        dead_jobs: 0,
        stuck_locks: 0,
        unavailable_runners: 0,
        unhealthy_connectors: 0,
        credential_warnings: 0,
        prompt_injection_safety_count: 1,
        purge_candidates: 0,
      },
    });

    const check = report.checks.find((candidate) => candidate.name === 'memory_runtime');
    expect(check).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('1 prompt-injection safety flag'),
    });
  });

  test('buildDoctorReport surfaces autopilot cycle health separately from generic runtime counts', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: true },
      } as any,
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      latestVersion: 44,
      schemaVersion: '44',
      health: {
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
      memoryRuntime: {
        queue_depth: 7,
        failed_jobs: 2,
        dead_jobs: 1,
        stuck_locks: 1,
        unavailable_runners: 1,
        unhealthy_connectors: 1,
        credential_warnings: 1,
        prompt_injection_safety_count: 2,
        purge_candidates: 3,
        autopilot_stuck_jobs: 1,
        autopilot_last_cycle: {
          id: 'job:autopilot-cycle',
          status: 'failed',
          failure_class: 'internal',
          last_error: 'forgetting review failed',
          updated_at: '2026-06-13T00:00:00.000Z',
          finished_at: '2026-06-13T00:01:00.000Z',
        },
      },
    });

    const check = report.checks.find((candidate) => candidate.name === 'autopilot');
    expect(check).toMatchObject({
      status: 'fail',
    });
    expect(check?.message).toContain('enabled');
    expect(check?.message).toContain('last cycle failed');
    expect(check?.message).toContain('job:autopilot-cycle');
    expect(check?.message).toContain('1 stuck autopilot job');
    expect(check?.message).toContain('forgetting review failed');
  });

  test('buildDoctorReport classifies autopilot edge states without false positives', () => {
    const memoryRuntime = (overrides: Record<string, unknown> = {}) => ({
      queue_depth: 0,
      failed_jobs: 0,
      dead_jobs: 0,
      stuck_locks: 0,
      unavailable_runners: 0,
      unhealthy_connectors: 0,
      credential_warnings: 0,
      prompt_injection_safety_count: 0,
      purge_candidates: 0,
      ...overrides,
    });
    const reportFor = (input: { enabled: boolean; runtime: Record<string, unknown> }) => buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: input.enabled },
      } as any,
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      latestVersion: 44,
      schemaVersion: '44',
      memoryRuntime: input.runtime as any,
    });
    const checkFor = (input: { enabled: boolean; runtime: Record<string, unknown> }) =>
      reportFor(input).checks.find((candidate) => candidate.name === 'autopilot');
    const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const lastCycle = (status: string, timestamp = recentTimestamp) => ({
      id: `job:autopilot-${status}`,
      status,
      failure_class: status === 'completed' ? null : 'internal',
      last_error: status === 'completed' ? null : `${status} cycle`,
      updated_at: timestamp,
      finished_at: timestamp,
    });

    expect(checkFor({ enabled: false, runtime: memoryRuntime() })).toBeUndefined();
    expect(checkFor({ enabled: true, runtime: memoryRuntime() })).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('last cycle not recorded'),
    });
    expect(checkFor({ enabled: true, runtime: memoryRuntime({ autopilot_last_cycle: lastCycle('completed') }) }))
      .toMatchObject({ status: 'ok' });
    expect(checkFor({ enabled: true, runtime: memoryRuntime({ autopilot_last_cycle: lastCycle('failed') }) }))
      .toMatchObject({ status: 'warn' });
    expect(checkFor({ enabled: true, runtime: memoryRuntime({ autopilot_last_cycle: lastCycle('cancelled') }) }))
      .toMatchObject({ status: 'warn' });
    expect(checkFor({ enabled: true, runtime: memoryRuntime({ autopilot_last_cycle: lastCycle('dead') }) }))
      .toMatchObject({ status: 'fail' });
    expect(checkFor({ enabled: false, runtime: memoryRuntime({ autopilot_stuck_jobs: 1 }) }))
      .toMatchObject({ status: 'fail' });
  });

  test('buildDoctorReport warns when enabled autopilot has only a stale completed cycle', () => {
    const now = '2030-01-03T00:00:00.000Z';
    const staleTimestamp = '2030-01-01T00:00:00.000Z';
    const report = buildDoctorReport({
      connectionOk: true,
      now,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: true },
      } as any,
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      latestVersion: 44,
      schemaVersion: '44',
      memoryRuntime: {
        queue_depth: 0,
        failed_jobs: 0,
        dead_jobs: 0,
        stuck_locks: 0,
        unavailable_runners: 0,
        unhealthy_connectors: 0,
        credential_warnings: 0,
        prompt_injection_safety_count: 0,
        purge_candidates: 0,
        autopilot_last_cycle: {
          id: 'job:autopilot-stale',
          status: 'completed',
          failure_class: null,
          last_error: null,
          updated_at: staleTimestamp,
          finished_at: staleTimestamp,
        },
      },
    });

    const check = report.checks.find((candidate) => candidate.name === 'autopilot');
    const message = String(check?.message ?? '');
    expect(check?.status).toBe('warn');
    expect(message.includes('last successful cycle is stale')).toBe(true);
    expect(message.includes(staleTimestamp)).toBe(true);
    expect(message.includes('2 days')).toBe(true);
  });

  test('buildDoctorReport keeps just-stale autopilot age in hours', () => {
    const now = '2030-01-02T13:00:00.000Z';
    const staleTimestamp = '2030-01-01T00:00:00.000Z';
    const report = buildDoctorReport({
      connectionOk: true,
      now,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: {
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: true },
      } as any,
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://postgres:postgres@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      latestVersion: 44,
      schemaVersion: '44',
      memoryRuntime: {
        queue_depth: 0,
        failed_jobs: 0,
        dead_jobs: 0,
        stuck_locks: 0,
        unavailable_runners: 0,
        unhealthy_connectors: 0,
        credential_warnings: 0,
        prompt_injection_safety_count: 0,
        purge_candidates: 0,
        autopilot_last_cycle: {
          id: 'job:autopilot-37h',
          status: 'completed',
          failure_class: null,
          last_error: null,
          updated_at: staleTimestamp,
          finished_at: staleTimestamp,
        },
      },
    });

    const message = String(report.checks.find((candidate) => candidate.name === 'autopilot')?.message ?? '');
    expect(message).toContain('37 hours ago');
    expect(message).not.toContain('1 day ago');
  });

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
          model: 'qwen3-embedding:0.6b',
          dimensions: 1024,
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

  test('buildDoctorReport includes installed-agent readiness checks when provided', () => {
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
      config: null,
      profile: null,
      rawPostgresChecksSupported: false,
      latestVersion: 4,
      schemaVersion: '4',
      health: {
        page_count: 1,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
      installedAgent: {
        status: 'ok',
        checks: [{
          name: 'mcp_required_tools',
          status: 'ok',
          message: 'Required tools available: retrieve_context, read_context, record_retrieval_trace, route_memory_writeback',
        }],
      },
    });

    const agentCheck = report.checks.find((check) => check.name === 'agent:mcp_required_tools');
    expect(report.status).toBe('healthy');
    expect(agentCheck?.status).toBe('ok');
  });

  test('buildDoctorReport fails when installed-agent readiness has failing checks', () => {
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
      config: null,
      profile: null,
      rawPostgresChecksSupported: false,
      latestVersion: 4,
      schemaVersion: '4',
      health: {
        page_count: 1,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
      installedAgent: {
        status: 'fail',
        checks: [{
          name: 'mcp_required_tools',
          status: 'fail',
          message: 'Missing required MCP tools: read_context',
        }],
      },
    });

    const agentCheck = report.checks.find((check) => check.name === 'agent:mcp_required_tools');
    expect(report.status).toBe('unhealthy');
    expect(agentCheck?.status).toBe('fail');
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
          model: 'qwen3-embedding:0.6b',
          dimensions: 1024,
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

  test('buildDoctorReport emits report-only remediation actions for warnings', () => {
    const report = buildDoctorReport({
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
      schemaVersion: '3',
      latestVersion: 4,
      health: {
        page_count: 3,
        embed_coverage: 0.5,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 3,
      },
      syncRecency: { configured: true, last_run: '2026-05-01T00:00:00.000Z', days_since: 41 },
      syncWatchFailure: {
        stopped_at: '2026-06-11T01:00:00.000Z',
        reason: 'connection refused',
        consecutive_failures: 5,
      },
      memoryInboxBacklog: { staged_for_review: 65, capped: false, threshold: 50 },
    });

    expect(report.status).toBe('healthy');
    const plan = report.remediation_plan as DoctorRemediationPlan;
    expect(plan.schema_version).toBe(1);
    expect(plan.mode).toBe('report_only');
    expect(plan.summary.auto_apply_supported).toBe(false);
    expect(plan.summary.highest_priority).toBe('p1');
    expect(plan.summary.action_count).toBe(plan.actions.length);

    const byCheck = new Map<string, DoctorRemediationAction>(
      plan.actions.map((action) => [action.check_name, action]),
    );
    expect([...byCheck.keys()]).toEqual([
      'schema_version',
      'embeddings',
      'sync_watch',
      'sync_recency',
      'memory_inbox_backlog',
    ]);

    const embeddings = byCheck.get('embeddings')!;
    expect(embeddings.category).toBe('embedding');
    expect(embeddings.check_status).toBe('warn');
    expect(embeddings.commands).toContainEqual(expect.objectContaining({
      kind: 'apply',
      command: 'mbrain embed --stale',
      mutating: true,
      requires_user_confirmation: true,
    }));
    expect(embeddings.safety).toMatchObject({
      auto_apply_allowed: false,
      canonical_write: false,
      external_mutation: false,
      filesystem_write: false,
    });

    expect(byCheck.get('schema_version')!.commands[0]).toMatchObject({
      kind: 'manual',
      mutating: true,
      requires_user_confirmation: true,
    });
    expect(byCheck.get('sync_recency')!.commands[0].command).toBe('mbrain sync');
    expect(byCheck.get('sync_watch')!.commands.map((entry) => entry.command)).toEqual([
      'mbrain sync --watch',
      'mbrain sync --clear-failure',
    ]);
    expect(byCheck.get('sync_recency')!.downstream_of).toBeUndefined();
    expect(byCheck.get('memory_inbox_backlog')!.commands[0].command).toBe('mbrain memory-report');
  });

  test('doctor remediation ranks root causes before downstream symptoms and redacts details', () => {
    const report = buildDoctorReport({
      connectionOk: false,
      connectionError: 'connection refused for postgresql://user:topsecret@localhost/mbrain',
      config: null,
      profile: null,
      rawPostgresChecksSupported: false,
      latestVersion: 4,
      serveProcesses: [
        { pid: 99690, elapsed_seconds: 7 * 86400, command: 'bun src/cli.ts serve' },
      ],
      installedAgent: {
        status: 'fail',
        checks: [{
          name: 'mcp_required_tools',
          status: 'fail',
          message: 'Missing required MCP tools: read_context',
        }],
      },
    });

    expect(report.status).toBe('unhealthy');
    expect(doctorExitCode(report)).toBe(1);
    const plan = report.remediation_plan as DoctorRemediationPlan;
    expect(plan.summary.highest_priority).toBe('p0');
    expect(plan.actions.map((action) => action.check_name)).toEqual([
      'connection',
      'agent:mcp_required_tools',
      'serve_processes',
    ]);
    expect(plan.actions[0]).toMatchObject({
      check_name: 'connection',
      priority: 'p0',
      cause_rank: 10,
    });
    expect(plan.actions[1].cause_rank).toBeLessThan(plan.actions[2].cause_rank);
    expect(JSON.stringify(plan)).not.toContain('topsecret');
    expect(JSON.stringify(plan)).not.toContain('postgresql://user');
  });

  test('doctor remediation known mappings cover every emitted non-ok check', () => {
    const report = buildDoctorReport({
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
      config: {
        engine: 'postgres',
        database_url: 'postgresql://user:topsecret@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: true },
      } as any,
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://user:topsecret@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      pgvector: { status: 'warn', message: 'pgvector is unavailable' },
      rls: { status: 'warn', message: 'RLS is disabled' },
      schemaVersion: '3',
      latestVersion: 4,
      health: {
        page_count: 3,
        embed_coverage: 0.5,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 3,
      },
      syncRecency: { configured: true, last_run: '2026-05-01T00:00:00.000Z', days_since: 41 },
      syncWatchFailure: {
        stopped_at: '2026-06-11T01:00:00.000Z',
        reason: 'connection refused',
        consecutive_failures: 5,
      },
      memoryInboxBacklog: { staged_for_review: 65, capped: false, threshold: 50 },
      systemOfRecord: { pending_reconcile: 2, failed: 1, conflict: 1 },
      memoryRuntime: {
        queue_depth: 4,
        failed_jobs: 1,
        dead_jobs: 1,
        stuck_locks: 1,
        unavailable_runners: 1,
        unhealthy_connectors: 1,
        credential_warnings: 1,
        prompt_injection_safety_count: 1,
        purge_candidates: 1,
        autopilot_stuck_jobs: 1,
        autopilot_last_cycle: {
          id: 'job:autopilot-dead',
          status: 'dead',
          failure_class: 'timeout',
          last_error: 'worker timeout',
          updated_at: '2030-01-01T00:00:00.000Z',
          finished_at: null,
        },
      },
      serveProcesses: [
        { pid: 99690, elapsed_seconds: 7 * 86400, command: 'bun src/cli.ts serve' },
      ],
      installedAgent: {
        status: 'fail',
        checks: [
          { name: 'mcp_required_tools', status: 'fail', message: 'Missing required MCP tools: read_context' },
          { name: 'codex_prompt_rules', status: 'warn', message: 'Codex prompt rules are stale' },
        ],
      },
    });

    const nonOkChecks = report.checks
      .filter((check) => check.status !== 'ok')
      .map((check) => check.name)
      .sort();
    const mappedChecks = (report.remediation_plan as DoctorRemediationPlan).actions
      .map((action) => action.check_name)
      .sort();

    expect(mappedChecks).toEqual(nonOkChecks);
    expect(JSON.stringify(report.remediation_plan)).not.toContain('topsecret');
  });

  test('doctor remediation actions stay report-only and never suggest canonical-write shortcuts', () => {
    const report = buildDoctorReport({
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
      config: {
        engine: 'postgres',
        database_url: 'postgresql://user:topsecret@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
        autopilot: { enabled: true },
      } as any,
      profile: resolveOfflineProfile({
        engine: 'postgres',
        database_url: 'postgresql://user:topsecret@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      }),
      rawPostgresChecksSupported: true,
      pgvector: { status: 'warn', message: 'pgvector is unavailable' },
      rls: { status: 'warn', message: 'RLS is disabled' },
      schemaVersion: '3',
      latestVersion: 4,
      health: {
        page_count: 3,
        embed_coverage: 0.5,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 3,
      },
      syncRecency: { configured: true, last_run: '2026-05-01T00:00:00.000Z', days_since: 41 },
      syncWatchFailure: {
        stopped_at: '2026-06-11T01:00:00.000Z',
        reason: 'connection refused',
        consecutive_failures: 5,
      },
      memoryInboxBacklog: { staged_for_review: 65, capped: false, threshold: 50 },
      systemOfRecord: { pending_reconcile: 2, failed: 1, conflict: 1 },
      memoryRuntime: {
        queue_depth: 4,
        failed_jobs: 1,
        dead_jobs: 1,
        stuck_locks: 1,
        unavailable_runners: 1,
        unhealthy_connectors: 1,
        credential_warnings: 1,
        prompt_injection_safety_count: 1,
        purge_candidates: 1,
        autopilot_stuck_jobs: 1,
        autopilot_last_cycle: {
          id: 'job:autopilot-dead',
          status: 'dead',
          failure_class: 'timeout',
          last_error: 'worker timeout',
          updated_at: '2030-01-01T00:00:00.000Z',
          finished_at: null,
        },
      },
      serveProcesses: [
        { pid: 99690, elapsed_seconds: 7 * 86400, command: 'bun src/cli.ts serve' },
      ],
      installedAgent: {
        status: 'fail',
        checks: [
          { name: 'mcp_required_tools', status: 'fail', message: 'Missing required MCP tools: read_context' },
          { name: 'codex_prompt_rules', status: 'warn', message: 'Codex prompt rules are stale' },
        ],
      },
    });

    const plan = report.remediation_plan as DoctorRemediationPlan;
    expect(plan.mode).toBe('report_only');
    expect(plan.summary.auto_apply_supported).toBe(false);

    const deniedCommandPattern =
      /\b(put_page|route_memory_writeback|auto-promote\s+--apply|dream\b.*--allow-canonical-page-writes)\b/;

    for (const action of plan.actions) {
      expect(action.safety.auto_apply_allowed).toBe(false);
      expect(action.safety.canonical_write).toBe(false);
      for (const entry of action.commands) {
        if (entry.mutating) {
          expect(entry.requires_user_confirmation).toBe(true);
        }
        expect(entry.command).not.toMatch(deniedCommandPattern);
      }
    }
  });

  test('doctor remediation marks target runtime migration as filesystem and external mutation', () => {
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
          model: 'qwen3-embedding:0.6b',
          dimensions: 1024,
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
        page_count: 1,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
    });

    const plan = report.remediation_plan as DoctorRemediationPlan;
    const targetRuntime = plan.actions.find((action) => action.check_name === 'target_runtime');
    const commands = targetRuntime?.commands.map((entry) => entry.command) ?? [];
    expect(commands).toEqual(['mbrain config show', 'mbrain init --profile homebrew-postgres']);
    expect(commands).not.toContain('mbrain config show --json');
    expect(commands).not.toContain('mbrain autopilot status --json');
    expect(targetRuntime?.safety).toMatchObject({
      auto_apply_allowed: false,
      canonical_write: false,
      external_mutation: true,
      filesystem_write: true,
    });
  });

  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('doctor expected agent rules version matches docs marker', async () => {
    const rulesContent = readFileSync(join(import.meta.dir, '..', 'docs', 'MBRAIN_AGENT_RULES.md'), 'utf-8');
    const docsVersion = rulesContent.match(/<!-- mbrain-agent-rules-version: ([\d.]+) -->/)?.[1];

    if (!docsVersion) throw new Error('docs/MBRAIN_AGENT_RULES.md is missing the rules version marker');
    expect(getExpectedAgentRulesVersion()).toBe(docsVersion);
  });

  test('doctor embedded agent rules version matches docs marker', async () => {
    const rulesContent = readFileSync(join(import.meta.dir, '..', 'docs', 'MBRAIN_AGENT_RULES.md'), 'utf-8');
    const docsVersion = rulesContent.match(/<!-- mbrain-agent-rules-version: ([\d.]+) -->/)?.[1];

    if (!docsVersion) throw new Error('docs/MBRAIN_AGENT_RULES.md is missing the rules version marker');
    expect(EMBEDDED_AGENT_RULES_VERSION).toBe(docsVersion);
  });

  test('doctor expected agent rules version falls back to embedded version without candidate files', async () => {
    expect(getExpectedAgentRulesVersionFromCandidates([])).toBe(EMBEDDED_AGENT_RULES_VERSION);
  });

  test('doctor expected agent rules version ignores cwd docs marker', async () => {
    const rulesContent = readFileSync(join(import.meta.dir, '..', 'docs', 'MBRAIN_AGENT_RULES.md'), 'utf-8');
    const docsVersion = rulesContent.match(/<!-- mbrain-agent-rules-version: ([\d.]+) -->/)?.[1];
    if (!docsVersion) throw new Error('docs/MBRAIN_AGENT_RULES.md is missing the rules version marker');

    const originalCwd = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-doctor-cwd-'));
    try {
      mkdirSync(join(tempDir, 'docs'), { recursive: true });
      writeFileSync(join(tempDir, 'docs', 'MBRAIN_AGENT_RULES.md'), '<!-- mbrain-agent-rules-version: 9.9.9 -->\n');

      process.chdir(tempDir);

      expect(getExpectedAgentRulesVersion()).toBe(docsVersion);
      expect(getExpectedAgentRulesVersion()).not.toBe('9.9.9');
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('doctor agent rules candidate paths do not include cwd fallback', async () => {
    const originalCwd = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-doctor-candidates-'));
    try {
      process.chdir(tempDir);

      const candidatePaths = getAgentRulesCandidatePaths();
      expect(candidatePaths.some((candidate: string) => candidate.startsWith(tempDir))).toBe(false);
      expect(candidatePaths).not.toContain(join(tempDir, 'docs', 'MBRAIN_AGENT_RULES.md'));
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('doctor agent args keep default command when agent command value is missing', async () => {
    expect(parseDoctorAgentArgs(['--agent']).agentCommand).toBe('mbrain');
    expect(parseDoctorAgentArgs(['--agent', '--agent-command', 'bun run src/cli.ts']).agentCommand)
      .toBe('bun run src/cli.ts');
    expect(parseDoctorAgentArgs(['--agent', '--agent-command', '--json']).agentCommand).toBe('mbrain');
    expect(parseDoctorAgentArgs(['--agent', '--agent-command=bun run src/cli.ts']).agentCommand)
      .toBe('bun run src/cli.ts');
    expect(parseDoctorAgentArgs(['--agent-command', '--agent'])).toEqual({
      agent: true,
      explain: false,
      agentCommand: 'mbrain',
    });
    expect(parseDoctorAgentArgs(['--agent', '--explain'])).toEqual({
      agent: true,
      explain: true,
      agentCommand: 'mbrain',
    });
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
    expect(output).toContain('[OK] pgvector: Not applicable: pgvector check is managed Postgres-only for sqlite mode');
    expect(output).toContain('[OK] rls: Not applicable: RLS check is managed Postgres-only for sqlite mode');
    expect(output).not.toContain('[WARN] pgvector');
    expect(output).not.toContain('[WARN] rls');
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
    expect(checksByName.pgvector.status).toBe('ok');
    expect(checksByName.pgvector.message).toContain('Not applicable');
    expect(checksByName.rls.status).toBe('ok');
    expect(checksByName.rls.message).toContain('Not applicable');
  });


  test('CLI registers doctor command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('doctor');
  });

  test('doctor help exposes installed-agent readiness flags', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('--agent');
    expect(stdout).toContain('--explain');
    expect(stdout).toContain('requires --agent');
    expect(stdout).toContain('--agent-command');
  });
});

describe('doctor sync and inbox surfacing', () => {
  const minimalInput = {
    connectionOk: true,
    config: null,
    profile: null,
    rawPostgresChecksSupported: false,
    latestVersion: 4,
    schemaVersion: '4',
  };

  test('reports ok when the last successful sync is recent', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      syncRecency: { configured: true, last_run: new Date().toISOString(), days_since: 0 },
    });
    const check = report.checks.find((entry) => entry.name === 'sync_recency');
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('today');
  });

  test('warns when the last successful sync is older than the recency window', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      syncRecency: { configured: true, last_run: '2026-05-01T00:00:00.000Z', days_since: 41 },
    });
    const check = report.checks.find((entry) => entry.name === 'sync_recency');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('41 days ago');
    expect(check?.message).toContain('mbrain sync');
  });

  test('warns when sync is configured but never succeeded', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      syncRecency: { configured: true, last_run: null, days_since: null },
    });
    const check = report.checks.find((entry) => entry.name === 'sync_recency');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('no successful run');
  });

  test('emits no sync_recency check when sync is not configured', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      syncRecency: { configured: false, last_run: null, days_since: null },
    });
    expect(report.checks.find((entry) => entry.name === 'sync_recency')).toBeUndefined();
  });

  test('surfaces a dead live-sync watcher', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      syncWatchFailure: {
        stopped_at: '2026-06-11T01:00:00.000Z',
        reason: 'connection refused',
        consecutive_failures: 5,
      },
    });
    const check = report.checks.find((entry) => entry.name === 'sync_watch');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('connection refused');
    expect(check?.message).toContain('mbrain sync --watch');
    expect(check?.message).toContain('mbrain sync --clear-failure');
  });

  test('keeps the inbox backlog check ok below the threshold', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      memoryInboxBacklog: { staged_for_review: 3, capped: false, threshold: 50 },
    });
    const check = report.checks.find((entry) => entry.name === 'memory_inbox_backlog');
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('3 candidates staged');
  });

  test('warns when the staged-for-review backlog exceeds the threshold', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      memoryInboxBacklog: { staged_for_review: 65, capped: false, threshold: 50 },
    });
    const check = report.checks.find((entry) => entry.name === 'memory_inbox_backlog');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('65 candidates staged for review');
    expect(check?.message).toContain('mbrain memory-report');
    expect(report.status).toBe('healthy');
  });

  test('labels a capped backlog count as a lower bound', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      memoryInboxBacklog: { staged_for_review: 200, capped: true, threshold: 50 },
    });
    const check = report.checks.find((entry) => entry.name === 'memory_inbox_backlog');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('200+');
  });
});

describe('doctor stale serve process surfacing', () => {
  const minimalInput = {
    connectionOk: true,
    config: null,
    profile: null,
    rawPostgresChecksSupported: false,
    latestVersion: 4,
    schemaVersion: '4',
  };

  test('parseEtimeSeconds handles mm:ss, hh:mm:ss, and dd-hh:mm:ss', () => {
    expect(parseEtimeSeconds('05:33')).toBe(333);
    expect(parseEtimeSeconds('1:02:03')).toBe(3723);
    expect(parseEtimeSeconds('6-01:00:00')).toBe(6 * 86400 + 3600);
    expect(parseEtimeSeconds('garbage')).toBeNull();
  });

  test('parseServeProcessTable extracts mbrain serve rows and skips unrelated commands', () => {
    const psOutput = [
      '  123 05:33 /Users/x/.bun/bin/bun /Users/x/Work/mbrain/src/cli.ts serve',
      '  456 6-01:00:00 /usr/local/bin/mbrain serve',
      '  789 00:10 vim notes.md',
      '  321 00:05 grep cli.ts serve',
    ].join('\n');
    const rows = parseServeProcessTable(psOutput);
    expect(rows.map((r) => r.pid)).toEqual([123, 456]);
    expect(rows[0]!.elapsed_seconds).toBe(333);
    expect(rows[1]!.elapsed_seconds).toBe(6 * 86400 + 3600);
  });

  test('parseServeProcessTable ignores unrelated dev servers launched from a directory named mbrain', () => {
    const psOutput = [
      // "serve" + the word mbrain in a path component must not count as an MCP server.
      '  111 10:00 node /Users/x/Work/mbrain/node_modules/.bin/webpack serve',
      '  222 10:00 node /Users/x/Work/mbrain/node_modules/.bin/vite serve --port 3000',
      '  333 10:00 /usr/local/bin/mbrain serve --http',
      '  444 10:00 bun /Users/x/Work/mbrain/src/cli.ts serve',
    ].join('\n');
    const rows = parseServeProcessTable(psOutput);
    expect(rows.map((r) => r.pid)).toEqual([333, 444]);
  });

  test('emits no serve_processes check when process inspection is unavailable', () => {
    const report = buildDoctorReport({ ...minimalInput });
    expect(report.checks.find((entry) => entry.name === 'serve_processes')).toBeUndefined();
  });

  test('reports ok for a small set of young serve processes', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      serveProcesses: [
        { pid: 123, elapsed_seconds: 3600, command: 'bun src/cli.ts serve' },
      ],
    });
    const check = report.checks.find((entry) => entry.name === 'serve_processes');
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('1');
  });

  test('warns when a serve process has outlived the stale threshold', () => {
    const report = buildDoctorReport({
      ...minimalInput,
      serveProcesses: [
        { pid: 99690, elapsed_seconds: 7 * 86400, command: 'bun src/cli.ts serve' },
      ],
    });
    const check = report.checks.find((entry) => entry.name === 'serve_processes');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('99690');
    expect(check?.message).toContain('stale');
    expect(check?.message.toLowerCase()).toContain('restart');
  });

  test('warns when too many serve processes are running', () => {
    const procs = [11, 12, 13, 14, 15].map((pid) => ({
      pid,
      elapsed_seconds: 60,
      command: 'bun src/cli.ts serve',
    }));
    const report = buildDoctorReport({ ...minimalInput, serveProcesses: procs });
    const check = report.checks.find((entry) => entry.name === 'serve_processes');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('5');
  });
});
