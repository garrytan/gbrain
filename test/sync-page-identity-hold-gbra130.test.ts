/**
 * GBRA-130 A-17/B-3/B-4 (#6712 PR 4b): a managed sync pass that could not decide which page one file is stopped the whole
 * source. Several tombstones recording the file's origin (#6517, A-17), two spellings another platform folds into one
 * file (B-3), or a file whose frontmatter id differs from the page holding its slug (#6729, B-4) each threw
 * page_identity_changed out of the pass, so every other file in the source waited behind it on every later sync.
 *
 * Protects (red before: the sync rejects page_identity_changed and notes/other.md never imports): the file alone is held
 * page_identity_changed with meta.reason several_tombstones / spelling / identity_differs, needs a person
 * (sync status page_identity_decision), nothing is imported, revived or deleted at its slug, the unrelated file imports,
 * and a later sync holds it again without stopping. A dry run still refuses the source, as discovery does. A remote pass
 * (which writes no hold) leaves the paths alone, imports the unrelated file, and the next owner pass holds them. Runs on
 * PGLite and, with DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, front = '') => `---\ntype: concept\ntitle: ${title}\n${front}---\n\nThe body of ${title}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/seed.md'), note('notes/seed'));
  writeFileSync(join(root, 'notes/Kept Doc.md'), note('Kept doc', 'id: kept-one\n'));
  commit(root, 'seed');
};
const rows = (engine: BrainEngine, slug: string) => engine.executeRaw<{ id: number; deleted_at: string | null; compiled_truth: string; source_path: string | null }>(
  "SELECT id, deleted_at, compiled_truth, source_path FROM pages WHERE source_id='default' AND slug=$1 ORDER BY id", [slug]);
const requests = async (engine: BrainEngine) => (await engine.executeRaw<{ path: string }>(
  "SELECT intent->>'path' AS path FROM persistence_requests WHERE source_id='default' AND intent->>'path' IS NOT NULL ORDER BY sequence")).map(row => row.path);
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!.incarnation;

type Reason = 'several_tombstones' | 'spelling' | 'identity_differs';
/** Commits one undecidable case beside the unrelated notes/other.md; returns its paths and the no-takeover / no-guess checks. */
const ARRANGE: Record<Reason, (engine: BrainEngine, root: string) => Promise<{ paths: string[]; unchanged: () => Promise<void> }>> = {
  several_tombstones: async (engine, root) => {
    for (const slug of ['archive/twin-one', 'archive/twin-two']) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `Deleted ${slug}.`, timeline: '', frontmatter: {}, content_hash: `h-${slug}` }, { sourceId: 'default' });
      await tx.executeRaw("UPDATE pages SET source_path='notes/twin.md', deleted_at=now() WHERE source_id='default' AND slug=$1", [slug]);
    }, TEST_WRITE_ATTRIBUTION));
    writeFileSync(join(root, 'notes/twin.md'), note('notes/twin'));
    writeFileSync(join(root, 'notes/other.md'), note('notes/other'));
    commit(root, 'twin and other');
    return { paths: ['notes/twin.md'], unchanged: async () => {
      expect(await rows(engine, 'notes/twin')).toEqual([]);
      for (const slug of ['archive/twin-one', 'archive/twin-two']) expect((await rows(engine, slug))[0]?.deleted_at).not.toBeNull();
    } };
  },
  spelling: async (engine, root) => {
    writeFileSync(join(root, 'notes/Case.md'), note('Upper'));
    writeFileSync(join(root, 'notes/case.md'), note('Lower'));
    writeFileSync(join(root, 'notes/other.md'), note('notes/other'));
    commit(root, 'two spellings and other');
    return { paths: ['notes/Case.md', 'notes/case.md'], unchanged: async () => expect(await rows(engine, 'notes/case')).toEqual([]) };
  },
  identity_differs: async (engine, root) => {
    const [kept] = await rows(engine, 'notes/kept-doc');
    expect(kept).toMatchObject({ source_path: 'notes/Kept Doc.md', deleted_at: null });
    git(root, 'rm', '-q', 'notes/Kept Doc.md');
    writeFileSync(join(root, 'notes/kept-doc.md'), note('Another document', 'id: kept-two\n'));
    writeFileSync(join(root, 'notes/other.md'), note('notes/other'));
    commit(root, 'replace kept with another document');
    return { paths: ['notes/kept-doc.md'], unchanged: async () => expect(await rows(engine, 'notes/kept-doc')).toEqual([kept]) };
  },
};
const TITLES: Record<Reason, string> = {
  several_tombstones: 'a file two deleted pages record',
  spelling: 'each of two files differing only by case',
  identity_differs: 'a file whose id differs from the page at its slug',
};
async function remoteCtx(engine: BrainEngine): Promise<OperationContext> {
  const clientId = `sync-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations) VALUES($1,'example-client','test-only','admin','default',ARRAY['submit_job'])`, [clientId]);
  return { engine, remote: true, sourceId: 'default', auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: 'default', allowedOperations: ['submit_job'] } } as unknown as OperationContext;
}
const sourceHolds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).map(hold => [hold.path, hold.code, hold.meta.reason ?? null]);

