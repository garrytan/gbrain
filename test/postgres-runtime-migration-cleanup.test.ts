import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const readRepoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8');
const repoRootUrl = new URL('../', import.meta.url).href;
const repoRootPath = new URL('../', import.meta.url).pathname;

async function runCliInTempHome(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  home: string;
}> {
  const home = mkdtempSync(join(tmpdir(), 'mbrain-phase14-cli-'));
  const env = {
    ...process.env,
    HOME: home,
    MBRAIN_CONFIG_DIR: join(home, '.mbrain'),
    MBRAIN_DATABASE_URL: '',
    DATABASE_URL: '',
  };
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: repoRootPath,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, home };
}

describe('postgres runtime migration cleanup', () => {
  test('target runtime capabilities are postgres-only while legacy local engines stay quarantined', async () => {
    const { getEngineCapabilities } = await import('../src/core/engine-capabilities.ts');

    expect(getEngineCapabilities({ engine: 'postgres' } as any)).toMatchObject({
      targetRuntime: true,
      rawPostgresAccess: true,
      parallelWorkers: true,
    });
    expect(getEngineCapabilities({ engine: 'sqlite' } as any)).toMatchObject({
      targetRuntime: false,
      legacyLocalRuntime: true,
      rawPostgresAccess: false,
    });
    expect(getEngineCapabilities({ engine: 'pglite' } as any)).toMatchObject({
      targetRuntime: false,
      legacyLocalRuntime: true,
      rawPostgresAccess: false,
    });
  });

  test('global CLI help presents Postgres as the target and keeps SQLite/PGLite as legacy local paths', () => {
    const cliSource = readRepoFile('src/cli.ts');

    expect(cliSource).toContain('Create target Postgres brain');
    expect(cliSource).toContain('legacy SQLite/PGLite only by explicit flag');
    expect(cliSource).toContain('migrate --to <postgres|supabase|sqlite>');
    expect(cliSource).toContain('Prepare Markdown-first migration into Postgres or SQLite');
    expect(cliSource).not.toContain('Create brain (SQLite local, PGLite, or managed Postgres)');
    expect(cliSource).not.toContain('migrate --to <supabase|pglite>');
    expect(cliSource).not.toContain('Move legacy data into the Postgres target runtime');
  });

  test('migrate command exposes Postgres cleanup guidance and legacy DB-only review', async () => {
    const migrate = await import('../src/commands/migrate-engine.ts');

    expect(typeof migrate.formatPostgresRuntimeMigrationGuide).toBe('function');
    const guideOnly = migrate.formatPostgresRuntimeMigrationGuide({
      target: 'postgres',
      source: 'sqlite',
      sourcePageCount: 12,
      migratedPageCount: 0,
      contentHashMismatches: 0,
      legacyDbOnlyRecords: 3,
    });

    expect(guideOnly).toContain('Counts pending: 0/12 pages');
    expect(guideOnly).toContain('Content hash verification pending until Markdown import and projection reconciliation run');
    expect(guideOnly).not.toContain('Counts verified: 0/12 pages');
    expect(guideOnly).not.toContain('Content hashes verified');

    const verifiedGuide = migrate.formatPostgresRuntimeMigrationGuide({
      target: 'postgres',
      source: 'sqlite',
      sourcePageCount: 12,
      migratedPageCount: 12,
      contentHashMismatches: 0,
      legacyDbOnlyRecords: 3,
    });

    expect(verifiedGuide).toContain('Back up the current brain repo and source database');
    expect(verifiedGuide).toContain('mbrain export --dir <backup/markdown-export>');
    expect(verifiedGuide).toContain('mbrain init --profile homebrew-postgres --non-interactive');
    expect(verifiedGuide).toContain('mbrain import <backup/markdown-export> --no-embed');
    expect(verifiedGuide).toContain('Manually review legacy DB-only candidates, profile memory, tasks, sessions, and mutation records');
    expect(verifiedGuide).toContain('No one-shot assertion rebuild command exists yet');
    expect(verifiedGuide).toContain('mbrain call get_page');
    expect(verifiedGuide).toContain('DATABASE_URL=<connection_string> bun run smoke:postgres-runtime');
    expect(verifiedGuide).toContain('bun run test:phase13');
    expect(verifiedGuide).toContain('mbrain doctor --json');
    expect(verifiedGuide).toContain('legacy DB-only records require manual review: 3');
    expect(verifiedGuide).toContain('Counts verified: 12/12 pages');
    expect(verifiedGuide).toContain('Content hashes verified');
    expect(verifiedGuide).toContain('Direct legacy DB page copy is not a Postgres activation path');
    expect(verifiedGuide).not.toContain('Run extraction/assertion rebuild for migrated sources.');
    expect(verifiedGuide).not.toContain('Run projection reconciler.');
    expect(verifiedGuide).not.toContain('Run eval/replay smoke.');

    const migrateSource = readRepoFile('src/commands/migrate-engine.ts');
    expect(migrateSource).not.toContain('Target is Supabase but no connection string provided');
    expect(migrateSource).toContain('Postgres target migration is Markdown-first and reconciler-gated');
  });

  test('migrate --to sqlite emits a two-machine Markdown re-import runbook', async () => {
    const migrate = await import('../src/commands/migrate-engine.ts');

    const guide = migrate.formatPostgresRuntimeMigrationGuide({
      target: 'sqlite',
      source: 'postgres',
      sourcePageCount: 8,
      migratedPageCount: 0,
      contentHashMismatches: 0,
      legacyDbOnlyRecords: 2,
    });

    expect(guide).toContain('SQLite Re-import Migration Runbook');
    expect(guide).toContain('Target engine: sqlite');
    expect(guide).toContain('mbrain sync --ff-only');
    expect(guide).toContain('mbrain init --local --non-interactive');
    expect(guide).toContain('mbrain import <git-shared-brain>');
    expect(guide).toContain('content-hash guards');
    expect(guide).toContain('Do not DB-copy Postgres runtime rows into SQLite');
  });

  test('Phase 14 exposes a no-provider-key real Postgres confidence smoke', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    const smoke = readRepoFile('scripts/smoke-test-postgres-runtime.ts');

    expect(pkg.scripts['smoke:postgres-runtime']).toBe('bun run scripts/smoke-test-postgres-runtime.ts');
    expect(smoke).toContain('mbrain init');
    expect(smoke).toContain("runMbrain(['init', '--url', databaseUrl, '--non-interactive', '--json'])");
    expect(smoke).toContain("runMbrain(['import', markdownDir, '--no-embed', '--workers', '1', '--fresh', '--json'])");
    expect(smoke).toContain("runMbrain(['call', 'get_page', JSON.stringify({ slug, content_char_limit: 80 })])");
    expect(smoke).toContain('function runDeterministicPhase13()');
    expect(smoke).toContain("runCommand(['bun', 'run', 'test:phase13'], 'bun run test:phase13', {");
    expect(smoke).toContain("MBRAIN_CONFIG_DIR: ''");
    expect(smoke).toContain("MBRAIN_CONFIG_PATH: ''");
    expect(smoke).toContain("MBRAIN_DATABASE_URL: ''");
    expect(smoke).toContain("DATABASE_URL: ''");
    expect(smoke).toContain("runMbrain(['doctor', '--json'])");
    expect(smoke).toContain("OPENAI_API_KEY: ''");
    expect(smoke).toContain("ANTHROPIC_API_KEY: ''");
    expect(smoke).toContain('MBRAIN_POSTGRES_RUNTIME_SMOKE_ALLOW_NONEMPTY');
    expect(smoke).toContain('MBRAIN_CONFIG_PATH: \'\',');
  });

  test('migrate setup-agent and doctor help are side-effect-free target-runtime help surfaces', async () => {
    const migrate = await runCliInTempHome(['migrate', '--help']);
    try {
      expect(migrate.exitCode).toBe(0);
      expect(migrate.stderr).toBe('');
      expect(migrate.stdout).toContain('Usage: mbrain migrate');
      expect(migrate.stdout).toContain('Markdown-first migration into Postgres or SQLite');
      expect(migrate.stdout).toContain('postgres|supabase|sqlite');
      expect(migrate.stdout).toContain('--to');
      expect(migrate.stdout).toContain('--url');
      expect(migrate.stdout).toContain('--path');
      expect(migrate.stdout).toContain('--force');
      expect(migrate.stdout).not.toContain('No brain configured');
      expect(existsSync(join(migrate.home, '.mbrain', 'config.json'))).toBe(false);
    } finally {
      rmSync(migrate.home, { recursive: true, force: true });
    }

    const setupAgent = await runCliInTempHome(['setup-agent', '--help']);
    try {
      expect(setupAgent.exitCode).toBe(0);
      expect(setupAgent.stderr).toBe('');
      expect(setupAgent.stdout).toContain('Usage: mbrain setup-agent');
      expect(setupAgent.stdout).toContain('managed Postgres target runtime');
      expect(setupAgent.stdout).toContain('--print');
      expect(setupAgent.stdout).toContain('--skip-mcp');
      expect(setupAgent.stdout).toContain('--uninstall');
      expect(setupAgent.stdout).not.toContain('No AI clients detected');
      expect(existsSync(join(setupAgent.home, '.mbrain', 'config.json'))).toBe(false);
    } finally {
      rmSync(setupAgent.home, { recursive: true, force: true });
    }

    const doctor = await runCliInTempHome(['doctor', '--help']);
    try {
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stderr).toBe('');
      expect(doctor.stdout).toContain('target Postgres runtime');
      expect(doctor.stdout).toContain('legacy local profile');
      expect(doctor.stdout).toContain('--explain');
      expect(doctor.stdout).not.toContain('No brain configured');
      expect(existsSync(join(doctor.home, '.mbrain', 'config.json'))).toBe(false);
    } finally {
      rmSync(doctor.home, { recursive: true, force: true });
    }
  });

  test('postgres target migration refuses legacy DB page copy before mutating target or config', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-postgres-refuse-db-copy-'));
    const scriptPath = join(tempDir, 'postgres-refuse-db-copy.ts');
    writeFileSync(scriptPath, `
      import { existsSync } from 'fs';
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;

      let createEngineCalls = 0;
      let saveConfigCalls = 0;
      let putPageCalls = 0;

      const emptyDbOnlyLists = {
        getIngestLog: async () => [],
        listTaskThreads: async () => [],
        listProfileMemoryEntries: async () => [],
        listPersonalEpisodeEntries: async () => [],
        listMemoryCandidateEntries: async () => [],
        listMemoryMutationEvents: async () => [],
        listMemoryRealms: async () => [],
        listMemorySessions: async () => [],
        listMemoryRedactionPlans: async () => [],
      };

      const targetEngine = {
        ...emptyDbOnlyLists,
        connect: async () => undefined,
        initSchema: async () => undefined,
        disconnect: async () => undefined,
        getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [],
        putPage: async () => { putPageCalls += 1; return { id: 1, slug: 'concepts/a', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() }; },
        updatePageEmbedding: async () => undefined,
        upsertChunks: async () => undefined,
        addTag: async () => undefined,
        addTimelineEntry: async () => undefined,
        putRawData: async () => undefined,
        addLink: async () => undefined,
        setConfig: async () => undefined,
      };

      const sourceEngine = {
        ...emptyDbOnlyLists,
        getStats: async () => ({ page_count: 1, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [{ id: 1, slug: 'concepts/a', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() }],
        getPageEmbeddings: async () => [],
        getChunksWithEmbeddings: async () => [],
        getTags: async () => [],
        getTimeline: async () => [],
        getRawData: async () => [],
        getVersions: async () => [],
        getLinks: async () => [],
        getConfig: async () => null,
      };

      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => { saveConfigCalls += 1; },
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => {
          createEngineCalls += 1;
          return targetEngine;
        },
      }));

      const originalExit = process.exit;
      process.exit = ((code?: number) => { throw new Error('EXIT:' + String(code)); }) as typeof process.exit;
      let rejected = false;
      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?postgres-refuse-db-copy=' + Date.now(), repoRootUrl).href);
        try {
          await runMigrateEngine(sourceEngine as any, ['--to', 'postgres', '--url', 'postgresql://user:pass@localhost:5432/mbrain']);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'EXIT:1') throw error;
          rejected = true;
        }
      } finally {
        process.exit = originalExit;
      }

      if (!rejected) throw new Error('postgres migration did not reject legacy DB page copy');
      if (createEngineCalls !== 0) throw new Error('target engine was created before Markdown/reconciler migration was selected');
      if (putPageCalls !== 0) throw new Error('copied legacy DB pages into Postgres target');
      if (saveConfigCalls !== 0) throw new Error('saveConfig was called for rejected Postgres migration');
      if (existsSync(join(manifestDir, 'migrate-manifest.json'))) throw new Error('manifest was created for rejected Postgres migration');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('did not reject');
      expect(`${stdout}\n${stderr}`).not.toContain('target engine was created');
      expect(`${stdout}\n${stderr}`).not.toContain('copied legacy DB pages');
      expect(`${stdout}\n${stderr}`).not.toContain('saveConfig was called');
      expect(`${stdout}\n${stderr}`).not.toContain('manifest was created');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('postgres migration guide does not require a target URL before refusing DB copy', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-postgres-guide-no-url-'));
    const scriptPath = join(tempDir, 'postgres-guide-no-url.ts');
    writeFileSync(scriptPath, `
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;
      const logs: string[] = [];
      const errors: string[] = [];

      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };

      let createEngineCalls = 0;
      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => undefined,
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => {
          createEngineCalls += 1;
          throw new Error('target engine should not be created');
        },
      }));

      const originalExit = process.exit;
      process.exit = ((code?: number) => { throw new Error('EXIT:' + String(code)); }) as typeof process.exit;
      let rejected = false;
      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?postgres-guide-no-url=' + Date.now(), repoRootUrl).href);
        try {
          await runMigrateEngine({} as any, ['--to', 'postgres']);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'EXIT:1') throw error;
          rejected = true;
        }
      } finally {
        process.exit = originalExit;
        console.log = originalLog;
        console.error = originalError;
      }

      const combined = logs.concat(errors).join('\\n');
      if (!rejected) throw new Error('postgres migration without URL did not reject DB copy');
      if (!combined.includes('Preflight safety checklist')) throw new Error('preflight guide was not printed before URL validation');
      if (!combined.includes('Markdown-first')) throw new Error('Markdown-first guard was not printed');
      if (!combined.includes('mbrain call get_page')) throw new Error('migration checklist was not printed before refusal');
      if (!combined.includes('bun run test:phase13')) throw new Error('eval/replay gate was not printed before refusal');
      if (!combined.includes('mbrain doctor --json')) throw new Error('doctor gate was not printed before refusal');
      if (combined.includes('no connection string provided')) throw new Error('URL validation ran before DB-copy refusal');
      if (createEngineCalls !== 0) throw new Error('target engine was created for guide-only refusal');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('did not reject');
      expect(`${stdout}\n${stderr}`).not.toContain('preflight guide was not printed');
      expect(`${stdout}\n${stderr}`).not.toContain('migration checklist was not printed');
      expect(`${stdout}\n${stderr}`).not.toContain('eval/replay gate was not printed');
      expect(`${stdout}\n${stderr}`).not.toContain('doctor gate was not printed');
      expect(`${stdout}\n${stderr}`).not.toContain('URL validation ran before DB-copy refusal');
      expect(`${stdout}\n${stderr}`).not.toContain('target engine was created');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('force migration emits backup preflight before target wipe', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-force-preflight-'));
    const scriptPath = join(tempDir, 'force-preflight.ts');
    writeFileSync(scriptPath, `
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;

      const events: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        events.push(args.map(String).join(' '));
      };

      const emptyDbOnlyLists = {
        getIngestLog: async () => [],
        listTaskThreads: async () => [],
        listProfileMemoryEntries: async () => [],
        listPersonalEpisodeEntries: async () => [],
        listMemoryCandidateEntries: async () => [],
        listMemoryMutationEvents: async () => [],
        listMemoryRealms: async () => [],
        listMemorySessions: async () => [],
        listMemoryRedactionPlans: async () => [],
      };

      const targetPages = new Map([
        ['concepts/old', { id: 1, slug: 'concepts/old', type: 'concept', title: 'Old', compiled_truth: 'Old', timeline: '', frontmatter: {}, content_hash: 'old-hash', created_at: new Date(), updated_at: new Date() }],
      ]);
      const targetEngine = {
        ...emptyDbOnlyLists,
        connect: async () => undefined,
        initSchema: async () => undefined,
        disconnect: async () => undefined,
        getStats: async () => ({ page_count: targetPages.size, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [...targetPages.values()],
        deletePage: async (slug: string) => {
          events.push('TARGET_WIPE:' + slug);
          targetPages.delete(slug);
        },
        putPage: async (slug: string, page: any) => {
          targetPages.set(slug, { id: targetPages.size + 1, slug, ...page, created_at: new Date(), updated_at: new Date() });
        },
        updatePageEmbedding: async () => undefined,
        upsertChunks: async () => undefined,
        addTag: async () => undefined,
        addTimelineEntry: async () => undefined,
        putRawData: async () => undefined,
        addLink: async () => undefined,
        setConfig: async () => undefined,
      };

      const sourceEngine = {
        ...emptyDbOnlyLists,
        getStats: async () => ({ page_count: 1, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [{ id: 2, slug: 'concepts/new', type: 'concept', title: 'New', compiled_truth: 'New', timeline: '', frontmatter: {}, content_hash: 'new-hash', created_at: new Date(), updated_at: new Date() }],
        getPageEmbeddings: async () => [],
        getChunksWithEmbeddings: async () => [],
        getTags: async () => [],
        getTimeline: async () => [],
        getRawData: async () => [],
        getVersions: async () => [],
        getLinks: async () => [],
        getConfig: async () => null,
      };

      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => undefined,
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => targetEngine,
      }));

      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?force-preflight=' + Date.now(), repoRootUrl).href);
        await runMigrateEngine(sourceEngine as any, ['--to', 'pglite', '--path', '/target.pglite', '--force']);
      } finally {
        console.log = originalLog;
      }

      const preflightIndex = events.findIndex((event) => event.includes('Preflight safety checklist'));
      const wipeIndex = events.findIndex((event) => event.startsWith('TARGET_WIPE:'));
      if (preflightIndex === -1) throw new Error('preflight safety checklist was not emitted');
      if (wipeIndex === -1) throw new Error('target wipe did not happen');
      if (preflightIndex > wipeIndex) throw new Error('target was wiped before backup preflight was emitted');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('preflight safety checklist was not emitted');
      expect(`${stdout}\n${stderr}`).not.toContain('target was wiped before backup preflight');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('migrate does not update config or clear manifest when verification fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-verify-fail-'));
    const scriptPath = join(tempDir, 'verify-failure.ts');
    writeFileSync(scriptPath, `
      import { existsSync } from 'fs';
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;

      let saveConfigCalls = 0;
      let targetDisconnects = 0;

      const emptyDbOnlyLists = {
        getIngestLog: async () => [],
        listTaskThreads: async () => [],
        listProfileMemoryEntries: async () => [],
        listPersonalEpisodeEntries: async () => [],
        listMemoryCandidateEntries: async () => [],
        listMemoryMutationEvents: async () => [],
        listMemoryRealms: async () => [],
        listMemorySessions: async () => [],
        listMemoryRedactionPlans: async () => [],
      };

      const targetEngine = {
        ...emptyDbOnlyLists,
        connect: async () => undefined,
        initSchema: async () => undefined,
        disconnect: async () => { targetDisconnects += 1; },
        getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [],
        putPage: async () => ({ id: 1, slug: 'concepts/a.md', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() }),
        updatePageEmbedding: async () => undefined,
        upsertChunks: async () => undefined,
        addTag: async () => undefined,
        addTimelineEntry: async () => undefined,
        putRawData: async () => undefined,
        addLink: async () => undefined,
        setConfig: async () => undefined,
      };

      const sourceEngine = {
        ...emptyDbOnlyLists,
        getStats: async () => ({ page_count: 1, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [{ id: 1, slug: 'concepts/a.md', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() }],
        getPageEmbeddings: async () => [],
        getChunksWithEmbeddings: async () => [],
        getTags: async () => [],
        getTimeline: async () => [],
        getRawData: async () => [],
        getVersions: async () => [],
        getLinks: async () => [],
        getConfig: async () => null,
      };

      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => { saveConfigCalls += 1; },
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => targetEngine,
      }));

      const originalExit = process.exit;
      process.exit = ((code?: number) => { throw new Error('EXIT:' + String(code)); }) as typeof process.exit;
      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?verify-failure=' + Date.now(), repoRootUrl).href);
        try {
          await runMigrateEngine(sourceEngine as any, ['--to', 'pglite', '--path', '/target.pglite']);
          throw new Error('expected migration to fail');
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'EXIT:1') throw error;
        }
      } finally {
        process.exit = originalExit;
      }

      if (saveConfigCalls !== 0) throw new Error('saveConfig was called before verification passed');
      if (!existsSync(join(manifestDir, 'migrate-manifest.json'))) throw new Error('manifest was cleared on failed verification');
      if (targetDisconnects !== 1) throw new Error('target was not disconnected on failed verification');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('saveConfig was called');
      expect(`${stdout}\n${stderr}`).not.toContain('manifest was cleared');
      expect(`${stdout}\n${stderr}`).not.toContain('target was not disconnected');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('migrate resumes a partial manifest into a non-empty target without force', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-resume-'));
    const scriptPath = join(tempDir, 'resume.ts');
    writeFileSync(scriptPath, `
      import { existsSync, writeFileSync } from 'fs';
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;
      const manifestPath = join(manifestDir, 'migrate-manifest.json');

      writeFileSync(manifestPath, JSON.stringify({
        completed_slugs: ['concepts/a'],
        target_engine: 'pglite',
        target_identity: 'pglite:/target.pglite',
        source_identity: 'sqlite:/source.db',
        started_at: '2026-05-22T00:00:00.000Z',
      }));

      let saveConfigCalls = 0;
      let targetDisconnects = 0;
      const putPageSlugs: string[] = [];
      const pages = new Map([
        ['concepts/a', { id: 1, slug: 'concepts/a', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() }],
      ]);

      const emptyDbOnlyLists = {
        getIngestLog: async () => [],
        listTaskThreads: async () => [],
        listProfileMemoryEntries: async () => [],
        listPersonalEpisodeEntries: async () => [],
        listMemoryCandidateEntries: async () => [],
        listMemoryMutationEvents: async () => [],
        listMemoryRealms: async () => [],
        listMemorySessions: async () => [],
        listMemoryRedactionPlans: async () => [],
      };

      const targetEngine = {
        ...emptyDbOnlyLists,
        connect: async () => undefined,
        initSchema: async () => undefined,
        disconnect: async () => { targetDisconnects += 1; },
        getStats: async () => ({ page_count: pages.size, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [...pages.values()],
        putPage: async (slug: string, page: any) => {
          putPageSlugs.push(slug);
          const stored = { id: pages.size + 1, slug, ...page, created_at: new Date(), updated_at: new Date() };
          pages.set(slug, stored);
          return stored;
        },
        updatePageEmbedding: async () => undefined,
        upsertChunks: async () => undefined,
        addTag: async () => undefined,
        addTimelineEntry: async () => undefined,
        putRawData: async () => undefined,
        addLink: async () => undefined,
        setConfig: async () => undefined,
      };

      const sourcePages = [
        { id: 1, slug: 'concepts/a', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() },
        { id: 2, slug: 'concepts/b', type: 'concept', title: 'B', compiled_truth: 'B', timeline: '', frontmatter: {}, content_hash: 'hash-b', created_at: new Date(), updated_at: new Date() },
      ];
      const sourceEngine = {
        ...emptyDbOnlyLists,
        getStats: async () => ({ page_count: 2, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => sourcePages,
        getPageEmbeddings: async () => [],
        getChunksWithEmbeddings: async () => [],
        getTags: async () => [],
        getTimeline: async () => [],
        getRawData: async () => [],
        getVersions: async () => [],
        getLinks: async () => [],
        getConfig: async () => null,
      };

      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => { saveConfigCalls += 1; },
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => targetEngine,
      }));

      const originalExit = process.exit;
      process.exit = ((code?: number) => { throw new Error('EXIT:' + String(code)); }) as typeof process.exit;
      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?resume=' + Date.now(), repoRootUrl).href);
        await runMigrateEngine(sourceEngine as any, ['--to', 'pglite', '--path', '/target.pglite']);
      } finally {
        process.exit = originalExit;
      }

      if (putPageSlugs.join(',') !== 'concepts/b') throw new Error('resume did not migrate only the missing page: ' + putPageSlugs.join(','));
      if (saveConfigCalls !== 1) throw new Error('saveConfig was not called exactly once after successful resume');
      if (existsSync(manifestPath)) throw new Error('manifest was not cleared after successful resume');
      if (targetDisconnects !== 1) throw new Error('target was not disconnected after successful resume');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('EXIT:1');
      expect(`${stdout}\n${stderr}`).not.toContain('resume did not migrate');
      expect(`${stdout}\n${stderr}`).not.toContain('saveConfig was not called');
      expect(`${stdout}\n${stderr}`).not.toContain('manifest was not cleared');
      expect(`${stdout}\n${stderr}`).not.toContain('target was not disconnected');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('migrate rejects a non-empty target when the resume manifest belongs to a different source or target', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-stale-manifest-'));
    const scriptPath = join(tempDir, 'stale-manifest.ts');
    writeFileSync(scriptPath, `
      import { writeFileSync } from 'fs';
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;
      const manifestPath = join(manifestDir, 'migrate-manifest.json');

      writeFileSync(manifestPath, JSON.stringify({
        completed_slugs: ['concepts/a'],
        target_engine: 'pglite',
        target_identity: 'pglite:/different-target.pglite',
        source_identity: 'sqlite:/source.db',
        started_at: '2026-05-22T00:00:00.000Z',
      }));

      let putPageCalls = 0;
      let saveConfigCalls = 0;
      let targetDisconnects = 0;
      const emptyDbOnlyLists = {
        getIngestLog: async () => [],
        listTaskThreads: async () => [],
        listProfileMemoryEntries: async () => [],
        listPersonalEpisodeEntries: async () => [],
        listMemoryCandidateEntries: async () => [],
        listMemoryMutationEvents: async () => [],
        listMemoryRealms: async () => [],
        listMemorySessions: async () => [],
        listMemoryRedactionPlans: async () => [],
      };

      const targetEngine = {
        ...emptyDbOnlyLists,
        connect: async () => undefined,
        initSchema: async () => undefined,
        disconnect: async () => { targetDisconnects += 1; },
        getStats: async () => ({ page_count: 1, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [{ id: 1, slug: 'concepts/a', type: 'concept', title: 'A', compiled_truth: 'A', timeline: '', frontmatter: {}, content_hash: 'hash-a', created_at: new Date(), updated_at: new Date() }],
        putPage: async () => { putPageCalls += 1; },
      };
      const sourceEngine = { ...emptyDbOnlyLists };

      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => { saveConfigCalls += 1; },
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => targetEngine,
      }));

      const originalExit = process.exit;
      process.exit = ((code?: number) => { throw new Error('EXIT:' + String(code)); }) as typeof process.exit;
      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?stale-manifest=' + Date.now(), repoRootUrl).href);
        try {
          await runMigrateEngine(sourceEngine as any, ['--to', 'pglite', '--path', '/target.pglite']);
          throw new Error('expected migration to fail');
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'EXIT:1') throw error;
        }
      } finally {
        process.exit = originalExit;
      }

      if (putPageCalls !== 0) throw new Error('copied pages after stale manifest bypassed non-empty target guard');
      if (saveConfigCalls !== 0) throw new Error('saveConfig was called after stale manifest rejection');
      if (targetDisconnects !== 1) throw new Error('target was not disconnected after stale manifest rejection');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('copied pages');
      expect(`${stdout}\n${stderr}`).not.toContain('saveConfig was called');
      expect(`${stdout}\n${stderr}`).not.toContain('target was not disconnected');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('migrate rejects targets with DB-only runtime records before copying pages', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-migration-target-dbonly-'));
    const scriptPath = join(tempDir, 'target-dbonly.ts');
    writeFileSync(scriptPath, `
      import { existsSync } from 'fs';
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const manifestDir = ${JSON.stringify(tempDir)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const configPath = new URL('src/core/config.ts', repoRootUrl).pathname;

      let saveConfigCalls = 0;
      let putPageCalls = 0;
      let targetDisconnects = 0;

      const emptyDbOnlyLists = {
        getIngestLog: async () => [],
        listTaskThreads: async () => [],
        listProfileMemoryEntries: async () => [],
        listPersonalEpisodeEntries: async () => [],
        listMemoryMutationEvents: async () => [],
        listMemoryRealms: async () => [],
        listMemorySessions: async () => [],
        listMemoryRedactionPlans: async () => [],
      };

      const targetEngine = {
        ...emptyDbOnlyLists,
        listMemoryCandidateEntries: async () => [{ id: 'candidate-1' }],
        connect: async () => undefined,
        initSchema: async () => undefined,
        disconnect: async () => { targetDisconnects += 1; },
        getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
        listPages: async () => [],
        putPage: async () => { putPageCalls += 1; },
      };

      const sourceEngine = {
        ...emptyDbOnlyLists,
        listMemoryCandidateEntries: async () => [],
      };

      mock.module(configPath, () => ({
        configDir: () => manifestDir,
        loadConfig: () => ({ engine: 'sqlite', database_path: '/source.db', offline: true, embedding_provider: 'local', query_rewrite_provider: 'heuristic' }),
        saveConfig: () => { saveConfigCalls += 1; },
      }));
      mock.module(engineFactoryPath, () => ({
        createEngine: async () => targetEngine,
      }));

      const originalExit = process.exit;
      process.exit = ((code?: number) => { throw new Error('EXIT:' + String(code)); }) as typeof process.exit;
      try {
        const { runMigrateEngine } = await import(new URL('src/commands/migrate-engine.ts?target-dbonly=' + Date.now(), repoRootUrl).href);
        try {
          await runMigrateEngine(sourceEngine as any, ['--to', 'pglite', '--path', '/target.pglite']);
          throw new Error('expected migration to fail');
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'EXIT:1') throw error;
        }
      } finally {
        process.exit = originalExit;
      }

      if (putPageCalls !== 0) throw new Error('copied pages into a target with DB-only records');
      if (saveConfigCalls !== 0) throw new Error('saveConfig was called for a contaminated target');
      if (existsSync(join(manifestDir, 'migrate-manifest.json'))) throw new Error('manifest was created for a contaminated target');
      if (targetDisconnects !== 1) throw new Error('target was not disconnected after target DB-only rejection');
    `);

    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, HOME: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain('copied pages');
      expect(`${stdout}\n${stderr}`).not.toContain('saveConfig was called');
      expect(`${stdout}\n${stderr}`).not.toContain('manifest was created');
      expect(`${stdout}\n${stderr}`).not.toContain('target was not disconnected');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('README no longer advertises SQLite as the recommended target default', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('MBrain is a Postgres + pgvector personal memory runtime');
    expect(readme).toContain('mbrain init --profile homebrew-postgres');
    expect(readme).toMatch(/The profile does not start\s+Postgres or create the database/);
    expect(readme).toContain('Postgres init currently starts with `embedding_provider="none"`');
    expect(readme).toContain('Legacy local SQLite mode remains available with `mbrain init --local`');
    expect(readme).not.toContain('MBrain is a local SQLite memory layer');
    expect(readme).not.toContain('## Quick Start: Local SQLite');
    expect(readme).not.toContain('SQLiteEngine | Single-user local/offline personal brain | Recommended default');
    expect(readme).not.toContain('SQLite-first');
    expect(readme).not.toContain('SQLite is the recommended engine');
  });

  test('local offline guides frame SQLite as legacy compatibility rather than the target default', () => {
    const english = readRepoFile('docs/local-offline.md');
    const korean = readRepoFile('docs/local-offline.ko.md');

    expect(english).toContain('Legacy Local SQLite Compatibility');
    expect(english).toContain('Postgres + pgvector runtime is the target default');
    expect(english).toContain('mbrain init --profile homebrew-postgres');
    expect(english).toContain('Use this legacy SQLite guide only when');
    expect(english).not.toContain('Use the **local/offline** profile when you want:');

    expect(korean).toContain('레거시 로컬 SQLite 호환 가이드');
    expect(korean).toContain('Postgres + pgvector 런타임이 기본 target');
    expect(korean).toContain('mbrain init --profile homebrew-postgres');
    expect(korean).toContain('이 레거시 SQLite 가이드는');
    expect(korean).not.toContain('다음 조건이면 local/offline 모드가 적합합니다.');
  });

  test('agent rules describe the new automated Postgres runtime boundaries', () => {
    const rules = readRepoFile('docs/MBRAIN_AGENT_RULES.md');

    expect(rules).toContain('managed Postgres + pgvector target runtime');
    expect(rules).toContain('session-scoped trust');
    expect(rules).toContain('automatic canonical writeback exists');
    expect(rules).toContain('route durable signals through the assertion pipeline');
    expect(rules).toContain('raw source access is scoped');
    expect(rules).toContain('secrets are never canonical memory');
    expect(rules).toContain('daily memory report is the primary review surface');
  });

  test('verification runbook includes the Phase 14 migration cleanup gate', () => {
    const verify = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(verify).toContain('## Phase 14 Postgres runtime migration cleanup');
    expect(verify).toContain('bun test test/postgres-runtime-migration-cleanup.test.ts');
    expect(verify).toContain('fresh install and docs point to Postgres-only target');
    expect(verify).toContain('legacy SQLite/PGLite paths are isolated from target runtime behavior');
    expect(verify).toContain('guide-only output marks counts and content hashes pending until Markdown');
    expect(verify).toContain('import and projection reconciliation run');
    expect(verify).toContain('completed legacy compatibility copies still verify counts and content hashes');
    expect(verify).toContain('DATABASE_URL=\'postgresql://...\' bun run smoke:postgres-runtime');
    expect(verify).toContain('real Postgres confidence smoke initializes a disposable target');
    expect(verify).toContain('reads it through bounded `mbrain call get_page`');
    expect(verify).toContain('runs `bun run test:phase13`');
    expect(verify).toContain('## Postgres runtime confidence smoke');
    expect(verify).toContain('real Postgres init, Markdown');
    expect(verify).toContain('import, bounded canonical page reads, deterministic Phase 13 replay, and doctor');
    expect(verify).toContain('does not prove the configured agent MCP shares the');
    expect(verify).toContain('`runtime_db_identity` is evidence from the active process');
    expect(verify).toContain('not from the isolated installed');
    expect(verify).toContain('MCP smoke alone');
    expect(verify).toContain('Before making a release-readiness claim');
    expect(verify).toContain('MBrain project self-brain');
    expect(verify).toContain('refresh it or state explicitly');
    expect(verify).toContain('source-tree release checks did not update durable project memory');
    expect(verify).toContain('without OpenAI or Anthropic API keys');
    expect(verify).toContain('Phase 13 evidence is deterministic replay plus live-eval budget gating');
    expect(verify).toContain('Do not report live LLM eval evidence unless the budgeted live eval was actually run');
    expect(verify).not.toContain('migration output verifies counts and content hashes');
  });

  test('PR completion docs describe Phase 14 and keep PGLite work legacy-scoped', () => {
    const changelog = readRepoFile('CHANGELOG.md');
    const todos = readRepoFile('TODOS.md');
    const readme = readRepoFile('README.md');

    expect(changelog).toContain('Postgres runtime migration cleanup');
    expect(changelog).toContain('Fresh installs, migration help, and agent rules now point to the Postgres target runtime');
    expect(todos).toContain('## Legacy Compatibility');
    expect(todos).toContain('### PGLite compiled-binary compatibility');
    expect(todos).not.toContain('## P0\n\n### Fix `bun build --compile` WASM embedding for PGLite');
    expect(readme).toContain('For target Postgres runtime verification, run:');
    expect(readme).toContain('bun test test/postgres-runtime-migration-cleanup.test.ts');
    expect(readme).toContain('DATABASE_URL=\'postgresql://...\' bun run smoke:postgres-runtime');
    expect(readme).toContain('`smoke:postgres-runtime` is the Phase 14 confidence gate');
    expect(readme).toContain('without\nrequiring OpenAI or Anthropic API keys');
    expect(readme).toContain('Legacy local SQLite verification is isolated compatibility coverage');
    expect(readme).toContain('For release or installed-command confidence, also run the installed-command');
    expect(readme).toContain('MCP smoke starts the command in an isolated temporary local profile');
    expect(readme).toContain('Release-readiness notes should also verify the MBrain project self-brain page');
    expect(readme).toContain('Phase 13 is deterministic replay plus live-eval budget gating');
    expect(readme).toContain('by default, not evidence that paid live LLM evals ran');
    expect(readme).not.toContain('For source-tree unit and legacy local SQLite verification, run:');
    expect(readme).toContain('legacy SQLite compatibility guide');
  });

  test('Phase 14 cleanup removes stale Supabase-default and parity-default wording', () => {
    const initSource = readRepoFile('src/commands/init.ts');
    const redesignRoadmap = readRepoFile('docs/architecture/redesign/03-migration-roadmap-and-execution-envelope.md');

    expect(initSource).not.toContain('When you outgrow local: mbrain migrate --to supabase');
    expect(initSource).toContain('When you outgrow legacy local mode: mbrain migrate --to postgres');
    expect(redesignRoadmap).not.toContain('Postgres is not the only real target');
    expect(redesignRoadmap).not.toContain('including SQLite, Postgres, and PGLite');
    expect(redesignRoadmap).not.toContain('Enforce parity tests at each public contract boundary');
    expect(redesignRoadmap).not.toContain('Keep local/offline as a release gate for every phase');
    expect(redesignRoadmap).toContain('Postgres is the target runtime for new personal memory features');
    expect(redesignRoadmap).toContain('Do not make SQLite/PGLite parity a target-runtime release gate');
    expect(redesignRoadmap).toContain('| Phase 10 | System-of-record reconciler |');
    expect(redesignRoadmap).toContain('| Phase 14 | Migration and cleanup |');
    expect(redesignRoadmap).toContain('Connector stubs are not full source-choice acceptance');
    expect(redesignRoadmap).toContain('Deterministic fixtures can guard regressions early');
  });
});
