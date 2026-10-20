/**
 * #6712 PR 4b lane A: the pass checkpoint folded into the round's last import (#6926, folded into 4b; sync-pass-fold.ts),
 * and the confirm round's reuse of round 1's classification (sync-pass.ts `matchedUnchanged`).
 *
 * Protects:
 * - fold engages: a one-file commit whose file is already canonical (no writeback) publishes exactly one request carrying
 *   the stamp, its import, which folds it (`pass_stamp: folded`); no separate checkpoint request. A fold that quietly
 *   stops engaging costs this shape a second level and a checkpoint publication per commit (#6858 at 57 ms: 17.7 s -> 21.8 s).
 * - fold engages for a writeback (GBRA-108, option A): a one-file commit whose file is not canonical is rewritten by its
 *   import (`file_written`), which folds the stamp exactly once through its post-effects hook (sync-pass-fold.ts,
 *   coordinator.ts `afterEffects`), with no separate checkpoint request; the stamp records the import in
 *   `converged.writeback` (test/sync-pass-writeback-fold-6712.test.ts covers what that keeps busy).
 * - fold probe 1: the last import's publication fails after its folded stamp ran (`publication:before_commit`): the stamp
 *   rolls back with it, so the checkpoint and the pass row stay where they were, and later runs converge.
 * - fold probe 2: a hold at the target when the last import publishes: the import publishes alone (`pass_stamp_skipped`),
 *   the checkpoint has not moved when it commits, and the pass stamps by its checkpoint request as before.
 * - fold probe 3: a kill right after the folded import commits: the checkpoint and the pass row both name HEAD, the page
 *   carries HEAD's bytes, and the next run converges with no new request (no double import).
 * - reuse probes: open work names an unchanged `matched` path between rounds: round 2 confirms the level, reuses the other
 *   matched paths and classifies that one again. And a hold appears on an unchanged `matched` path between rounds: round 2 classifies that path again (held)
 *   instead of reusing round 1's verdict, so the hold stands and the pass reports it.
 *
 * - core guard: the fold wraps the managed-sync import's own publication (sync-prepare.ts, a core-guard exemption: owner Git
 *   edits) and writes no page text of its own. An always_load page that grows core past its budget publishes the same
 *   whether its import folds the stamp or not, while a guarded agent write of the same growth is refused.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-fold-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readGitHold, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { waitFor } from './helpers/wait-for.ts';
import { stampByCheckpoint } from './helpers/pass-fold.ts';
import { randomUUID } from 'node:crypto';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

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
const lastSequence = async (engine: BrainEngine) => Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
/** The commit checkpoint and the commit the pass row records as converged. */
async function checkpoint(engine: BrainEngine): Promise<{ last_commit: string | null; converged: string | null }> {
  const [source] = await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'");
  const [pass] = await engine.executeRaw<{ at: string | null }>("SELECT completed_keys->0->'obligations'->'converged'->>'target' AS at FROM op_checkpoints WHERE op='managed-sync-pass'");
  return { last_commit: source?.last_commit ?? null, converged: pass?.at ?? null };
}
/** Whether the request carries the pass stamp (its intent's `stamp`: a checkpoint request or the import that folds it). */
const carriesStamp = async (engine: BrainEngine, requestId: string) =>
  (await engine.executeRaw<{ stamp: boolean }>("SELECT intent ? 'stamp' AS stamp FROM persistence_requests WHERE request_id=$1::uuid", [requestId]))[0]?.stamp === true;
const outcomeOf = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw<{ state: string; stamp: string | null; skipped: string | null }>(
  "SELECT state, outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped FROM persistence_requests WHERE request_id=$1::uuid", [requestId]))[0];
