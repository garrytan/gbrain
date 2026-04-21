import { describe, test, expect, mock } from 'bun:test';

mock.module('../src/core/embedding.ts', () => ({
  getEmbeddingProvider: () => 'minimax',
  hasEmbeddingProviderCredentials: () => false,
}));

describe('doctor command', () => {
  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('LATEST_VERSION is importable from migrate', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    expect(typeof LATEST_VERSION).toBe('number');
  });

  test('doctor warns when configured embedding provider has no credentials', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');

    const lines: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;

    console.log = (...args: any[]) => { lines.push(args.join(' ')); };
    (process.exit as any) = ((code?: number) => { throw new Error(`EXIT:${code ?? 0}`); }) as any;

    const engine = {
      getStats: async () => ({ page_count: 1 }),
      getConfig: async () => '1',
      getHealth: async () => ({ embed_coverage: 0, missing_embeddings: 1 }),
    } as any;

    try {
      await runDoctor(engine, []);
    } catch (e: any) {
      expect(String(e.message)).toContain('EXIT:0');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }

    expect(lines.join('\n')).toContain('Embedding provider "minimax" is configured without credentials');
    expect(lines.join('\n')).not.toContain('embed refresh');
  });

  test('CLI registers doctor command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--fast');
  });

  test('Check interface supports issues array', async () => {
    const { Check } = await import('../src/commands/doctor.ts');
    const check: import('../src/commands/doctor.ts').Check = {
      name: 'resolver_health',
      status: 'warn',
      message: '2 issues',
      issues: [{ type: 'unreachable', skill: 'test-skill', action: 'Add trigger row' }],
    };
    expect(check.issues).toHaveLength(1);
    expect(check.issues![0].action).toContain('trigger');
  });

  test('runDoctor accepts null engine for filesystem-only mode', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(runDoctor.length).toBeGreaterThanOrEqual(2);
    expect(runDoctor.length).toBeLessThanOrEqual(3);
  });

  test('getDbUrlSource reflects GBRAIN_DATABASE_URL env var', async () => {
    const { getDbUrlSource } = await import('../src/core/config.ts');
    const orig = process.env.GBRAIN_DATABASE_URL;
    const origAlt = process.env.DATABASE_URL;
    try {
      process.env.GBRAIN_DATABASE_URL = 'postgresql://test@localhost/x';
      expect(getDbUrlSource()).toBe('env:GBRAIN_DATABASE_URL');
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://test@localhost/x';
      expect(getDbUrlSource()).toBe('env:DATABASE_URL');
    } finally {
      if (orig === undefined) delete process.env.GBRAIN_DATABASE_URL;
      else process.env.GBRAIN_DATABASE_URL = orig;
      if (origAlt === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = origAlt;
    }
  });

  test('doctor --fast emits source-specific message when URL present', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('Skipping DB checks (--fast mode, URL present from');
    expect(source).toContain('GBRAIN_DATABASE_URL');
  });

  test('doctor source contains jsonb_integrity and markdown_body_completeness checks', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('jsonb_integrity');
    expect(source).toContain('markdown_body_completeness');
    expect(source).toContain('gbrain repair-jsonb');
  });

  test('jsonb_integrity check covers the four JSONB sites fixed in v0.12.1', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toMatch(/table:\s*'pages'.*col:\s*'frontmatter'/);
    expect(source).toMatch(/table:\s*'raw_data'.*col:\s*'data'/);
    expect(source).toMatch(/table:\s*'ingest_log'.*col:\s*'pages_updated'/);
    expect(source).toMatch(/table:\s*'files'.*col:\s*'metadata'/);
  });
});
