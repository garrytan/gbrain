/**
 * pages-03: a page an older gbrain stored with the old typing keeps its identity across a case-only rename.
 *
 * 1. Protects: an older release read `id: 007` as the number 7, so the page row stores frontmatter id '7' while the file
 *    still says `id: 007` (read today as '007'). A case-only rename (notes/Item.md -> notes/item.md) maps to the same
 *    slug, so the file takes over the page; that takeover (the managed pass's, and discovery's assertTakeoverIdentity)
 *    must see the same document (the old typing of the file's id is the stored id) and import the rename, storing the id
 *    as written ('007'). A file whose id is really different (`id: 008`, or a quoted `id: "007"`, against the stored 7)
 *    is still refused (page_identity_changed) and the page keeps its id.
 * 2. Fails when: the takeover identity check compares only today's reading of the file's id with the stored id, so the
 *    first sync after the upgrade holds an unchanged page's rename; or when it accepts an id the old typing did not
 *    read as the stored one.
 * 3. Runs on PGLite (the managed-brain fixture). No embedding, no model calls.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { explicitIdVeto, fileIdAgainstStored } from '../src/core/sync-rename-identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const OPTS = { sourceId: 'default', noPull: true };
const ITEM = (id: string) => `---\ntitle: Item\ntype: note\nid: ${id}\n---\n# Item\n\nBody text.\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/Item.md'), ITEM('007'));
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore', 'notes/Item.md']);
};
const storedId = async (engine: BrainEngine) => (await engine.executeRaw<{ fm_id: string | null }>(
  "SELECT frontmatter->>'id' AS fm_id FROM pages WHERE slug='notes/item' AND deleted_at IS NULL"))[0]?.fm_id;
const gitIn = (root: string) => (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args]);
/** The case-only rename, optionally replacing the file's id in the same commit. */
function caseRename(root: string, id?: string): void {
  const git = gitIn(root);
  git('mv', 'notes/Item.md', 'notes/item.md');
  if (id !== undefined) { writeFileSync(join(root, 'notes/item.md'), ITEM(id)); git('add', '-A'); }
  git('commit', '-qm', id === undefined ? 'case rename' : 'case rename to another document');
}
const refusalText = (outcome: unknown) => outcome instanceof Error ? `${(outcome as { code?: string }).code} ${outcome.message}` : JSON.stringify(outcome);

/**
 * First sync, then what an older gbrain left: `id: 007` stored as the number 7 (fm_id '7'), its import record naming the
 * revision it imported and its parser, so the next sync is the one-time re-read after the upgrade.
 */
async function storedByOlderGbrain(engine: BrainEngine): Promise<number> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw(
    "UPDATE pages SET frontmatter = frontmatter || '{\"id\":7}'::jsonb WHERE slug='notes/item'"));
  expect(await storedId(engine)).toBe('7');
  const snapshot = (await engine.readPageSnapshot('notes/item', { sourceId: 'default' }))!;
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
    [SYNC_IMPORT_PROVENANCE_OP, snapshot.revision, String(snapshot.page.id)]);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
  return snapshot.page.id;
}

describe('pages-03: a case-only rename of a page stored under the old typing', () => {
  test('the file id is read against the stored id: only the old typing of this very file matches', () => {
    expect(fileIdAgainstStored(ITEM('007'), '7')).toBe('7');
    expect(fileIdAgainstStored(ITEM('007'), '007')).toBe('007');
    expect(fileIdAgainstStored(ITEM('007'), null)).toBe('007');
    expect(fileIdAgainstStored(ITEM('1.10'), '1.1')).toBe('1.1');
    expect(fileIdAgainstStored(ITEM('008'), '7')).toBe('008');
    expect(fileIdAgainstStored(ITEM('"007"'), '7')).toBe('007'); // quoted: the old typing read the text '007' too
    expect(explicitIdVeto(fileIdAgainstStored(ITEM('007'), '7'), '7')).toBe(false);
    expect(explicitIdVeto(fileIdAgainstStored(ITEM('008'), '7'), '7')).toBe(true);
    expect(explicitIdVeto(fileIdAgainstStored(ITEM('"007"'), '7'), '7')).toBe(true);
  });

  test('sync: an unchanged id: 007 page stored as 7 is renamed, not held, and stores the id as written', () => managedBrain(async ({ engine, root }) => {
    const pageId = await storedByOlderGbrain(engine);
    caseRename(root);
    const result = await performManagedSync(engine, OPTS);
    expect(JSON.stringify(result)).not.toContain('page_identity_changed');
    expect(result.status).toBe('synced');
    expect(result.fileRefusals ?? []).toEqual([]);
    const after = (await engine.getPage('notes/item'))!;
    expect({ id: after.id, path: after.source_path }).toEqual({ id: pageId, path: 'notes/item.md' });
    expect(after.frontmatter.id).toBe('007');
  }, { setup }), 120_000);

  test('sync: a case-only rename whose id really differs (id: 008 against the stored 7) is still refused', () => managedBrain(async ({ engine, root }) => {
    const pageId = await storedByOlderGbrain(engine);
    caseRename(root, '008');
    let outcome: unknown;
    try { outcome = await performManagedSync(engine, OPTS); } catch (error) { outcome = error; }
    expect(refusalText(outcome)).toContain('page_identity_changed');
    const page = (await engine.getPage('notes/item'))!;
    expect({ id: page.id, fmId: await storedId(engine) }).toEqual({ id: pageId, fmId: '7' });
  }, { setup }), 120_000);

  test('discovery (assertTakeoverIdentity): the unchanged file takes over its page; a different id is refused', () => managedBrain(async ({ engine, root }) => {
    const pageId = await storedByOlderGbrain(engine);
    caseRename(root);
    const discovery = await discoverManagedSync(engine, { ...OPTS, dryRun: true });
    expect(discovery.entries.find(entry => entry.sourcePath === 'notes/item.md')).toMatchObject({ action: 'import', pageId, renameFrom: { sourcePath: 'notes/Item.md', pageId } });
    gitIn(root)('reset', '-q', '--hard', 'HEAD~1'); // a dry run wrote nothing: start from the old spelling again
    caseRename(root, '008');
    await expect(discoverManagedSync(engine, { ...OPTS, dryRun: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
  }, { setup }), 120_000);
});
