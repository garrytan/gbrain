/**
 * GBRA-130 C-4: a shared-skill bundle publication stuck in recovery.
 *
 * Protects: a bundle publication (recovery record version 2) whose transaction failed after its files were published,
 * with one file edited by hand meanwhile, is refused `unexpected_file_bytes` and stops every write on its worktree.
 * `gbrain repair stuck-recovery` now resolves it: the preview lists every file of the bundle with its prior and disk
 * fingerprints; `--keep prior` or `--keep disk` applies to the whole bundle, bound to the preview hash, after every
 * file's bytes are backed up; the request ends by the owner's rule and the queued write behind it commits. The head
 * blocker and graduation's blocker for the request name the stuck-recovery preview.
 * Fails when: stuck-recovery throws `recovery_bundle_unsupported` again (the only exit is placing bytes by hand), a
 * choice applies to part of the bundle, or the apply skips the backup.
 * Why new: test/repair-stuck-recovery.test.ts only had a fabricated v2 record on PGLite; this publishes a real bundle
 * through the coordinator on both engines.
 * Seams: the coordinator's publication boundary hook and the persistence fault hook (`stuck_recovery:backed_up`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { publishMutation, type PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { graduationBlockers } from '../../src/core/persistence/graduation-drain.ts';
import { headBlockerAction, readHeadBlockers } from '../../src/core/persistence/head-blocker.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, getWriteRequestById, type WriteAdmission } from '../../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { RESOLUTION_OP } from '../../src/core/persistence/recovery-resolve.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { beliefPage, brainApi, type BeliefBrain } from '../helpers/belief-ledger.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const HUMAN = 'helper bytes edited by hand during publication';

afterEach(() => installFaultHook(undefined));

interface StuckBundle { b: BeliefBrain; engine: BrainEngine; root: string; id: string; requestId: string; files: string[] }

/**
 * A managed brain with one page (`sibling`) and a three-file skill bundle (replace SKILL.md, add helper.txt, remove
 * obsolete.txt) whose publication transaction fails after the files are published, while helper.txt is edited by
 * hand: the owner's recovery refuses it unexpected_file_bytes.
 */
async function stuckBundle(databaseUrl: string | undefined, run: (s: StuckBundle) => Promise<void>): Promise<void> {
  await managedBrain(async ({ engine, ctx, root }) => {
    const hostId = localHostId();
    await engine.executeRaw('CREATE TABLE IF NOT EXISTS bundle_projection_fixture (slug text PRIMARY KEY, revision uuid NOT NULL, body text NOT NULL)');
    const binding = (await getWorktreeBinding(engine, SOURCE))!;
    const name = 'example-skill';
    const dir = join(root, 'skills', name); mkdirSync(dir, { recursive: true });
    const files = [join(dir, 'SKILL.md'), join(dir, 'helper.txt'), join(dir, 'obsolete.txt')];
    writeFileSync(files[0]!, 'old instructions'); chmodSync(files[0]!, 0o640);
    writeFileSync(files[2]!, 'obsolete'); chmodSync(files[2]!, 0o600);
    const authority = await submissionAuthority(ctx as OperationContext, 'put_skill', SOURCE, binding.source_incarnation, name);
    const admission: WriteAdmission = { principal: authority.principal, operation: 'put_skill', targetKind: 'skill_bundle', protocolVersion: 2,
      sourceId: SOURCE, sourceIncarnation: binding.source_incarnation, slug: name, worktreeId: binding.worktree_id,
      topologyGeneration: binding.topology_generation, requestId: randomUUID(), callerIntent: { name }, intent: { name }, authority };
    const revision = randomUUID();
    const prepared: PreparedMutation = { target: 'skill_bundle', observedRevision: null, files: [
      { path: files[0]!, root, content: 'new instructions', expectedBeforeHash: sha256('old instructions') },
      { path: files[1]!, root, content: 'new helper', expectedBeforeHash: null },
      { path: files[2]!, root, content: null, expectedBeforeHash: sha256('obsolete') },
    ], validate: async () => {}, apply: async tx => {
      await tx.executeRaw('INSERT INTO bundle_projection_fixture(slug,revision,body) VALUES($1,$2::uuid,$3)', [name, revision, 'new instructions']);
      return { revision, name };
    } };
    const accepted = await admitWrite(engine, admission);
    const row = (await claimNextWrite(engine, hostId))!;
    expect(row.id).toBe(accepted.id);
    const done = await publishMutation(engine, row, prepared, hostId, { boundary: async point => {
      if (point === 'after_publication') { writeFileSync(files[1]!, HUMAN); throw new OperationError('storage_error', 'fixture: the publication transaction failed'); }
    } });
    expect(done).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
    await run({ b: brainApi(engine, ctx, root, SOURCE), engine, root, id: row.id, requestId: row.request_id, files });
  }, { databaseUrl, setup: async ({ engine, root }) => {
    await engine.putPage('sibling', { type: 'note', title: 'Sibling Example', compiled_truth: 'Sibling.' }, { sourceId: SOURCE });
    const snapshot = (await engine.readPageSnapshot('sibling', { sourceId: SOURCE }))!;
    writeFileSync(join(root, 'sibling.md'), serializePageToMarkdown(snapshot.page, snapshot.tags));
  } });
}

async function repair(engine: BrainEngine, opts: { apply?: boolean; expect?: string; keep?: 'prior' | 'disk' } = {}): Promise<RepairResult> {
  const runner = await repairRunner(engine, { apply: opts.apply === true });
  return runner.run('stuck-recovery', await resolveRepairScope(engine, SOURCE), { sourceFlag: SOURCE, explicit: true, expect: opts.expect, keep: opts.keep });
}