/** Runs syncs until one converges (at most five); each run's status. */
async function settle(engine: BrainEngine): Promise<string[]> {
  const statuses: string[] = [];
  while (statuses.length < 5 && !['synced', 'up_to_date'].includes(statuses.at(-1) ?? '')) {
    statuses.push(await performManagedSync(engine, OPTS).then(result => result.status as string, (error: Error) => `threw: ${error.message}`));
  }
  return statuses;
}

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b folded pass checkpoint (${backend})`, () => {
    test('fold engages: a one-file commit of a canonical file folds the stamp into its import, with no checkpoint request', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const after = await lastSequence(engine);
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      const stamped = await engine.executeRaw<{ kind: string; slug: string | null; state: string; stamp: string | null; skipped: string | null }>(
        "SELECT intent->>'kind' AS kind, slug, state, outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped FROM persistence_requests WHERE sequence > $1 AND intent ? 'stamp' ORDER BY sequence", [after]);
      expect(stamped).toEqual([{ kind: 'managed_sync_import', slug: 'notes/a', state: 'committed', stamp: 'folded', skipped: null }]);
      const head = git(root, 'rev-parse', 'HEAD');
      expect(await checkpoint(engine)).toEqual({ last_commit: head, converged: head });
      expect(await bodyOf(engine, 'notes/a')).toContain('A committed change of notes/a.');
    }), 120_000);

    test('fold engages for a writeback: a one-file commit whose import rewrites its file folds exactly once, no separate stamp request', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const after = await lastSequence(engine);
      writeFileSync(join(root, 'notes/a.md'), '---\ntitle: notes/a\n---\nA committed change of notes/a.\n'); commit(root, 'change a, not canonical');
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      const stamped = await engine.executeRaw<Record<string, unknown>>(
        "SELECT intent->>'kind' AS kind, slug, state, intent->'stamp' ? 'fold' AS offered, outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped, outcome FROM persistence_requests WHERE sequence > $1 AND intent ? 'stamp' ORDER BY sequence", [after]);
      expect((stamped[0]?.outcome as { persistence?: { file_written?: boolean } } | undefined)?.persistence?.file_written).toBe(true);
      expect(stamped.map(({ outcome, ...row }) => row)).toEqual([
        { kind: 'managed_sync_import', slug: 'notes/a', state: 'committed', offered: true, stamp: 'folded', skipped: null }]);
      const head = git(root, 'rev-parse', 'HEAD');
      expect(await checkpoint(engine)).toEqual({ last_commit: head, converged: head });
      const [row] = await engine.executeRaw<{ request_id: string }>("SELECT id::text AS request_id FROM persistence_requests WHERE sequence > $1 AND intent->>'kind'='managed_sync_import'", [after]);
      const [pass] = await engine.executeRaw<{ writeback: string[] | null }>("SELECT completed_keys->0->'obligations'->'converged'->'writeback' AS writeback FROM op_checkpoints WHERE op='managed-sync-pass'");
      expect(pass!.writeback).toEqual([row!.request_id]);
    }), 120_000);

    test('fold probe 1: a failed publication of the last import rolls its folded stamp back; later runs converge', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const before = await checkpoint(engine), after = await lastSequence(engine);
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const stamped = new Set<string>();
      let failed = null as string | null, seen = null as Awaited<ReturnType<typeof checkpoint>> | null;
      installFaultHook(async (point, detail) => {
        // The publication transaction is open at `publication:before_commit`: the stamp is read before it, the checkpoint after it.
        if (point === 'consumer:prepared' && detail.requestId && await carriesStamp(engine, detail.requestId)) stamped.add(detail.requestId);
        if (point === 'publication:before_commit' && !failed && detail.requestId && stamped.has(detail.requestId)) {
          failed = detail.requestId;
          throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
        }
        if (failed && !seen && !point.startsWith('publication:')) seen = await checkpoint(engine);
      });
      const statuses = await settle(engine);
      installFaultHook(undefined);
      expect(failed).not.toBeNull();
      expect(seen).toEqual(before);
      expect(statuses.at(-1)).toMatch(/^(synced|up_to_date)$/);
      const head = git(root, 'rev-parse', 'HEAD');
      expect(await checkpoint(engine)).toEqual({ last_commit: head, converged: head });
      expect(await bodyOf(engine, 'notes/a')).toContain('A committed change of notes/a.');
      const imports = await engine.executeRaw<{ slug: string; n: number }>("SELECT slug, count(*)::int AS n FROM persistence_requests WHERE intent->>'kind'='managed_sync_import' AND state='committed' AND sequence>$1 GROUP BY slug", [after]);
      expect(imports.map(row => [row.slug, Number(row.n)])).toEqual([['notes/a', 1]]);
    }), 180_000);

    test('fold probe 2: a hold at the target keeps the stamp path; the last import publishes alone', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const before = await checkpoint(engine), incarnation = await incarnationOf(engine);
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const page = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
      let last = null as string | null, seen = null as Awaited<ReturnType<typeof checkpoint>> | null;
      installFaultHook(async (point, detail) => {
        if (point === 'consumer:prepared' && !last && detail.requestId && await carriesStamp(engine, detail.requestId)) {
          last = detail.requestId;
          // Another writer holds an unchanged path at the target before the last import publishes.
          await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/c.md', source_path: 'notes/c.md', slug: 'notes/c', page_id: Number(page.page.id),
            code: 'file_drift', message: 'Synthetic file_drift hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
            meta: { recovery_version: RECOVERY_VERSION, blob_oid: git(root, 'rev-parse', 'HEAD:notes/c.md'), page_revision: page.revision } } as never));
        }
        if (point === 'publication:after_commit' && detail.requestId === last && !seen) seen = await checkpoint(engine);
      });
      const run = await performManagedSync(engine, OPTS);
      installFaultHook(undefined);
      // The hold is a write of the round the pass did not make: the fold's proof refuses it before its own hold check.
      expect(await outcomeOf(engine, last!)).toEqual({ state: 'committed', stamp: null, skipped: 'foreign_checkpoint_write' });
      expect(seen).toEqual(before);
      const head = git(root, 'rev-parse', 'HEAD');
      const stamps = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE intent->>'kind'='managed_sync_checkpoint' AND intent->>'target'=$1", [head]);
      expect({ status: run.status, stamps, checkpoint: await checkpoint(engine) }).toEqual({ status: 'synced', stamps: [{ state: 'committed' }], checkpoint: { last_commit: head, converged: head } });
    }), 180_000);

    test('fold probe 3: a kill right after the folded import commits leaves the checkpoint and the page consistent; the next run imports nothing', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      const stamped = new Set<string>();
      let folded = false, killed = false;
      installFaultHook(async (point, detail) => {
        if (point === 'consumer:prepared' && detail.requestId && await carriesStamp(engine, detail.requestId)) stamped.add(detail.requestId);
        if (point === 'publication:after_commit' && detail.requestId && stamped.has(detail.requestId)) folded = true;
        if (point === 'sync:mid_checkpoint' && folded && !killed) { killed = true; throw new Error('killed right after the folded import committed'); }
      });
      const dead = await performManagedSync(engine, OPTS).then(result => result.status as string, (error: Error) => error.message);
      installFaultHook(undefined);
      expect(killed).toBe(true);
      expect(dead).toContain('killed right after the folded import committed');
      await disposePersistenceConsumer(engine);
      const head = git(root, 'rev-parse', 'HEAD');
      expect(await checkpoint(engine)).toEqual({ last_commit: head, converged: head });
      expect(await bodyOf(engine, 'notes/a')).toContain('A committed change of notes/a.');
      // The next run owes the killed run's tail and stamps it; it imports nothing.
      const after = await lastSequence(engine);
      const next = await performManagedSync(engine, OPTS);
      expect({ status: next.status, added: next.added, modified: next.modified }).toEqual({ status: next.status === 'up_to_date' ? 'up_to_date' : 'synced', added: 0, modified: 0 });
      expect(await engine.executeRaw("SELECT slug FROM persistence_requests WHERE intent->>'kind'='managed_sync_import' AND sequence>$1", [after])).toEqual([]);
      expect((await performManagedSync(engine, OPTS)).pass).toBeUndefined();
    }), 180_000);
    test('core guard: an always_load import publishes the same with its stamp folded or not; a guarded write of that growth is refused', () => brain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await engine.setConfig('memory.core.max_chars', '500');
      const core = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\nalways_load: true\n---\n\n${body}\n`;
      const receipt = async (slug: string, after: number) => (await engine.executeRaw<{ state: string; stamp: string | null; skipped: string | null }>(
        "SELECT state, outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped FROM persistence_requests WHERE intent->>'kind'='managed_sync_import' AND slug=$1 AND sequence>$2", [slug, after]));
      const coreRow = async (slug: string) => (await engine.executeRaw<{ always_load: boolean; chars: number }>(
        "SELECT (frontmatter->>'always_load')::boolean AS always_load, length(compiled_truth)::int AS chars FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0];

      writeFileSync(join(root, 'notes/a.md'), core('notes/a', 'a'.repeat(600))); commit(root, 'core a');
      let after = await lastSequence(engine);
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect(await receipt('notes/a', after)).toEqual([{ state: 'committed', stamp: 'folded', skipped: null }]);

      writeFileSync(join(root, 'notes/b.md'), core('notes/b', 'b'.repeat(600))); commit(root, 'core b');
      after = await lastSequence(engine);
      expect((await stampByCheckpoint(() => performManagedSync(engine, OPTS))).status).toBe('synced');
      expect(await receipt('notes/b', after)).toEqual([{ state: 'committed', stamp: null, skipped: 'error' }]);

      expect(await coreRow('notes/a')).toEqual({ always_load: true, chars: (await coreRow('notes/b'))!.chars });
      expect((await coreRow('notes/a'))!.chars).toBeGreaterThan(500);
      const head = git(root, 'rev-parse', 'HEAD');
      expect(await checkpoint(engine)).toEqual({ last_commit: head, converged: head });

      // The budget is live on the guarded path: an agent's write of the same growth is refused there.
      const refused = await (async () => {
        try {
          const current = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
          const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/c', request_id: randomUUID(), expected_revision: current.revision, content: core('notes/c', 'c'.repeat(600)) } });
          const requestId = (await admitWrite(engine, prepared.admission!)).request_id;
          let code: string | null = null;
          await waitFor(async () => {
            code = (await engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state, error_code FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))
              .find(row => row.state !== 'pending' && row.state !== 'claimed')?.error_code ?? null;
            return code !== null;
          }, { timeoutMs: 30_000, label: 'the guarded core write ends' });
          return code;
        } catch (error) { return (error as { code?: string }).code ?? String(error); }
      })();
      expect(refused).toBe('core_budget_exceeded');
      expect((await coreRow('notes/c'))!.always_load).not.toBe(true);
    }), 180_000);
  });

  describe(`#6712 PR 4b confirm-round classification reuse (${backend})`, () => {
    test('reuse probe: a hold appearing on an unchanged path between rounds classifies it again, and the hold stands', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const incarnation = await incarnationOf(engine), page = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      let wrote = false;
      const verdicts: Array<{ round: number; reused: number }> = [];
      installFaultHook(async (point, detail) => {
        if (point === 'sync:round_start' && detail.round === 2 && !wrote) {
          wrote = true;
          // Another writer holds notes/c (unchanged in Git and in the database, `matched` in round 1).
          await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/c.md', source_path: 'notes/c.md', slug: 'notes/c', page_id: Number(page.page.id),
            code: 'file_drift', message: 'Synthetic file_drift hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
            meta: { recovery_version: RECOVERY_VERSION, blob_oid: git(root, 'rev-parse', 'HEAD:notes/c.md'), page_revision: page.revision } } as never));
        }
        if (point === 'sync:level_read') verdicts.push({ round: detail.round!, reused: detail.level?.reused ?? 0 });
      });
      const run = await performManagedSync(engine, OPTS);
      installFaultHook(undefined);
      expect(wrote).toBe(true);
      expect(run.status).toBe('synced');
      expect((await readGitHold(engine, 'default', incarnation, 'notes/c.md'))?.code).toBe('file_drift');
      expect(await bodyOf(engine, 'notes/a')).toContain('A committed change of notes/a.');
      // The hold changed what round 2 reads, so it read whole and reused nothing.
      expect(verdicts.find(verdict => verdict.round === 2)?.reused).toBe(0);
    }), 180_000);

    test('reuse probe: open work naming an unchanged path between rounds classifies that path again, and reuses the rest', () => brain(async ({ engine, ctx, root }) => {
      await engine.setConfig('sync.write_through', 'false');
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      edit(root, 'notes/a', 'A committed change of notes/a.'); commit(root, 'change a');
      let open = null as string | null, release: () => void = () => {};
      const parked = new Promise<void>(resolve => { release = resolve; });
      const verdicts: Array<{ round: number; taken: boolean | null; reused: number }> = [];
      installFaultHook(async (point, detail) => {
        if (point === 'sync:round_start' && detail.round === 2 && !open) {
          // An agent's write of notes/c (unchanged in Git and in the database, `matched` in round 1) is admitted and stays unpublished.
          const current = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
          const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/c', request_id: randomUUID(), expected_revision: current.revision, content: note('notes/c', 'An agent edit in flight.') } });
          open = (await admitWrite(engine, prepared.admission!)).request_id;
        }
        if (point === 'consumer:prepared' && detail.requestId === open) await parked;
        if (point === 'sync:level_read') verdicts.push({ round: detail.round!, taken: detail.level?.confirm?.taken ?? null, reused: detail.level?.reused ?? 0 });
      });
      let run: Awaited<ReturnType<typeof performManagedSync>>;
      try { run = await performManagedSync(engine, OPTS); } finally { release(); }
      installFaultHook(undefined);
      expect(open).not.toBeNull();
      expect(run.status).toBe('synced');
      // Round 2 confirms the level and reuses notes/b; notes/c, named by open work, is classified again.
      expect(verdicts.find(verdict => verdict.round === 2)).toEqual({ round: 2, taken: true, reused: 1 });
      await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [open]))[0]?.state === 'committed',
        { timeoutMs: 30_000, label: 'the agent write of notes/c commits' });
      expect(await bodyOf(engine, 'notes/c')).toContain('An agent edit in flight.');
    }), 180_000);
  });
}
