/**
 * GBRA-130 C-1 / A-16: a withdrawal-mirror effect stuck in recovery after a hand edit.
 *
 * Protects: a `forget` whose mirror crashed after writing the file, followed by a hand edit of that file (it matches
 * neither the pre-withdrawal nor the withdrawn bytes), blocks every write on the worktree. `gbrain repair
 * stuck-recovery` resolves it with `--keep withdrawn` only: the preview lists the file, both fingerprints and the
 * request; the apply is bound to the preview hash, backs the edited bytes up first, writes the recorded withdrawn
 * bytes and lets the effect finish, so the queued write behind it commits. The forgotten fact stays forgotten after
 * the file is committed and synced. `--keep disk` (which would keep the forgotten fact on disk for the next sync to
 * re-import) and `--keep prior` are never offered. A record without its withdrawn bytes stays refused
 * (`recovery_effect_unsupported`) with an ask_user fix naming the exact preview. The head blocker's fix names the
 * stuck-recovery preview, and so does graduation's blocker for the effect.
 * Fails when: stuck-recovery refuses the effect again (no exit but a hand edit), offers --keep disk, or the apply
 * runs without the preview hash or backup.
 * Why new: test/repair-stuck-recovery.test.ts covers page recoveries on PGLite only; this builds the real effect
 * state through a managed brain's own consumer on both engines.
 * Seams: the existing persistence fault hook (`effect_recovery:before_clear`, `stuck_recovery:backed_up`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { graduationBlockers } from '../../src/core/persistence/graduation-drain.ts';
import { headBlockerAction, readHeadBlockers } from '../../src/core/persistence/head-blocker.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { RESOLUTION_OP } from '../../src/core/persistence/recovery-resolve.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { beliefPage, brainApi, type BeliefBrain } from '../helpers/belief-ledger.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, renderFix, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const CLAIM = 'Door code is 4417';
const CLAIM_B = 'Gate code is 5521';
const EDITED = beliefPage({ facts: [CLAIM], prose: 'Draft, edited by hand while the withdrawal was being mirrored.' });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

afterEach(() => installFaultHook(undefined));

interface StuckEffect { b: BeliefBrain; engine: BrainEngine; root: string; file: string; effectId: string; requestId: string; edited: string;
  record: { after: string; afterHash: string; beforeHash: string } }

const mirror = (engine: BrainEngine) => engine.executeRaw<{ id: string; error_code: string | null; recovery: StuckEffect['record'] | null; request_id: string }>(
  "SELECT e.id::text AS id, e.error_code, e.recovery, r.request_id::text AS request_id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='withdrawal-mirror' ORDER BY e.id");

const retryNow = (engine: BrainEngine) => engine.transaction(async tx => {
  await declarePersistenceProtocol(tx);
  await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='withdrawal-mirror' AND recovery IS NOT NULL");
});

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  if (git(root, 'status', '--porcelain').trim()) git(root, 'commit', '-q', '-m', message);
}

const sync = (engine: BrainEngine) => performSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true, drain: true, deadlineAtMs: Date.now() + 60_000 } as never);

/**
 * A managed brain (git checkout) with `affected` (`facts`, default one) and `sibling`, synced; a `forget` of the first
 * fact whose mirror dies after writing the file (before its commit), then a hand edit of the file (`edit` of the mirrored
 * bytes, default EDITED), and the owner's next recovery pass refusing it unexpected_file_bytes.
 */