const disk = (path: string) => existsSync(path) ? { bytes: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 } : null;

async function pendingSiblingWrite(b: BeliefBrain): Promise<string> {
  const pending = await b.put('sibling', beliefPage({ title: 'Sibling Example', type: 'note', prose: 'Sibling, written while the bundle was stuck.' })).catch(error => error);
  expect({ code: (pending as { code?: string }).code }).toEqual({ code: 'write_pending' });
  const [row] = await b.engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_requests WHERE slug='sibling' AND state='queued'");
  return row!.id;
}

const committed = (engine: BrainEngine, id: string) => waitFor(async () =>
  (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [id]))[0]?.state === 'committed',
  { timeoutMs: 60_000, intervalMs: 100, label: 'queued sibling write committed' });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`C-4 shared-skill bundle stuck in recovery (${backend})`, () => {
    for (const keep of ['disk', 'prior'] as const) {
      test(`C-4 item: --keep ${keep} resolves the whole bundle after backing up every file, and the queued write commits`, () => stuckBundle(databaseUrl, async s => {
        const before = await snapshotItems(s.engine, SOURCE);
        const onDisk = s.files.map(disk);
        const queued = await pendingSiblingWrite(s.b);
        const read = (await readHeadBlockers(s.engine, [queued], localHostId())).get(queued)!;
        const blocker = (read as { blocker: Parameters<typeof headBlockerAction>[0] }).blocker;
        expectItemFailure({ key: blocker.ids[0], code: blocker.state ?? undefined, fix: headBlockerAction(blocker, SOURCE, `gbrain sync --source ${SOURCE}`) },
          { key: s.requestId, code: 'unexpected_file_bytes', fix: new RegExp(`^gbrain repair stuck-recovery --source ${SOURCE}`) });
        expect((await graduationBlockers(s.engine, localHostId())).find(b => b.kind === 'request' && b.id === s.requestId))
          .toMatchObject({ argv: ['gbrain', 'repair', 'stuck-recovery', '--source', SOURCE, '--request-id', s.requestId], needsUser: true });

        const preview = await expectUnitNotAborted(() => repair(s.engine));
        const details = preview.details as Record<string, any>;
        expect(details.recoveries).toHaveLength(1);
        const item = details.recoveries[0];
        expect(item).toMatchObject({ target: 'skill_bundle', request_id: s.requestId, choices: { prior: true, disk: true, withdrawn: false } });
        expect(item.files.map((file: any) => [file.relative, file.matches, file.prior.absent ? null : file.prior.sha256, file.disk.deleted ? null : file.disk.sha256])).toEqual([
          ['skills/example-skill/SKILL.md', 'published', sha256('old instructions'), sha256('new instructions')],
          ['skills/example-skill/helper.txt', 'neither', null, sha256(HUMAN)],
          ['skills/example-skill/obsolete.txt', 'published', sha256('obsolete'), null],
        ]);
        expect(details.choices.map((choice: { keep: string }) => choice.keep)).toEqual(['prior', 'disk']);

        const applied = await expectUnitNotAborted(() => repair(s.engine, { apply: true, expect: preview.preview_hash!, keep }));
        expect(applied.outcomes).toEqual({ resolved: 1 });
        const backup = String(applied.outcome_items![0]!.detail!.backup_dir);
        expect([0, 1, 2].map(i => existsSync(join(backup, `${i}.disk`)) ? readFileSync(join(backup, `${i}.disk`), 'utf8') : null)).toEqual(['new instructions', HUMAN, null]);
        expect([0, 2].map(i => readFileSync(join(backup, `${i}.prior`), 'utf8'))).toEqual(['old instructions', 'obsolete']);
        expect(s.files.map(disk)).toEqual(keep === 'disk' ? onDisk
          : [{ bytes: 'old instructions', mode: 0o640 }, null, { bytes: 'obsolete', mode: 0o600 }]);
        expect(await getWriteRequestById(s.engine, s.id)).toMatchObject({ state: 'failed', recovery: null });
        await committed(s.engine, queued);
        expectOthersUnchanged(before, await snapshotItems(s.engine, SOURCE), { expectProgress: ['sibling'], progressFields: ['content_hash'] });
      }), 240_000);
    }

    test('C-4 run: a run-scoped error during the apply stops it with no file touched, and the same apply then resolves it', () => stuckBundle(databaseUrl, async s => {
      const before = await snapshotItems(s.engine, SOURCE);
      const onDisk = s.files.map(disk);
      const preview = await repair(s.engine);
      expect(preview.preview_hash).toBeTruthy();
      for (const { name, error } of runScopedErrors().filter(e => ['connection lost', 'failed transaction (25P02)'].includes(e.name))) {
        installFaultHook(async point => { if (point === 'stuck_recovery:backed_up') throw error(); });
        const stopped = await repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'prior' }).then(result => result.stopped ?? null, thrown => ({ thrown: String(thrown) }));
        expect({ name, stopped: stopped !== null }).toEqual({ name, stopped: true });
        installFaultHook(undefined);
        expect(s.files.map(disk)).toEqual(onDisk);
        expect(await getWriteRequestById(s.engine, s.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
        expect(await s.engine.executeRaw('SELECT fingerprint FROM op_checkpoints WHERE op=$1', [RESOLUTION_OP])).toEqual([]);
      }
      expect((await repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'prior' })).outcomes).toEqual({ resolved: 1 });
      expect(s.files.map(disk)).toEqual([{ bytes: 'old instructions', mode: 0o640 }, null, { bytes: 'obsolete', mode: 0o600 }]);
      expectOthersUnchanged(before, await snapshotItems(s.engine, SOURCE));
    }), 240_000);
  });
}
