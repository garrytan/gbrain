/**
 * GBRA-133 PR 2b: work a sync no longer does on its own path.
 *
 * 1. Post-import extraction. Before, the sync hook parsed every markdown file in the tree for page types
 *    (loadFsPageTypes) to extract the links of a few changed pages. Now it parses only the files of the link
 *    endpoints those pages ask about, and the links equal the whole-tree parse that full foresights extract still runs:
 *    a target typed in its frontmatter (off its path's type), a target whose newer file is not imported, a target
 *    never imported, and a schema-pack page-type change all resolve the same.
 * 2. The ghost-page report. Before, a managed sync scanned every live page of the source before it returned (and so
 *    before it released its drain lease and the serve's single-flight slot). Now the sync answers from the last scan
 *    and starts the next one in the background, at most once per interval per source, only after a sync landed.
 * 3. Commit-triggered syncs. The deferred-embed drain retries a failing provider and never calls one on a keyless
 *    brain; a --no-pull cost estimate fetches nothing; and a classic sync spawns no synchronous Git, so a resident's
 *    event loop keeps serving while it syncs.
 *
 * PGLite always, Postgres when DATABASE_URL is set (test/e2e wrapper).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import * as markdown from '../../src/core/markdown.ts';
import * as ghostPages from '../../src/core/ghost-pages.ts';
import * as spawn from '../../src/core/spawn.ts';
import { performSync } from '../../src/commands/sync.ts';
import { runExtractCore } from '../../src/commands/extract.ts';
import { estimateInlineNewTokens } from '../../src/core/sync-cost-gate.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../../src/core/schema-pack/bundled-assets.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';
import { md, record, withProbeEngine, withProbeRepo } from './s-blockers-fixture.ts';

const FILLER = 40;
const PAGE = 'people/alice-example';
const packFile = (name: string, notePrefixes: string[]) => JSON.stringify({ api_version: 'gbrain-schema-pack-v1', name, version: '1.0.0', extends: null,
  page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'] }, { name: 'note', primitive: 'annotation', path_prefixes: notePrefixes }],
  link_types: [], frontmatter_links: [] });
const pageBody = (round: number) => `---\ntype: person\ntitle: Alice Example\n---\nRound ${round}.\n\n`
  + ['acme', 'erin', 'carol', 'dana'].map(name => `Alice works at [[${name === 'carol' ? 'crew' : 'notes'}/${name}-example]].\n`).join('\n');
const typed = (title: string, type: string) => `---\ntitle: ${title}\ntype: ${type}\n---\nThe ${title} page.\n`;

async function pageLinks(engine: BrainEngine, sourceId: string): Promise<Array<{ to_slug: string; link_type: string; link_source: string | null; context: string }>> {
  return engine.executeRaw(`SELECT t.slug AS to_slug, l.link_type, l.link_source, l.context FROM links l
    JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id=$1 AND f.slug=$2 ORDER BY t.slug, l.link_type, l.link_source, l.context`, [sourceId, PAGE]);
}

describe('GBRA-133 2b.1: the sync hook resolves endpoint page types, not the whole tree', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`links equal the whole-tree extract, and no unrelated file is parsed (${backend})`, async () => {
      await withProbeEngine(databaseUrl, async (engine, home) => {
        const packs = join(home, 'packs'); mkdirSync(packs, { recursive: true });
        writeFileSync(join(packs, 'offpath-a.json'), packFile('offpath-a', ['notes/']));
        writeFileSync(join(packs, 'offpath-b.json'), packFile('offpath-b', ['notes/', 'crew/']));
        __setPackLocatorForTests(name => name.startsWith('offpath-') ? join(packs, `${name}.json`) : bundledPackPath(name));
        _resetPackCacheForTests();
        await engine.setConfig('schema_pack', 'offpath-a');
        try {
          await withProbeRepo(engine, 'classic', home, async r => {
            const sync = () => performSync(engine, { repoPath: r.root, sourceId: r.sourceId, noPull: true, noEmbed: true, concurrency: 1 });
            const commitPage = (round: number) => { r.write(`${PAGE}.md`, pageBody(round)); r.git('add', `${PAGE}.md`); r.git('commit', '-qm', `round ${round}`); };
            for (let i = 0; i < FILLER; i++) r.write(`filler/f-${i}.md`, md(`filler ${i}`));
            // The path says note; the file says company (a works_at target only as a company).
            r.write('notes/acme-example.md', typed('Acme Example', 'company'));
            r.write('notes/erin-example.md', typed('Erin Example', 'note'));
            r.write('crew/carol-example.md', '# Carol Example\n');
            r.write(`${PAGE}.md`, pageBody(0));
            r.commitAll('seed');
            await sync();
            // Erin's newer file (now a company) is not imported, as a held file's is not; Dana's was never imported.
            r.write('notes/erin-example.md', typed('Erin Example', 'company'));
            r.write('notes/dana-example.md', typed('Dana Example', 'company'));
            commitPage(1);
            const parsed = new Set<string>();
            const original = markdown.parseMarkdown;
            const spy = spyOn(markdown, 'parseMarkdown').mockImplementation(((content: string, path?: string, opts?: never) => {
              if (path) parsed.add(path);
              return original(content, path, opts);
            }) as typeof markdown.parseMarkdown);
            let viaSync: Awaited<ReturnType<typeof pageLinks>>;
            try { expect((await sync()).status).toBe('synced'); viaSync = await pageLinks(engine, r.sourceId); }
            finally { spy.mockRestore(); }
            const fillerParsed = [...parsed].filter(path => path.startsWith('filler/'));
            record({ case: '2b.1', backend, parsed: parsed.size, filler_parsed: fillerParsed.length });
            expect(fillerParsed).toEqual([]);
            expect(viaSync.map(link => [link.to_slug, link.link_type])).toEqual([
              ['crew/carol-example', 'works_at'], ['notes/acme-example', 'works_at'], ['notes/erin-example', 'works_at']]);
            await runExtractCore(engine, { mode: 'links', dir: r.root, slugs: [PAGE], sourceId: r.sourceId, quiet: true });
            expect(await pageLinks(engine, r.sourceId)).toEqual(viaSync);

            // A pack page-type change applies on the next sync: crew/ pages become notes.
            await engine.setConfig('schema_pack', 'offpath-b'); _resetPackCacheForTests();
            commitPage(2);
            expect((await sync()).status).toBe('synced');
            const afterPack = await pageLinks(engine, r.sourceId);
            expect(afterPack.find(link => link.to_slug === 'crew/carol-example')?.link_type).toBe('mentions');
            await runExtractCore(engine, { mode: 'links', dir: r.root, slugs: [PAGE], sourceId: r.sourceId, quiet: true });
            expect(await pageLinks(engine, r.sourceId)).toEqual(afterPack);
          });
        } finally { _resetPackLocatorForTests(); _resetPackCacheForTests(); }
      });
    }, 180_000);
  }
});

describe('GBRA-133 2b.2: the ghost report runs after the sync, rate-limited per source', () => {
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`a managed sync returns before its ghost scan finishes and reports it next time (${backend})`, () => managedBrain(async ({ engine, ctx, root }) => {
      const sync = () => performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
      for (const slug of ['notes/kept', 'notes/gone']) {
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${slug} body.\n` } });
      }
      // The files are committed first: a page whose file never reached Git is a working-tree page, which a full pass deletes.
      await settleManagedGitEffects(engine);
      await disposePersistenceConsumer(engine);
      const ghosts = await import('../../src/core/persistence/sync-ghosts.ts') as Partial<typeof import('../../src/core/persistence/sync-ghosts.ts')>;
      const since = ghosts.syncGhostDecisions?.length ?? 0;
      const decisions = () => (ghosts.syncGhostDecisions ?? []).slice(since).filter(d => d.source_id === 'default').map(d => d.decision);
      const settle = () => ghosts.settleSyncGhostScans?.(engine) ?? Promise.resolve();
      let release!: () => void;
      let gate = new Promise<void>(resolve => { release = resolve; });
      let scans = 0;
      const original = ghostPages.scanGhostSource;
      const spy = spyOn(ghostPages, 'scanGhostSource').mockImplementation(async (...args) => { scans++; await gate; return original(...args); });
      try {
        // A clean sync and its scan, then the file leaves the checkout (interval 0: each landed sync may claim a scan).
        await withEnv({ GBRAIN_SYNC_GHOST_INTERVAL_MS: '0' }, async () => { release(); await sync(); await settle(); });
        unlinkSync(join(root, 'notes/gone.md'));
        gate = new Promise<void>(resolve => { release = resolve; });
        scans = 0;
        const first = await withEnv({ GBRAIN_SYNC_GHOST_INTERVAL_MS: '0' }, () => Promise.race([sync(), Bun.sleep(30_000).then(() => 'still scanning' as const)]));
        expect(first).not.toBe('still scanning');
        expect(scans).toBe(1);
        expect(decisions()).toEqual(['scan_started', 'scan_done', 'scan_started']);
        await withEnv({ GBRAIN_SYNC_GHOST_INTERVAL_MS: '600000' }, async () => {
          // While the scan runs, a sync neither waits for it nor starts another.
          await sync();
          expect(scans).toBe(1);
          expect(decisions().at(-1)).toBe('scan_in_flight');
          release();
          await settle();
          expect(decisions().at(-1)).toBe('scan_done');
          // Within the interval the next sync reports the cached scan and starts none.
          const reported = await sync();
          expect(scans).toBe(1);
          expect(decisions().at(-1)).toBe('rate_limited');
          expect(reported.ghostPages).toMatchObject({ count: 1, samples: ['notes/gone'], fix: { argv: ['gbrain', 'repair', 'ghost-pages', '--source', 'default'] } });
        });
      } finally { release(); spy.mockRestore(); await settle(); }
      record({ case: '2b.2', backend, scans, decisions: decisions() });
      expect(decisions().filter(d => d === 'scan_started')).toHaveLength(2);
    }, { setup, databaseUrl }), 120_000);
  }
});

describe('GBRA-133 2b.3: commit-triggered syncs stay off the resident\'s path', () => {
  const model = 'openai:text-embedding-3-small';
  const vectors = (values: string[]) => ({ embeddings: values.map(() => new Array(1536).fill(0.01)), usage: { tokens: values.length } }) as never;
  async function embedBrain(databaseUrl: string | undefined, keyed: boolean, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-2b-embed-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', embedding_model: model, embedding_dimensions: 1536,
      ...(keyed ? { openai_api_key: 'synthetic-deferred-embed-key' } : {}) }));
    const runner = await import('../../src/core/serve-sync-runner.ts');
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, GBRAIN_EMBED_CONCURRENCY: '1',
        GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_DEFERRED_EMBED_RETRY_MS: '20' }, async () => {
        runner.__resetDelegatedSyncForTests();
        configureGateway({ embedding_model: model, embedding_dimensions: 1536, env: keyed ? { OPENAI_API_KEY: 'synthetic-deferred-embed-key' } : {} });
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          await engine.executeRaw("INSERT INTO sources(id,name) VALUES('alpha','alpha') ON CONFLICT DO NOTHING");
          await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Observation.' }, { sourceId: 'alpha' });
          await installFixtureChunks(engine, 'notes/example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Observation.', token_count: 3 }], { sourceId: 'alpha' });
          await run(engine);
        } finally { runner.__resetDelegatedSyncForTests(); await close(); }
      });
    } finally { __setEmbedTransportForTests(null); resetGateway(); rmSync(home, { recursive: true, force: true }); }
  }
  const embedded = async (engine: BrainEngine) => (await engine.getChunks('notes/example', { sourceId: 'alpha' }))[0]?.embedding_is_null === false;
  const drainDecisions = async () => ((await import('../../src/core/serve-sync-runner.ts') as { deferredEmbedDecisions?: Array<{ decision: string }> }).deferredEmbedDecisions ?? []).map(d => d.decision);

  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`the deferred-embed drain retries a failed provider until the backlog is embedded (${backend})`, () => embedBrain(databaseUrl, true, async engine => {
      const runner = await import('../../src/core/serve-sync-runner.ts');
      let calls = 0;
      __setEmbedTransportForTests(async ({ values }) => { if (++calls === 1) throw new Error('synthetic provider outage'); return vectors(values); });
      runner.scheduleDeferredSyncEmbeds(engine, 'alpha');
      await runner.maybeDrainDeferredEmbeds(engine);
      const deadline = performance.now() + 20_000;
      while ((await drainDecisions()).at(-1) !== 'drained' && performance.now() < deadline) await Bun.sleep(25);
      record({ case: '2b.3-retry', backend, calls, decisions: await drainDecisions() });
      expect(await embedded(engine)).toBe(true);
      expect(runner.__deferredEmbedsPendingForTests(engine)).toBe(false);
      // The failed pass backs off, the pass that embedded re-checks, and the pass that finds nothing left ends it.
      expect(await drainDecisions()).toEqual(['retry', 'retry', 'drained']);
    }), 60_000);

    test(`a running sync defers the drain a bounded number of times, then it drains beside it (${backend})`, () => embedBrain(databaseUrl, true, async engine => {
      const runner = await import('../../src/core/serve-sync-runner.ts');
      __setEmbedTransportForTests(async ({ values }) => vectors(values));
      runner.__setDeferredEmbedBusyProbeForTests(() => true);
      runner.scheduleDeferredSyncEmbeds(engine, 'alpha');
      await runner.maybeDrainDeferredEmbeds(engine);
      const deadline = performance.now() + 20_000;
      while ((await drainDecisions()).at(-1) !== 'drained' && performance.now() < deadline) await Bun.sleep(25);
      expect(await embedded(engine)).toBe(true);
      expect(runner.__deferredEmbedsPendingForTests(engine)).toBe(false);
      // Each pass waits out at most three busy checks, then drains beside the sync.
      expect(await drainDecisions()).toEqual(['busy', 'busy', 'busy', 'busy_override', 'retry', 'busy', 'busy', 'busy', 'busy_override', 'drained']);
    }), 60_000);

    test(`a keyless brain keeps its backlog and calls no provider (${backend})`, () => embedBrain(databaseUrl, false, async engine => {
      const runner = await import('../../src/core/serve-sync-runner.ts');
      let calls = 0;
      __setEmbedTransportForTests(async ({ values }) => { calls++; return vectors(values); });
      runner.scheduleDeferredSyncEmbeds(engine, 'alpha');
      await runner.maybeDrainDeferredEmbeds(engine);
      await Bun.sleep(200);
      expect(calls).toBe(0);
      expect(await embedded(engine)).toBe(false);
      expect(runner.__deferredEmbedsPendingForTests(engine)).toBe(true);
      expect(await drainDecisions()).toEqual(['keyless']);
    }), 60_000);

    test(`a classic sync with extraction spawns no synchronous Git (${backend})`, async () => {
      await withProbeEngine(databaseUrl, async (engine, home) => {
        await withProbeRepo(engine, 'classic', home, async r => {
          const sync = () => performSync(engine, { repoPath: r.root, sourceId: r.sourceId, noPull: true, noEmbed: true, concurrency: 1 });
          for (let i = 0; i < 20; i++) r.write(`notes/n-${i}.md`, `${md(`note ${i}`)}See [[notes/n-${(i + 1) % 20}]].\n`);
          r.commitAll('notes');
          await sync();
          r.write('notes/n-3.md', `${md('note 3 edited')}See [[notes/n-4]].\n`);
          r.commitAll('edit');
          const blocking: string[] = [];
          const execSpy = spyOn(spawn, 'execFileSync').mockImplementation(((file: string, args: string[], opts: never) => {
            blocking.push(`${file} ${(args ?? []).filter(arg => !arg.startsWith('-') && !arg.includes('=') && !arg.startsWith('/')).slice(0, 2).join(' ')}`);
            return execFileSync(file, args, opts);
          }) as typeof spawn.execFileSync);
          const spawnSpy = spyOn(spawn, 'spawnSync');
          let maxGap = 0, last = performance.now();
          const ticker = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 1);
          try { expect((await sync()).status).toBe('synced'); }
          finally { clearInterval(ticker); execSpy.mockRestore(); }
          const spawnSyncCalls = spawnSpy.mock.calls.length; spawnSpy.mockRestore();
          record({ case: '2b.3-git', backend, blocking, spawn_sync: spawnSyncCalls, max_event_loop_gap_ms: Math.round(maxGap) });
          expect(blocking).toEqual([]);
          expect(spawnSyncCalls).toBe(0);
        });
      });
    }, 120_000);
  }

  test('a --no-pull cost estimate prices local HEAD and fetches nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-2b-cost-'));
    try {
      const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
      const remote = join(home, 'remote.git'), local = join(home, 'local'), writer = join(home, 'writer');
      sh(home, 'init', '-q', '--bare', '-b', 'main', remote);
      sh(home, 'clone', '-q', remote, writer);
      writeFileSync(join(writer, 'a.md'), md('a')); sh(writer, 'add', '-A'); sh(writer, 'commit', '-qm', 'a'); sh(writer, 'push', '-q', 'origin', 'HEAD:main');
      sh(home, 'clone', '-q', remote, local);
      const base = sh(local, 'rev-parse', 'HEAD');
      writeFileSync(join(writer, 'b.md'), md('b')); sh(writer, 'add', '-A'); sh(writer, 'commit', '-qm', 'b'); sh(writer, 'push', '-q', 'origin', 'HEAD:main');
      await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
        const row = { local_path: local, config: {}, last_commit: base, chunker_version: 'test-chunker' };
        estimateInlineNewTokens([row], 'test-chunker', { noPull: true } as never);
        expect(sh(local, 'rev-parse', 'refs/remotes/origin/main')).toBe(base);
        // The same estimate for a pulling run fetches, so the check above is not vacuous.
        estimateInlineNewTokens([row], 'test-chunker', {});
        expect(sh(local, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(base);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});
