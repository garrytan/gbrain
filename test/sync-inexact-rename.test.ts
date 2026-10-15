/** #6729: Git similarity is not evidence that two pages are the same person. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { buildSyncManifest } from '../src/core/sync.ts';
import { buildDetachedWorkingTreeManifest, computeSyncDelta } from '../src/core/sync-delta.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const body = Array.from({ length: 30 }, (_, i) => `- Shared meeting ${i}: discussed the project roadmap and next steps.`).join('\n');
const person = (title: string, alias: string) => `---\ntype: person\ntitle: ${title}\naliases: [${alias}]\n---\n\n${body}\n`;

test('only R100 may carry identity; partial renames and copies are independent destinations', () => {
  expect(buildSyncManifest([
    'R090\t"people/old name.md"\t"people/new name.md"',
    'R099\tpeople/other.md\tpeople/next.md',
    'R100\tpeople/exact.md\tpeople/moved.md',
    'C090\tpeople/kept.md\tpeople/copied.md',
  ].join('\n'))).toEqual({
    added: ['people/new name.md', 'people/next.md', 'people/copied.md'],
    deleted: ['people/old name.md', 'people/other.md'],
    modified: [], renamed: [{ from: 'people/exact.md', to: 'people/moved.md' }],
  });
});

for (const kind of testBackends()) describe(`inexact Git rename identity (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-inexact-rename-'));
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (close) await close(); else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  test('retitled template pages cannot inherit another person’s facts, aliases, links or timeline', async () => {
    const source = `ir-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const root = join(home, source);
    mkdirSync(join(root, 'people'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'example@example.invalid'); git(root, 'config', 'user.name', 'Example');
    writeFileSync(join(root, 'people/old.md'), person('Alice', 'Ali'));
    writeFileSync(join(root, 'people/peer.md'), '---\ntype: person\ntitle: Peer\n---\n\nA different person.\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'initial');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [source, root]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
      const sync = () => performSync(engine, { repoPath: root, sourceId: source, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
      await sync();
      const old = (await engine.getPage('people/old', { sourceId: source }))!;
      const peer = (await engine.getPage('people/peer', { sourceId: source }))!;
      await engine.insertFact({ fact: 'Alice prefers tea', entity_slug: 'people/old', visibility: 'world', source: 'synthetic' }, { source_id: source });
      await engine.executeRaw("INSERT INTO timeline_entries(page_id,date,source,summary) VALUES($1,'2024-01-02','test','Alice met Peer')", [old.id]);
      await engine.executeRaw("INSERT INTO links(from_page_id,to_page_id,link_type,link_source) VALUES($1,$2,'knows','test')", [old.id, peer.id]);
      const anchor = git(root, 'rev-parse', 'HEAD');
      renameSync(join(root, 'people/old.md'), join(root, 'people/new.md'));
      writeFileSync(join(root, 'people/new.md'), person('Bob', 'Bobby'));
      git(root, 'add', '-A');
      const raw = git(root, 'diff', '--cached', '--name-status', '-M');
      expect(raw).toMatch(/^R0\d\d\tpeople\/old.md\tpeople\/new.md$/);
      // The dirty-tree and committed delta must use the same conservative policy.
      const dirtyManifest = buildDetachedWorkingTreeManifest(root);
      git(root, 'commit', '-qm', 'replace one template person with another');
      const head = git(root, 'rev-parse', 'HEAD');
      const delta = computeSyncDelta(root, anchor, head);
      const result = await sync();
      expect(result.status).toBe('synced');
      const bob = (await engine.getPage('people/new', { sourceId: source }))!;
      expect(bob.title).toBe('Bob');
      expect(bob.id).not.toBe(old.id);
      expect(dirtyManifest).toEqual({ added: ['people/new.md'], modified: [], deleted: ['people/old.md'], renamed: [] });
      expect(delta).toEqual({ status: 'ok', manifest: {
        added: ['people/new.md'], modified: [], deleted: ['people/old.md'], renamed: [],
      } });
      const retained = await engine.executeRaw<{ id: number; deleted_at: string | null }>('SELECT id,deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [source, 'people/old']);
      expect(retained[0].id).toBe(old.id);
      expect(retained[0].deleted_at).not.toBeNull();
      expect(await engine.executeRaw('SELECT entity_slug FROM facts WHERE source_id=$1', [source])).toEqual([{ entity_slug: 'people/old' }]);
      expect(await engine.executeRaw('SELECT page_id FROM timeline_entries WHERE page_id=ANY($1::bigint[])', [[old.id, bob.id]])).toEqual([{ page_id: old.id }]);
      expect(await engine.executeRaw('SELECT from_page_id FROM links WHERE from_page_id=ANY($1::bigint[])', [[old.id, bob.id]])).toEqual([{ from_page_id: old.id }]);
      expect(await engine.executeRaw('SELECT slug FROM page_aliases WHERE source_id=$1 AND alias_norm=$2', [source, 'ali'])).toEqual([{ slug: 'people/old' }]);
      expect(await engine.executeRaw('SELECT canonical_slug FROM slug_aliases WHERE source_id=$1', [source])).toEqual([]);
      expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [source]))[0].last_commit).toBe(head);
      expect((await sync()).status).toBe('up_to_date');
      expect((await engine.getPage('people/new', { sourceId: source }))!.id).toBe(bob.id);
    });
  }, 120_000);
});
