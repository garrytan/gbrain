/**
 * #6712 PR 4b lane A: the proof-carrying confirm round (sync-pass-confirm.ts). A pass's round after the first reuses the
 * previous round's `I⋈P` and re-reads only the pages the pass wrote, when the database proves nothing else changed; any
 * change it cannot attribute to the pass takes the whole read. Each probe forces the change between round 1 and round 2
 * (the `sync:round_start` seam) and reads each round's verdict at `sync:level_read`.
 *
 * Protects:
 * - the clean case: round 2 reuses `I⋈P` and re-reads only the written pages (one changed file, one new file).
 * - a foreign page write over a pass import between rounds takes the whole read, and the page is not held (a stale reuse
 *   classifies the import again and holds it concurrent_write).
 * - another writer moving HEAD between rounds takes the whole read, and the pass imports the new commit.
 * - a foreign deletion of a hold between rounds takes the whole read.
 * - #6887 through the confirm round: a both-moved path held file_drift in round 1 stays held in a reused round 2, and a path
 *   that moves on both sides between rounds is held file_drift (a stale reuse holds it concurrent_write), the edit kept.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-confirm-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readGitHold, SYNC_IMPORT_PROVENANCE_OP, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
const edit = (root: string, slug: string, body: string) => writeFileSync(join(root, `${slug}.md`), note(slug, body));
const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'"))[0]!.incarnation;
const bodyOf = async (engine: BrainEngine, slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '';
/** A database-only edit of `slug` (write-through off), committed before it returns. */
async function dbEdit(engine: BrainEngine, ctx: OperationContext, slug: string, body: string): Promise<void> {
  await engine.setConfig('sync.write_through', 'false');
  const requestId = randomUUID();
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId,
    expected_revision: (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision, content: note(slug, body) } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
    { timeoutMs: 30_000, label: `the database-only edit of ${slug} commits` });
  await engine.setConfig('sync.write_through', 'true');
}
type Verdict = { round: number; confirm: { taken: boolean; reason: string | null; rows: number; narrow?: string } | null };
/** One sync with `between` run before round 2 reads its level; the rounds' confirm verdicts and the result. */
async function pass(engine: BrainEngine, between: () => Promise<void> = async () => {}) {
  const verdicts: Verdict[] = [];
  let ran = false;
  installFaultHook(async (point, detail) => {
    if (point === 'sync:round_start' && detail.round === 2 && !ran) { ran = true; await between(); }
    if (point === 'sync:level_read') verdicts.push({ round: detail.round!, confirm: detail.level?.confirm ?? null });
  });
  try {
    // These are one pass's own rounds: round 1 reads whole, as in a new process (GBRA-133 cross-pass reuse is test/sync-level-reuse-across-gbra133.test.ts).
    __resetTreeReuseForTests();
    const result = await performManagedSync(engine, OPTS);
    return { status: result.status, held: (result.held ?? []).map(hold => [hold.path, hold.code]), verdicts };
  } finally { installFaultHook(undefined); }
}
const round2 = (run: { verdicts: Verdict[] }) => run.verdicts.find(verdict => verdict.round === 2)?.confirm;

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b confirm round (${backend})`, () => {
    test('clean case: round 2 reuses I⋈P and re-reads only the pages the pass wrote', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const changed = await pass(engine);
      expect({ status: changed.status, held: changed.held }).toEqual({ status: 'synced', held: [] });
      expect(changed.verdicts[0]).toEqual({ round: 1, confirm: null });
      expect(round2(changed)).toEqual({ taken: true, reason: null, rows: 1, narrow: 'taken' });
      expect(await bodyOf(engine, 'notes/a')).toContain('A committed change of notes/a.');
      edit(root, 'notes/d', 'A new file.'); commit(root, 'add d');
      const added = await pass(engine);
      expect({ status: added.status, confirm: round2(added) }).toEqual({ status: 'synced', confirm: { taken: true, reason: null, rows: 1, narrow: 'taken' } });
      expect(await bodyOf(engine, 'notes/d')).toContain('A new file.');
      expect((await performManagedSync(engine, OPTS)).pass).toBeUndefined();
    }), 180_000);

    test('a foreign page write over a pass import between rounds takes the whole read, and the page is not held', () => brain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      edit(root, 'notes/a', 'A committed change of notes/a.'); edit(root, 'notes/b', 'A committed change of notes/b.'); commit(root, 'change a and b');
      const run = await pass(engine, () => dbEdit(engine, ctx, 'notes/b', 'DBONLYMARKER written after the import.'));
      // The database moved after the file was imported (the file is unchanged since): nothing to import, nothing to hold.
      expect({ status: run.status, held: run.held }).toEqual({ status: 'synced', held: [] });
      expect(round2(run)).toEqual({ taken: false, reason: 'foreign_page_write', rows: 0 });
      expect(await bodyOf(engine, 'notes/b')).toContain('DBONLYMARKER written after the import.');
      expect(await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/b.md')).toBeNull();
    }), 180_000);

    test('another writer moving HEAD between rounds takes the whole read, and the pass imports the new commit', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const run = await pass(engine, async () => { edit(root, 'notes/b', 'A commit landing mid-pass.'); commit(root, 'change b mid-pass'); });
      expect(round2(run)).toEqual({ taken: false, reason: 'key', rows: 0 });
      expect({ status: run.status, held: run.held }).toEqual({ status: 'synced', held: [] });
      expect(await bodyOf(engine, 'notes/b')).toContain('A commit landing mid-pass.');
      expect((await performManagedSync(engine, OPTS)).pass).toBeUndefined();
    }), 180_000);

    test('a foreign deletion of a hold between rounds takes the whole read', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const incarnation = await incarnationOf(engine);
      const page = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/c.md', source_path: 'notes/c.md', slug: 'notes/c', page_id: Number(page.page.id),
        code: 'file_drift', message: 'Synthetic file_drift hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { recovery_version: RECOVERY_VERSION, blob_oid: git(root, 'rev-parse', 'HEAD:notes/c.md'), page_revision: page.revision } } as never));
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const run = await pass(engine, async () => { await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-hold' AND fingerprint=$1", [`default:${incarnation}:notes/c.md`]); });
      expect(round2(run)).toEqual({ taken: false, reason: 'holds', rows: 0 });
      expect(run.status).toBe('synced');
      expect(await readGitHold(engine, 'default', incarnation, 'notes/c.md')).toBeNull();
    }), 180_000);

    test('#6887 through the confirm round: a both-moved path held in round 1 stays held file_drift in the reused round 2', () => brain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await dbEdit(engine, ctx, 'notes/b', 'DBONLYMARKER the agent edit.');
      const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='notes/b'");
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_IMPORT_PROVENANCE_OP, `default:${await incarnationOf(engine)}:${page!.id}`]);
      edit(root, 'notes/a', 'A committed change of notes/a.'); edit(root, 'notes/b', 'The second committed body.'); commit(root, 'change a and b');
      const run = await pass(engine);
      expect(round2(run)).toEqual({ taken: true, reason: null, rows: 1, narrow: 'taken' });
      expect({ status: run.status, held: run.held }).toEqual({ status: 'synced', held: [['notes/b.md', 'file_drift']] });
      expect(await bodyOf(engine, 'notes/b')).toContain('DBONLYMARKER the agent edit.');
      expect(readFileSync(join(root, 'notes/b.md'), 'utf8')).toContain('The second committed body.');
      expect((await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/b.md'))?.code).toBe('file_drift');
    }), 180_000);

    test('#6887 through the confirm round: a path that moves on both sides between rounds is held file_drift, the edit kept', () => brain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const run = await pass(engine, async () => {
        await dbEdit(engine, ctx, 'notes/b', 'DBONLYMARKER a mid-pass edit.');
        edit(root, 'notes/b', 'A committed change of notes/b mid-pass.'); commit(root, 'change b mid-pass');
      });
      expect({ status: run.status, held: run.held }).toEqual({ status: 'synced', held: [['notes/b.md', 'file_drift']] });
      expect(round2(run)?.taken).toBe(false);
      expect(await bodyOf(engine, 'notes/b')).toContain('DBONLYMARKER a mid-pass edit.');
      expect((await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/b.md'))?.code).toBe('file_drift');
    }), 180_000);
  });
}
