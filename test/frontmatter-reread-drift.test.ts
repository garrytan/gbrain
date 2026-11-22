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
 *
 * That waiver needs proof that the older release stored the page from that baseline: the page's import record names the
 * old importer (import=1), the proof provenLegacyCarry uses. Without it a database edit to the old-typed form of a value
 * (code: '007' changed to 7) would look unchanged and be overwritten, so a page today's importer stored, or a page with
 * no import record, stays held. The record-less case differs from master on purpose and fails safe: the hold names its
 * repair and nothing is lost.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { gitHoldFix, readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { onlyDerivedKeysAdded } from '../src/core/persistence/sync-screen.ts';
import { contentHash } from '../src/core/utils.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const PLAIN = 'notes/a';
const TYPED = 'people/d';
const CODED = 'people/c';
const plain = (slug: string) => `---\ntype: concept\ntitle: ${slug}\ntags: [alpha, beta]\n---\n\nThe committed body of ${slug}, about acme-example.\n`;
const typed = (slug: string) => `---\ntype: person\ntitle: ${slug}\nborn: 1990-05-01\n---\n\nThe committed body of ${slug}.\n`;
const coded = (slug: string) => `---\ntype: person\ntitle: ${slug}\ncode: 007\n---\n\nThe committed body of ${slug}.\n`;
const file = (slug: string) => (slug === TYPED ? typed(slug) : slug === CODED ? coded(slug) : plain(slug));
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); mkdirSync(join(root, 'people'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of [PLAIN, TYPED, CODED]) writeFileSync(join(root, `${slug}.md`), file(slug));
  commit(root, 'notes');
};
const snapshotOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;

/**
 * What an older gbrain left: the old typing of the typed page's values, its import record naming the older parser at the
 * page's revision, and an older parser fingerprint. `oldHash` also stores the content hash the older release computed
 * over that typing (a real older brain); without it the row keeps today's hash, as Minder's repro seeds it.
 */
async function seedOlderRelease(engine: BrainEngine, oldHash = false): Promise<void> {
  await withManagedFixtureWrite(engine, ['default'], async tx => {
    const [row] = await tx.executeRaw<{ frontmatter: Record<string, unknown>; type: string; title: string; compiled_truth: string; timeline: string | null }>(
      'SELECT frontmatter, type, title, compiled_truth, timeline FROM pages WHERE slug=$1', [TYPED]);
    const frontmatter = { ...row!.frontmatter, ...legacyTypedFrontmatter(typed(TYPED)) };
    const hash = contentHash({ title: row!.title, type: row!.type as never, compiled_truth: row!.compiled_truth, timeline: row!.timeline ?? '', frontmatter, tags: [] });
    await tx.executeRaw(`UPDATE pages SET frontmatter=$1::text::jsonb${oldHash ? ', content_hash=$3' : ''} WHERE slug=$2`, [JSON.stringify(frontmatter), TYPED, ...(oldHash ? [hash] : [])]);
  });
  const snapshot = await snapshotOf(engine, TYPED);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
    [SYNC_IMPORT_PROVENANCE_OP, snapshot.revision, String(snapshot.page.id)]);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"import=1;frontmatter=1;fence=1"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
}

const holdsOf = async (engine: BrainEngine) => (await readGitSourceHolds(engine, { sourceIds: ['default'] })).flatMap(entry => entry.holds.map(hold => `${hold.path}: ${hold.code}`)).sort();

/** Edits the body of `slug` in Git and syncs; the page must stay held as file_drift with its database value kept. */
async function editIsHeld(engine: BrainEngine, root: string, slug: string, kept: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, `${slug}.md`), `${file(slug)}\nAn added line.\n`);
  commit(root, 'edit');
  await performManagedSync(engine, { sourceId: 'default', noPull: true });
  expect(await holdsOf(engine)).toEqual([`${slug}.md: file_drift`]);
  const page = (await engine.getPage(slug))!;
  expect(page.frontmatter).toMatchObject(kept);
  expect(page.compiled_truth).not.toContain('An added line.');
}

async function editsImportCleanly(engine: BrainEngine, root: string): Promise<void> {
  for (const slug of [PLAIN, TYPED]) writeFileSync(join(root, `${slug}.md`), `${file(slug)}\nAn added line.\n`);
  commit(root, 'edit');
  const result = await performManagedSync(engine, { sourceId: 'default', noPull: true });
  expect(await holdsOf(engine)).toEqual([]);
  expect(result.status).toBe('synced');
  for (const slug of [PLAIN, TYPED]) expect((await engine.getPage(slug))!.compiled_truth).toContain('An added line.');
  // The import stores the file's text, so the older page's date now reads as written.
  expect((await engine.getPage(TYPED))!.frontmatter).toMatchObject({ born: '1990-05-01' });
}

