import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  assertOk,
  commitAll,
  createSqliteCliHarness,
  initGitRepo,
  pageMarkdown,
  parseJsonSuffix,
  type SqliteCliHarness,
} from './sqlite-cli-helpers.ts';

let harness: SqliteCliHarness | null = null;

afterEach(() => {
  harness?.teardown();
  harness = null;
});

describe('local SQLite CLI end-to-end', () => {
  test('init, import, retrieve, write, sync, and export all use one local SQLite brain', () => {
    harness = createSqliteCliHarness('cli');
    initGitRepo(harness);
    harness.writeBrainFile('people/alice.md', pageMarkdown({
      type: 'person',
      title: 'Alice Local',
      tags: ['person', 'sqlite'],
      body: 'Alice keeps durable local recall notes in the SQLite brain.',
      timeline: '- 2026-04-01 | Added local SQLite recall evidence.',
    }));
    harness.writeBrainFile('concepts/local-memory.md', pageMarkdown({
      type: 'concept',
      title: 'Local Memory',
      tags: ['sqlite'],
      body: 'Local memory should work without Postgres, Supabase, or network services.',
    }));
    commitAll(harness, 'seed local brain');

    const init = harness.runJson<{ status: string; engine: string; path: string }>(['init', '--local', '--json']);
    expect(init).toMatchObject({ status: 'success', engine: 'sqlite', path: harness.dbPath });
    expect(existsSync(harness.dbPath)).toBe(true);
    const config = JSON.parse(readFileSync(join(harness.configDir, 'config.json'), 'utf-8'));
    expect(config).toMatchObject({
      engine: 'sqlite',
      database_path: harness.dbPath,
      offline: true,
      embedding_provider: 'local',
      embedding_model: 'nomic-embed-text',
      query_rewrite_provider: 'heuristic',
    });
    expect(config.database_url).toBeUndefined();

    const imported = harness.runJson<{ imported: number; total_files: number; chunks: number }>([
      'import',
      harness.brainRepoDir,
      '--no-embed',
      '--workers',
      '1',
      '--fresh',
      '--json',
    ]);
    expect(imported.imported).toBe(2);
    expect(imported.total_files).toBe(2);
    expect(imported.chunks).toBeGreaterThanOrEqual(2);

    const stats = harness.run(['stats']);
    assertOk(stats, ['stats']);
    expect(stats.stdout).toContain('Pages:     2');
    expect(stats.stdout).toContain('Chunks:');

    const list = harness.run(['list', '--type', 'person']);
    assertOk(list, ['list', '--type', 'person']);
    expect(list.stdout).toContain('people/alice');
    expect(list.stdout).toContain('Alice Local');

    const aliceManifest = harness.run(['manifest-get', 'people/alice']);
    assertOk(aliceManifest, ['manifest-get', 'people/alice']);
    expect(aliceManifest.stdout).toContain('Alice Local');

    const get = harness.run(['get', 'people/alice']);
    assertOk(get, ['get', 'people/alice']);
    expect(get.stdout).toContain('Alice keeps durable local recall notes');

    const search = harness.run(['search', 'durable local recall']);
    assertOk(search, ['search', 'durable local recall']);
    expect(search.stdout).toContain('people/alice');

    const query = harness.run(['query', 'durable local recall']);
    assertOk(query, ['query', 'durable local recall']);
    expect(query.stdout).toContain('people/alice');

    const callGet = harness.call<{ slug: string; title: string; tags: string[] }>('get_page', {
      slug: 'concepts/local-memory',
    });
    expect(callGet.slug).toBe('concepts/local-memory');
    expect(callGet.title).toBe('Local Memory');
    expect(callGet.tags).toContain('sqlite');

    const updatedConcept = pageMarkdown({
      type: 'concept',
      title: 'Local Memory',
      tags: ['sqlite', 'updated'],
      body: 'Local memory now includes corrected text after a SQLite sync.',
      timeline: '- 2026-04-02 | Corrected the local memory wording.',
    });
    writeFileSync(join(harness.brainRepoDir, 'concepts/local-memory.md'), updatedConcept);
    commitAll(harness, 'correct local memory');

    const sync = harness.run(['sync', '--repo', harness.brainRepoDir, '--no-pull']);
    assertOk(sync, ['sync', '--repo', harness.brainRepoDir, '--no-pull']);
    expect(sync.stdout).toMatch(/Synced|First sync complete|Already up to date/);

    const syncedSearch = harness.run(['search', 'corrected text']);
    assertOk(syncedSearch, ['search', 'corrected text']);
    expect(syncedSearch.stdout).toContain('concepts/local-memory');

    const putResult = harness.call<{ status: string; chunks: number }>('put_page', {
      slug: 'systems/sqlite-cli',
      content: pageMarkdown({
        type: 'system',
        title: 'SQLite CLI',
        tags: ['system', 'sqlite'],
        body: 'The SQLite CLI path writes through the same operation contract as MCP.',
      }),
    });
    expect(putResult.status).toBe('created_or_updated');
    expect(putResult.chunks).toBeGreaterThan(0);

    expect(harness.call<{ status: string }>('add_tag', {
      slug: 'systems/sqlite-cli',
      tag: 'verified',
    }).status).toBe('ok');
    expect(harness.call<string[]>('get_tags', { slug: 'systems/sqlite-cli' })).toContain('verified');

    expect(harness.call<{ status: string }>('add_link', {
      from: 'systems/sqlite-cli',
      to: 'concepts/local-memory',
      link_type: 'implements',
      context: 'SQLite CLI implements local memory retrieval.',
    }).status).toBe('ok');
    const backlinks = harness.call<Array<{ from_slug: string }>>('get_backlinks', {
      slug: 'concepts/local-memory',
    });
    expect(backlinks.some(link => link.from_slug === 'systems/sqlite-cli')).toBe(true);
    expect(harness.call<{ status: string }>('put_raw_data', {
      slug: 'people/alice',
      source: 'sqlite-e2e',
      data: { retained_until_delete: true },
    }).status).toBe('ok');
    expect(harness.call<any[]>('get_raw_data', {
      slug: 'people/alice',
      source: 'sqlite-e2e',
    })).toHaveLength(1);
    expect(harness.call<{ status: string }>('add_timeline_entry', {
      slug: 'people/alice',
      date: '2026-04-03',
      summary: 'Verified Alice local timeline cleanup.',
      source: 'SQLite E2E',
    }).status).toBe('ok');
    const aliceTimeline = harness.call<Array<{ summary: string }>>('get_timeline', {
      slug: 'people/alice',
    });
    expect(aliceTimeline.some(entry => entry.summary.includes('Alice local timeline cleanup'))).toBe(true);
    const aliceChunks = harness.call<Array<{ chunk_text: string }>>('get_chunks', {
      slug: 'people/alice',
    });
    expect(aliceChunks.length).toBeGreaterThan(0);
    expect(aliceChunks.some(chunk => chunk.chunk_text.includes('durable local recall notes'))).toBe(true);

    expect(harness.call<{ status: string }>('add_timeline_entry', {
      slug: 'systems/sqlite-cli',
      date: '2026-04-25',
      summary: 'Verified local SQLite CLI write path.',
      source: 'SQLite E2E',
    }).status).toBe('ok');
    const timeline = harness.call<Array<{ summary: string }>>('get_timeline', {
      slug: 'systems/sqlite-cli',
    });
    expect(timeline.some(entry => entry.summary.includes('Verified local SQLite CLI'))).toBe(true);

    harness.call('put_page', {
      slug: 'systems/sqlite-cli',
      content: pageMarkdown({
        type: 'system',
        title: 'SQLite CLI',
        tags: ['system', 'sqlite', 'verified'],
        body: 'The SQLite CLI path keeps version history for local writes.',
      }),
    });
    const history = harness.call<Array<{ id: number; compiled_truth: string }>>('get_versions', {
      slug: 'systems/sqlite-cli',
    });
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]?.compiled_truth).toContain('same operation contract');

    const exportResult = harness.run(['export', '--dir', harness.exportDir]);
    assertOk(exportResult, ['export', '--dir', harness.exportDir]);
    expect(existsSync(join(harness.exportDir, 'systems/sqlite-cli.md'))).toBe(true);
    expect(readFileSync(join(harness.exportDir, 'systems/sqlite-cli.md'), 'utf-8'))
      .toContain('keeps version history');

    rmSync(join(harness.brainRepoDir, 'people/alice.md'));
    commitAll(harness, 'remove alice');
    const deleteSync = harness.run(['sync', '--repo', harness.brainRepoDir, '--no-pull']);
    assertOk(deleteSync, ['sync', '--repo', harness.brainRepoDir, '--no-pull']);
    const missingAlice = harness.run(['get', 'people/alice']);
    expect(missingAlice.exitCode).toBe(1);
    expect(missingAlice.stderr).toContain('Page not found: people/alice');
    expect(harness.call<any[]>('get_chunks', { slug: 'people/alice' })).toHaveLength(0);
    expect(harness.call<any[]>('get_raw_data', { slug: 'people/alice' })).toHaveLength(0);
    expect(harness.call<any[]>('get_timeline', { slug: 'people/alice' })).toHaveLength(0);
    const deletedSearch = harness.run(['search', 'durable local recall']);
    assertOk(deletedSearch, ['search', 'durable local recall']);
    expect(deletedSearch.stdout).not.toContain('people/alice');
    const deletedManifest = harness.run(['manifest-get', 'people/alice']);
    expect(deletedManifest.exitCode).toBe(1);
    expect(deletedManifest.stderr).toContain('Note manifest entry not found: people/alice');

    const filesList = harness.run(['files', 'list']);
    expect(filesList.exitCode).toBe(1);
    expect(filesList.stderr).toMatch(/files\/storage commands/i);
    expect(filesList.stderr).toMatch(/sqlite\/local mode|offline/i);

    const updateCheck = harness.run(['check-update', '--json']);
    assertOk(updateCheck, ['check-update', '--json']);
    expect(parseJsonSuffix<{ error: string; update_available: boolean }>(updateCheck.stdout)).toMatchObject({
      error: 'offline_mode',
      update_available: false,
    });
  }, 60_000);
});
