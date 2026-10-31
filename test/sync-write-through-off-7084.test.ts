/**
 * #7084 / #8118: with `sync.write_through` off, managed sync keeps its canonical correction of a file (the frontmatter and
 * tags the page keeps when an upstream edit drops them) in the database and never rewrites the checkout, the same as a
 * read-only mirror (#5409). With it on, the correction is still written back. #8118's shape: the `default` source has no
 * local_path and falls back to `sync.repo_path`, the checkout of a read-only mirror source.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-7084-'));
const TYPED = '---\ntype: note\ntitle: Page\ntags: [alpha]\n---\n# Page\n\nBody.\n';
const BARE = '# Page\n\nBody, edited upstream.\n';
const LATER = '# Page\n\nBody, edited upstream again.\n';
let engine: PGLiteEngine;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commitPage(root: string, body: string, message: string): void {
  writeFileSync(join(root, 'notes', 'page.md'), body);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
}
async function claimedSource(): Promise<{ sourceId: string; root: string }> {
  const sourceId = `w${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  commitPage(root, TYPED, 'typed page');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root };
}
const sync = (sourceId: string) => performManagedSync(engine, { sourceId, noPull: true, noEmbed: true, noExtract: true });
async function storedPage(sourceId: string) {
  const [row] = await engine.executeRaw<{ title: string; compiled_truth: string; tags: string[] }>(
    `SELECT p.title, p.compiled_truth, ARRAY(SELECT t.tag FROM tags t WHERE t.page_id=p.id ORDER BY t.tag) AS tags
       FROM pages p WHERE p.source_id=$1 AND p.slug='notes/page' AND p.deleted_at IS NULL`, [sourceId]);
  return row;
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

// Value: protects=sync.write_through=false keeps managed sync's canonical correction out of the checkout (#7084);
// fails_when=prepareSyncMutation attaches the canonical file write without reading sync.write_through;
// why_new=the existing write-back tests run with write_through on and the mirror tests set mirror_read_only;
// seam=performManagedSync on a claimed PGLite source; no_claim=Postgres engine, legacy (unmanaged) sync.
test('write_through off: an upstream edit that drops frontmatter syncs without rewriting the checkout; a later edit syncs too', async () =>
  withEnv({ GBRAIN_HOME: home }, async () => {
    const { sourceId, root } = await claimedSource();
    expect((await sync(sourceId)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    try {
      commitPage(root, BARE, 'drop frontmatter');
      expect((await sync(sourceId)).status).toBe('synced');
      expect(readFileSync(join(root, 'notes', 'page.md'), 'utf8')).toBe(BARE);
      expect(git(root, 'status', '--porcelain')).toBe('');
      expect(await storedPage(sourceId)).toMatchObject({ title: 'Page', tags: ['alpha'] });
      expect((await storedPage(sourceId)).compiled_truth).toContain('edited upstream.');

      commitPage(root, LATER, 'edit again');
      const next = await sync(sourceId);
      expect(next.status).toBe('synced');
      expect(next.held_count ?? 0).toBe(0);
      expect((await storedPage(sourceId)).compiled_truth).toContain('edited upstream again.');
      expect(git(root, 'status', '--porcelain')).toBe('');
    } finally {
      await engine.setConfig('sync.write_through', 'true');
    }
  }), 120_000);

test('write_through on: the same upstream edit still gets its canonical correction written back', async () =>
  withEnv({ GBRAIN_HOME: home }, async () => {
    const { sourceId, root } = await claimedSource();
    expect((await sync(sourceId)).status).toBe('first_sync');
    commitPage(root, BARE, 'drop frontmatter');
    expect((await sync(sourceId)).status).toBe('synced');
    const file = readFileSync(join(root, 'notes', 'page.md'), 'utf8');
    expect(file).toContain('title: Page');
    expect(file).toContain('alpha');
    expect(git(root, 'status', '--porcelain')).toBe('M notes/page.md');
  }), 120_000);

// Value: protects=a read-only mirror's checkout stays clean when the default source re-syncs it through sync.repo_path (#8118);
// fails_when=the default source's managed sync writes its canonical correction into the shared checkout with write_through off;
// why_new=the mirror tests only sync the mirror source itself; seam=performManagedSync of 'default' over a mirror's checkout;
// no_claim=write_through on, where a non-mirror source sharing a mirror's tree is still a doctor default_source_local_path warning.
test('#8118: the default source falling back to a read-only mirror checkout never rewrites it with write_through off', async () =>
  withEnv({ GBRAIN_HOME: home }, async () => {
    const root = join(home, 'shared-checkout');
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    commitPage(root, TYPED, 'typed page');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await engine.executeRaw("UPDATE sources SET local_path=NULL, config=config||'{\"federated\":true}'::jsonb WHERE id='default'");
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('mirror-a','mirror-a',$1,'{\"mirror_read_only\":true}')", [root]);
    await engine.setConfig('sync.repo_path', root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await sync('default')).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    try {
      commitPage(root, BARE, 'drop frontmatter');
      expect((await sync('default')).status).toBe('synced');
      expect(readFileSync(join(root, 'notes', 'page.md'), 'utf8')).toBe(BARE);
      expect(git(root, 'status', '--porcelain')).toBe('');
    } finally {
      await engine.setConfig('sync.write_through', 'true');
    }
  }), 120_000);
