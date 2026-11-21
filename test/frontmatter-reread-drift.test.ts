/**
 * pages-03: after the upgrade, a git edit to an older page whose frontmatter the old parser typed (a bare date stored as
 * an ISO timestamp) imports cleanly, as it does on master, also when the page's row changed in the database since its
 * last import (a database-only tag: drift `both`) or the page has no import record (drift `unknown`).
 *
 * The drift gate (sync-run.ts) lets such an import through only when the page still holds what the file's baseline (its
 * last imported version) imports. Today's parser reads that baseline's `born: 1990-05-01` as the text, the older release
 * stored `1990-05-01T00:00:00.000Z`, so the comparison must read the baseline under the old typing too
 * (legacyStoredFrontmatter), or every such edit is held as file_drift and the suggested `--prefer database` repair would
 * overwrite the user's edit.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { onlyDerivedKeysAdded } from '../src/core/persistence/sync-screen.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const PLAIN = 'notes/a';
const TYPED = 'people/d';
const plain = (slug: string) => `---\ntype: concept\ntitle: ${slug}\ntags: [alpha, beta]\n---\n\nThe committed body of ${slug}, about acme-example.\n`;
const typed = (slug: string) => `---\ntype: person\ntitle: ${slug}\nborn: 1990-05-01\n---\n\nThe committed body of ${slug}.\n`;
const file = (slug: string) => (slug === TYPED ? typed(slug) : plain(slug));
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); mkdirSync(join(root, 'people'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of [PLAIN, TYPED]) writeFileSync(join(root, `${slug}.md`), file(slug));
  commit(root, 'notes');
};
const snapshotOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;

/** What an older gbrain left: the old typing of the typed page's values, its import record naming the older parser at the page's revision, and an older parser fingerprint. */
async function seedOlderRelease(engine: BrainEngine): Promise<void> {
  await withManagedFixtureWrite(engine, ['default'], async tx => {
    const [row] = await tx.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE slug=$1', [TYPED]);
    await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug=$2', [JSON.stringify({ ...row!.frontmatter, ...legacyTypedFrontmatter(typed(TYPED)) }), TYPED]);
  });
  const snapshot = await snapshotOf(engine, TYPED);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
    [SYNC_IMPORT_PROVENANCE_OP, snapshot.revision, String(snapshot.page.id)]);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"import=1;frontmatter=1;fence=1"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
}

async function editsImportCleanly(engine: BrainEngine, root: string): Promise<void> {
  for (const slug of [PLAIN, TYPED]) writeFileSync(join(root, `${slug}.md`), `${file(slug)}\nAn added line.\n`);
  commit(root, 'edit');
  const result = await performManagedSync(engine, { sourceId: 'default', noPull: true });
  const holds = (await readGitSourceHolds(engine, { sourceIds: ['default'] })).flatMap(entry => entry.holds.map(hold => `${hold.path}: ${hold.code}`));
  expect(holds).toEqual([]);
  expect(result.status).toBe('synced');
  for (const slug of [PLAIN, TYPED]) expect((await engine.getPage(slug))!.compiled_truth).toContain('An added line.');
  // The import stores the file's text, so the older page's date now reads as written.
  expect((await engine.getPage(TYPED))!.frontmatter).toMatchObject({ born: '1990-05-01' });
}

describe('pages-03: a git edit to an older page with typed frontmatter is not held as file drift', () => {
  test('after a database-only change since its last import (drift both)', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    await seedOlderRelease(engine);
    expect((await engine.getPage(TYPED))!.frontmatter).toMatchObject({ born: '1990-05-01T00:00:00.000Z' });
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      for (const slug of [PLAIN, TYPED]) await tx.addTag(slug, 'gamma', { sourceId: 'default' });
    });
    await editsImportCleanly(engine, root);
  }, { setup }), 240_000);

  test('with no import record (drift unknown)', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    await seedOlderRelease(engine);
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_IMPORT_PROVENANCE_OP]);
    await editsImportCleanly(engine, root);
  }, { setup }), 240_000);
});

describe('pages-03: onlyDerivedKeysAdded reads a value the old parser typed as stored', () => {
  const stored = { born: '1990-05-01T00:00:00.000Z', zip: 2134, version: 1.1, title: 'people/d', type: 'person' };
  const content = (extra = '') => `---\ntype: person\ntitle: people/d\nborn: 1990-05-01\nzip: 02134\nversion: 1.10\n${extra}---\n\nBody.\n`;
  test('a file whose values differ from the stored page only by the old typing adds no keys', () => {
    expect(onlyDerivedKeysAdded(content(), stored)).toBe(true);
  });
  test('a real change is still a difference', () => {
    expect(onlyDerivedKeysAdded(content().replace('born: 1990-05-01', 'born: 1990-05-02'), stored)).toBe(false);
    expect(onlyDerivedKeysAdded(content('label: new\n'), stored)).toBe(false);
  });
});
