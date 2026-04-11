import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';


const originalEnv = { ...process.env };
let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

describe('doctor command', () => {
  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('LATEST_VERSION is importable from migrate', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    expect(typeof LATEST_VERSION).toBe('number');
  });


  test('SQLite-configured doctor skips Postgres-only checks', async () => {
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
    expect(output).toContain('pgvector');
    expect(output).toContain('Skipped: pgvector check is Postgres-only for sqlite mode');
    expect(output).toContain('Skipped: RLS check is Postgres-only for sqlite mode');
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