async function stuckEffect(databaseUrl: string | undefined, run: (s: StuckEffect) => Promise<void>,
  opts: { facts?: string[]; edit?: (mirrored: string) => string } = {}): Promise<void> {
  await managedBrain(async ({ engine, ctx, root }) => {
    const b = brainApi(engine, ctx, root, SOURCE);
    await b.put('affected', beliefPage({ facts: opts.facts ?? [CLAIM] }));
    await b.put('sibling', beliefPage({ title: 'Sibling Example', prose: 'Sibling.' }));
    commitAll(root, 'seed');
    await sync(engine);
    const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [SOURCE, CLAIM]);
    let killed = 0;
    installFaultHook(async point => { if (point === 'effect_recovery:before_clear' && killed++ === 0) throw new Error('process ended before the mirror commit'); });
    await operations.find(o => o.name === 'forget')!.handler(ctx, { id: Number(fact!.id) });
    await waitFor(async () => killed > 0, { timeoutMs: 30_000, intervalMs: 50, label: 'mirror killed before commit' });
    installFaultHook(undefined);
    const file = join(root, 'affected.md');
    const [crashed] = await mirror(engine);
    const mirrored = Buffer.from(crashed!.recovery!.after, 'base64').toString('utf8');
    expect(readFileSync(file, 'utf8')).toBe(mirrored);
    const edited = opts.edit?.(mirrored) ?? EDITED;
    writeFileSync(file, edited);
    await retryNow(engine);
    await waitFor(async () => (await mirror(engine))[0]?.error_code === 'unexpected_file_bytes', { timeoutMs: 60_000, intervalMs: 100, label: 'mirror recovery refused' });
    const [stuck] = await mirror(engine);
    await run({ b, engine, root, file, effectId: stuck!.id, requestId: stuck!.request_id, edited, record: stuck!.recovery! });
  }, { databaseUrl, setup: ({ root }) => {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  } });
}

async function repair(engine: BrainEngine, opts: { apply?: boolean; expect?: string; keep?: string; requestId?: string } = {}): Promise<RepairResult> {
  const runner = await repairRunner(engine, { apply: opts.apply === true });
  return runner.run('stuck-recovery', await resolveRepairScope(engine, SOURCE), { sourceFlag: SOURCE, explicit: true, expect: opts.expect, keep: opts.keep as never, requestId: opts.requestId });
}