for (const backend of testBackends()) describe(`[${backend}] GBRA-130 A-17/B-3/B-4: one file whose page identity is undecidable`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  async function heldAlone(engine: BrainEngine, root: string, paths: string[], reason: string) {
    const before = await requests(engine);
    // A dry run keeps discovery's refusal (it reads the source as a company plan does), and writes nothing.
    await expect(performManagedSync(engine, { ...OPTS, dryRun: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
    expect(await requests(engine)).toEqual(before);
    const first = await performManagedSync(engine, OPTS);
    expect(first.status).toBe('synced');
    expect(first.held?.map(hold => [hold.path, hold.code, hold.reason]).sort()).toEqual(paths.map(path => [path, 'page_identity_changed', reason]).sort());
    expect((await requests(engine)).filter(path => !before.includes(path))).toEqual(['notes/other.md']);
    expect(await rows(engine, 'notes/other')).toMatchObject([{ deleted_at: null }]);
    for (const path of paths) expect(await readGitHold(engine, 'default', await incarnation(engine), path)).toMatchObject({ code: 'page_identity_changed', meta: { reason } });
    const status = await readSyncStatus(engine, 'default', { detail: false });
    for (const path of paths) expect(status.holds.find(hold => hold.path === path)).toMatchObject({ code: 'page_identity_changed', needs_human: true, safe_actions: ['none'] });
    expect(status.needs_human).toBe(true);
    // A later sync re-screens the held paths (holdRescreenDue) and holds them again, and is not stopped by them.
    writeFileSync(join(root, 'notes/later.md'), note('notes/later'));
    commit(root, 'later');
    const again = await performManagedSync(engine, OPTS);
    expect(again).toMatchObject({ status: 'synced', holds_outstanding: paths.length });
    for (const path of paths) expect(await readGitHold(engine, 'default', await incarnation(engine), path)).toMatchObject({ code: 'page_identity_changed', meta: { reason } });
    expect(await rows(engine, 'notes/later')).toMatchObject([{ deleted_at: null }]);
  }

  for (const reason of Object.keys(ARRANGE) as Reason[]) {
    test(`${reason}: ${TITLES[reason]} is held alone, nothing is imported, revived or taken over, the rest imports`, () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const { paths, unchanged } = await ARRANGE[reason](engine, root);
      await heldAlone(engine, root, paths, reason);
      await unchanged();
    }, { databaseUrl, setup }), 240_000);

    // A remote pass writes no hold (the owner's pass does): it leaves the paths alone, importing, deleting and holding
    // nothing there, while the unrelated file it may sync imports; the next owner pass holds each path with its reason.
    test(`${reason} under remote authority: no hold, no write at the paths, the rest imports; the owner pass then holds them`, () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const { paths, unchanged } = await ARRANGE[reason](engine, root);
      const before = await requests(engine);
      const accepted = await prepareRemoteJob(await remoteCtx(engine), 'sync', { noPull: true });
      const remote = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data, noEmbed: true, noExtract: true }));
      expect(remote.reason).toBe('reconcile_host_required');
      expect(await sourceHolds(engine)).toEqual([]);
      expect((await requests(engine)).filter(path => !before.includes(path))).toEqual(['notes/other.md']);
      expect(await rows(engine, 'notes/other')).toMatchObject([{ deleted_at: null }]);
      await unchanged();
      const owner = await performManagedSync(engine, OPTS);
      expect(owner.status).toBe('synced');
      expect((await sourceHolds(engine)).sort()).toEqual(paths.map(path => [path, 'page_identity_changed', reason]).sort());
      expect((await requests(engine)).filter(path => !before.includes(path))).toEqual(['notes/other.md']);
      await unchanged();
    }, { databaseUrl, setup }), 240_000);
  }
});