describe('pages-03: a git edit to an older page with typed frontmatter is not held as file drift', () => {
  test('(iii) an old-importer record waives the hold after a database-only change (drift both, the repro\'s seed)', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    await seedOlderRelease(engine);
    expect((await engine.getPage(TYPED))!.frontmatter).toMatchObject({ born: '1990-05-01T00:00:00.000Z' });
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      for (const slug of [PLAIN, TYPED]) await tx.addTag(slug, 'gamma', { sourceId: 'default' });
    });
    await editsImportCleanly(engine, root);
  }, { setup }), 240_000);

  test('after a database-only change, with the content hash the older release stored (drift both)', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    await seedOlderRelease(engine, true);
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      for (const slug of [PLAIN, TYPED]) await tx.addTag(slug, 'gamma', { sourceId: 'default' });
    });
    await editsImportCleanly(engine, root);
  }, { setup }), 240_000);

  test('(ii) an old-importer record the page moved past with a real database change stays held', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    await seedOlderRelease(engine);
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      const [row] = await tx.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE slug=$1', [TYPED]);
      await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug=$2', [JSON.stringify({ ...row!.frontmatter, born: '1990-06-01T00:00:00.000Z' }), TYPED]);
      await tx.addTag(TYPED, 'gamma', { sourceId: 'default' });
    });
    await editIsHeld(engine, root, TYPED, { born: '1990-06-01T00:00:00.000Z' });
  }, { setup }), 240_000);

  test('(i) a record from today\'s importer and a database edit to the old-typed form of a value (007 to 7) stays held', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    expect((await engine.getPage(CODED))!.frontmatter).toMatchObject({ code: '007' });
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      const [row] = await tx.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE slug=$1', [CODED]);
      await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug=$2', [JSON.stringify({ ...row!.frontmatter, code: 7 }), CODED]);
      await tx.addTag(CODED, 'gamma', { sourceId: 'default' });
    });
    await editIsHeld(engine, root, CODED, { code: 7 });
  }, { setup }), 240_000);

  // (iv) The repro's FE_SIDE=unknown shape: with no import record nothing proves the older release stored the page, so the
  // edit stays held on purpose (a difference from master that fails safe), not a clean import.
  test('(iv) an older page with no import record stays held (drift unknown)', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    await seedOlderRelease(engine);
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_IMPORT_PROVENANCE_OP]);
    await editIsHeld(engine, root, TYPED, { born: '1990-05-01T00:00:00.000Z' });
  }, { setup }), 240_000);
});

describe('pages-03: onlyDerivedKeysAdded reads a value the old parser typed as stored only with proof', () => {
  const stored = { born: '1990-05-01T00:00:00.000Z', zip: 2134, version: 1.1, title: 'people/d', type: 'person' };
  const content = (extra = '') => `---\ntype: person\ntitle: people/d\nborn: 1990-05-01\nzip: 02134\nversion: 1.10\n${extra}---\n\nBody.\n`;
  test('with proof the older release stored the page, a file whose values differ only by the old typing adds no keys', () => {
    expect(onlyDerivedKeysAdded(content(), stored, true)).toBe(true);
  });
  test('without that proof the file is compared as written', () => {
    expect(onlyDerivedKeysAdded(content(), stored)).toBe(false);
  });
  test('a real change is still a difference', () => {
    expect(onlyDerivedKeysAdded(content().replace('born: 1990-05-01', 'born: 1990-05-02'), stored, true)).toBe(false);
    expect(onlyDerivedKeysAdded(content('label: new\n'), stored, true)).toBe(false);
  });
});

describe('pages-03: the repair text of a record-less file_drift hold names the older-release typing case', () => {
  const fix = (meta: Record<string, unknown>) => gitHoldFix({ source_id: 'source-a', path: 'people/d.md', slug: 'people/d', code: 'file_drift', meta } as Parameters<typeof gitHoldFix>[0]).why;
  test('it says plainly that this is the older-release typing case and names the one-pass command that imports the file versions', () => {
    const why = fix({ sides: 'unknown', side: 'unknown' });
    expect(why).toContain('older-release typing case');
    expect(why).toContain('gbrain repair file-drift --source source-a --held --side unknown --prefer file --whole-class');
  });
  test('a hold whose database side changed since a recorded import does not claim the typing case', () => {
    expect(fix({ sides: 'both', side: 'both', page_revision: 'r2' })).not.toContain('older-release typing case');
  });
});