/** A write on the blocked worktree: accepted and left pending behind the effect recovery. */
async function pendingSiblingWrite(b: BeliefBrain): Promise<string> {
  const pending = await b.put('sibling', beliefPage({ title: 'Sibling Example', prose: 'Sibling, written while the worktree was blocked.' })).catch(error => error);
  expect({ code: (pending as { code?: string }).code }).toEqual({ code: 'write_pending' });
  const [row] = await b.engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_requests WHERE slug='sibling' AND state='queued'");
  return row!.id;
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`C-1 withdrawal-mirror effect stuck in recovery (${backend})`, () => {
    test('C-1 item: an edited mirror file has a preview-bound --keep withdrawn exit; the queued write commits and the forgotten fact stays forgotten after a sync', () => stuckEffect(databaseUrl, async s => {
      const before = await snapshotItems(s.engine, SOURCE);
      const queued = await pendingSiblingWrite(s.b);
      const read = (await readHeadBlockers(s.engine, [queued], localHostId())).get(queued)!;
      expect(read.status).toBe('blocked');
      const blocker = (read as { blocker: Parameters<typeof headBlockerAction>[0] }).blocker;
      expectItemFailure({ key: blocker.ids[0], code: blocker.state ?? undefined, fix: headBlockerAction(blocker, SOURCE, `gbrain sync --source ${SOURCE}`) },
        { key: s.effectId, code: 'unexpected_file_bytes', fix: new RegExp(`^gbrain repair stuck-recovery --source ${SOURCE} --request-id ${s.requestId}$`) });
      expect((await graduationBlockers(s.engine, localHostId())).find(b => b.kind === 'effect_recovery' && b.id === s.effectId))
        .toMatchObject({ argv: ['gbrain', 'repair', 'stuck-recovery', '--source', SOURCE, '--request-id', s.requestId], needsUser: true });

      const preview = await expectUnitNotAborted(() => repair(s.engine));
      const details = preview.details as Record<string, any>;
      expect(details.refused).toEqual([]);
      expect(details.recoveries).toHaveLength(1);
      expect(details.recoveries[0]).toMatchObject({ target: 'withdrawal_mirror', effect_id: s.effectId, request_id: s.requestId, slug: 'affected',
        choices: { prior: false, disk: false, withdrawn: true } });
      expect(details.recoveries[0].files[0]).toMatchObject({ matches: 'neither', disk: { sha256: sha256(EDITED) },
        prior: { sha256: s.record.beforeHash }, withdrawn: { sha256: s.record.afterHash } });
      expect(details.choices.map((choice: { keep: string }) => choice.keep)).toEqual(['withdrawn']);
      expect(details.choices[0].apply_command).toBe(`gbrain repair stuck-recovery --source ${SOURCE} --keep withdrawn --apply --expect ${preview.preview_hash} --yes`);

      for (const keep of ['disk', 'prior']) {
        await expect(repair(s.engine, { apply: true, expect: preview.preview_hash!, keep })).rejects.toMatchObject({ code: 'recovery_choice_refused' });
      }
      expect(readFileSync(s.file, 'utf8')).toBe(EDITED);

      const applied = await expectUnitNotAborted(() => repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'withdrawn' }));
      expect(applied.outcomes).toEqual({ resolved: 1 });
      const detail = applied.outcome_items![0]!.detail!;
      expect(readFileSync(join(String(detail.backup_dir), '0.disk'), 'utf8')).toBe(EDITED);
      expect(readFileSync(s.file, 'utf8')).toBe(Buffer.from(s.record.after, 'base64').toString('utf8'));
      expect((await mirror(s.engine))[0]!.recovery).toBeNull();
      expect((await repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'withdrawn' })).outcomes).toEqual({ replayed: 1 });

      await waitFor(async () => (await s.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [queued]))[0]?.state === 'committed',
        { timeoutMs: 60_000, intervalMs: 100, label: 'queued sibling write committed' });
      commitAll(s.root, 'after recovery');
      await sync(s.engine);
      const active = await s.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [SOURCE, CLAIM]);
      expect(active[0]!.n).toBe(0);
      expect(parseFactsFence(readFileSync(s.file, 'utf8')).facts.map(f => f.forgotten)).toEqual([true]);
      expectOthersUnchanged(before, await snapshotItems(s.engine, SOURCE), { changed: ['affected'], expectProgress: ['sibling'], progressFields: ['content_hash'] });
    }), 240_000);

    test('C-1 refusal: an effect record without its withdrawn bytes stays refused recovery_effect_unsupported with an ask_user fix naming the exact preview', () => stuckEffect(databaseUrl, async s => {
      await s.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_effects SET recovery=recovery-'after' WHERE id=$1", [s.effectId]);
      });
      const before = await snapshotItems(s.engine, SOURCE);
      const preview = await expectUnitNotAborted(() => repair(s.engine));
      const refused = (preview.details as Record<string, any>).refused;
      expect(refused).toHaveLength(1);
      const argv = `gbrain repair stuck-recovery --source ${SOURCE} --request-id ${s.requestId}`;
      expectItemFailure({ key: refused[0].effect_id, code: refused[0].code, fix: refused[0].fix }, { key: s.effectId, code: 'recovery_effect_unsupported', fix: new RegExp(`^${argv}$`) });
      expect(refused[0].fix).toMatchObject({ ask_user: true });
      const named = await repair(s.engine, { requestId: s.requestId }).catch(error => error);
      expect({ code: named.code, fix: renderFix(named.fix), ask_user: named.fix?.ask_user }).toEqual({ code: 'recovery_effect_unsupported', fix: argv, ask_user: true });
      expect(readFileSync(s.file, 'utf8')).toBe(EDITED);
      expectOthersUnchanged(before, await snapshotItems(s.engine, SOURCE));
    }), 240_000);

    test('C-1 run: a run-scoped error during the apply stops it with nothing written or held, and the same apply then resolves it', () => stuckEffect(databaseUrl, async s => {
      const before = await snapshotItems(s.engine, SOURCE);
      const preview = await repair(s.engine);
      expect(preview.preview_hash).toBeTruthy();
      for (const { name, error } of runScopedErrors().filter(e => ['connection lost', 'failed transaction (25P02)'].includes(e.name))) {
        installFaultHook(async point => { if (point === 'stuck_recovery:backed_up') throw error(); });
        const stopped = await repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'withdrawn' }).then(result => result.stopped ?? null, thrown => ({ thrown: String(thrown) }));
        expect({ name, stopped: stopped !== null }).toEqual({ name, stopped: true });
        installFaultHook(undefined);
        expect(readFileSync(s.file, 'utf8')).toBe(EDITED);
        expect((await mirror(s.engine))[0]!.recovery).not.toBeNull();
        expect(await s.engine.executeRaw('SELECT fingerprint FROM op_checkpoints WHERE op=$1', [RESOLUTION_OP])).toEqual([]);
      }
      const applied = await repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'withdrawn' });
      expect(applied.outcomes).toEqual({ resolved: 1 });
      expect(readFileSync(s.file, 'utf8')).toBe(Buffer.from(s.record.after, 'base64').toString('utf8'));
      expectOthersUnchanged(before, await snapshotItems(s.engine, SOURCE), { changed: ['affected'] });
    }), 240_000);

    test('C-1 stale: a later withdrawal on the same page makes the stuck record stale; no interruption of --keep withdrawn publishes a withdrawn fact, and the same apply resumes to resolved', () => stuckEffect(databaseUrl, async s => {
      const [second] = await s.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [SOURCE, CLAIM_B]);
      await operations.find(o => o.name === 'forget')!.handler(s.b.ctx, { id: Number(second!.id) });
      const active = async () => (await s.engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_id=$1 AND fact = ANY($2::text[]) AND expired_at IS NULL',
        [SOURCE, [CLAIM, CLAIM_B]])).map(row => row.fact);
      expect(await active()).toEqual([]);
      const leaked = () => parseFactsFence(readFileSync(s.file, 'utf8')).facts.filter(f => [CLAIM, CLAIM_B].includes(f.claim) && !f.forgotten).map(f => f.claim);

      const preview = await expectUnitNotAborted(() => repair(s.engine));
      expect((preview.details as Record<string, any>).recoveries).toHaveLength(1);
      const apply = () => repair(s.engine, { apply: true, expect: preview.preview_hash!, keep: 'withdrawn' });
      for (const point of ['stuck_recovery:backed_up', 'stuck_recovery:written', 'stuck_recovery:recovered']) {
        installFaultHook(async at => { if (at === point) throw new Error(`process ended at ${point}`); });
        const interrupted = await apply().then(result => result.outcomes, error => ({ thrown: String(error) }));
        installFaultHook(undefined);
        expect({ point, resolved: (interrupted as Record<string, unknown>).resolved ?? null }).toEqual({ point, resolved: null });
        if (point === 'stuck_recovery:backed_up') expect(readFileSync(s.file, 'utf8')).toBe(s.edited);
        else expect({ point, leaked: leaked() }).toEqual({ point, leaked: [] });
      }
      const applied = await expectUnitNotAborted(apply);
      expect(applied.outcomes).toEqual({ resolved: 1 });
      expect(leaked()).toEqual([]);
      expect((await mirror(s.engine))[0]!.recovery).toBeNull();

      commitAll(s.root, 'after recovery');
      await sync(s.engine);
      expect(await active()).toEqual([]);
      expect(leaked()).toEqual([]);
    }, { facts: [CLAIM, CLAIM_B], edit: mirrored => mirrored.replace('Draft.', 'Draft, edited by hand while the withdrawal was being mirrored.') }), 240_000);
  });
}
