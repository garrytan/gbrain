/**
 * #6650 §1.10: `gbrain repair stuck-recovery` resolves a page publication recovery the owner refuses with
 * unexpected_file_bytes. Every fixture builds the real blocked state (a claimed write with a recovery record, a
 * human edit of its file, one owner recovery pass that parks it) and resolves it through the registered repair kind.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { recoverPublication } from '../src/core/persistence/coordinator.ts';
import { readHeadBlockers } from '../src/core/persistence/head-blocker.ts';
import { installFaultHook, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { RESOLUTION_OP, resolveStuckRecovery, scanStuckRecoveries } from '../src/core/persistence/recovery-resolve.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { REPAIR_KINDS } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY, repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';
import { AFTER, EDITED, PRIOR, stuckRecoveryFixture } from './helpers/stuck-recovery-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-stuck-recovery-'));
const roots: string[] = [];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await withEnv({ GBRAIN_HOME: home }, () => registerLocalWriter(engine, 'cli'));
}, 120_000);
afterEach(() => installFaultHook(undefined));
afterAll(async () => {
  await engine.disconnect();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const run = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const fixture = () => stuckRecoveryFixture(engine, roots);
const source = () => fixture().source();
const stuck = (opts: Parameters<ReturnType<typeof fixture>['stuck']>[0]) => fixture().stuck(opts);
const repair = (sourceId: string, opts: Parameters<ReturnType<typeof fixture>['repair']>[1] = {}) => fixture().repair(sourceId, opts);

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await withEnv({ GBRAIN_HOME: home, ...env }, () => runRepairCommand(engine, args)); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}

async function journal(id: string) {
  return (await engine.executeRaw<{ completed_keys: any[] }>("SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2", [RESOLUTION_OP, `${id}:%`]))
    .map(row => row.completed_keys[0]);
}


/** The recovery bytes still reserved by the request's worktree, from the rows and from the counter. */
async function recoveryAccounting(id: string) {
  const row = (await getWriteRequestById(engine, id))!;
  const [counts] = await engine.executeRaw<{ reserved: string; counter: string }>(`SELECT (SELECT COALESCE(SUM(recovery_bytes),0) FROM persistence_requests WHERE worktree_id=$1::uuid)::text AS reserved,
    (SELECT recovery_bytes FROM persistence_counters WHERE key='worktree:'||$1)::text AS counter`, [row.worktree_id]);
  return { reserved: Number(counts.reserved), counter: Number(counts.counter) };
}

describe('gbrain repair stuck-recovery', () => {
  test('is an explicit-only, preview-bound, destructive-consent repair kind that no unnamed runner can start', () => run(async () => {
    expect(REPAIR_KINDS).toContain('stuck-recovery');
    expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('stuck-recovery');
    expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('stuck-recovery');
    expect(repairSpec('stuck-recovery')).toMatchObject({ explicit_only: true, preview_bound: true, consent: 'destructive', embeds: 'none' });
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const runner = await repairRunner(engine, { apply: true });
    const unnamed = await refusal(() => runner.run('stuck-recovery', { brain_id: 'host', source_ids: [s.sourceId] }, { keep: 'prior', expect: 'x' }));
    expect(unnamed.code).toBe('explicit_kind_required');
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
  }));

  test('previews a human one-line edit: fingerprints, a private one-hunk diff with its command, the available choices; writes nothing canonical', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED, follower: true });
    const out = await cli(['stuck-recovery', '--source', s.sourceId]);
    expect(out).toContain(`request ${s.requestId} (put_page ${s.sourceId}:page, recovering, unexpected_file_bytes`);
    expect(out).toContain(`queued write`);
    expect(out).toContain('is blocked by request_recovery');
    expect(out).toContain(`prior: sha256 ${sha256(PRIOR).slice(0, 16)}… size ${PRIOR.length} mode 644`);
    expect(out).toContain(`disk:  sha256 ${sha256(EDITED).slice(0, 16)}… size ${EDITED.length}`);
    expect(out).toContain('recovery sees: neither the prior nor the published bytes (blocked)');
    const diffPath = /diff: (\S+)/.exec(out)![1]!;
    expect(diffPath.startsWith(join(home, '.gbrain', 'backups', 'stuck-recovery'))).toBe(true);
    expect(statSync(diffPath).mode & 0o077).toBe(0);
    const diff = readFileSync(diffPath, 'utf8');
    expect(diff).toContain('-line two\n');
    expect(diff).toContain('+line two, edited by hand\n');
    expect(diff.match(/^@@/gm)).toHaveLength(1);
    const command = /reproduce: (diff -u \S+ \S+)/.exec(out)![1]!;
    expect(readFileSync(command.split(' ')[2]!, 'utf8')).toBe(PRIOR);
    expect(readFileSync(command.split(' ')[3]!, 'utf8')).toBe(EDITED);
    const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
    expect(out).toContain(`--keep prior: discard the edit: write the recorded prior bytes back`);
    expect(out).toContain("no recorded failure: --keep prior requeues the write, --keep disk abandons it");
    expect(out).toContain(`gbrain repair stuck-recovery --source ${s.sourceId} --keep prior --apply --expect ${hash} --yes`);
    expect(out).toContain(`gbrain repair stuck-recovery --source ${s.sourceId} --keep disk --apply --expect ${hash} --yes`);
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
  }));

  test('--keep prior writes the prior bytes back, the owner finishes the recovery, and the queued head is claimable again', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED, follower: true });
    const blockedBy = async () => { const read = (await readHeadBlockers(engine, [s.follower!], localHostId())).get(s.follower!)!; return read.status === 'blocked' ? read.blocker.predicate : read.status; };
    expect(await blockedBy()).toBe('request_recovery');
    const preview = await repair(s.sourceId);
    expect(preview.listing).toHaveLength(1);
    const result = await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' });
    expect(result).toMatchObject({ applied: 1, complete: true, outcomes: { resolved: 1 } });
    expect(result.apply_command).toContain('--keep prior --apply');
    expect(readFileSync(s.path, 'utf8')).toBe(PRIOR);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'queued', recovery: null, blocked_reason: null });
    const detail = result.outcome_items![0]!.detail!;
    expect(detail).toMatchObject({ keep: 'prior', request_state: 'queued', finished_by: 'this_run' });
    expect(readFileSync(join(String(detail.backup_dir), '0.disk'), 'utf8')).toBe(EDITED);
    expect(readFileSync(join(String(detail.backup_dir), '0.prior'), 'utf8')).toBe(PRIOR);
    expect(await blockedBy()).not.toBe('request_recovery');
    expect((await readHeadBlockers(engine, [s.id], localHostId())).get(s.id)).toEqual({ status: 'claimable' });
    const [entry] = await journal(s.id);
    expect(entry).toMatchObject({ phase: 'done', keep: 'prior', request_id: s.requestId, original: { state: 'recovering', blocked_reason: 'unexpected_file_bytes' } });
  }));

  test('--keep disk (#6640 drop) keeps the edited bytes, abandons the live write as a conflict instead of requeueing it, and hands off to reconcile', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const preview = await repair(s.sourceId);
    const result = await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'disk' });
    expect(result.outcomes).toEqual({ resolved: 1 });
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'conflict', error_code: 'source_changed', recovery: null });
    const next = String(result.outcome_items![0]!.detail!.next);
    expect(next).toContain(`gbrain sources reconcile ${s.sourceId} page --brain host --preview`);
    expect(next).not.toContain('file-drift');
    expect(next).toContain('does not mark the page repaired');
    // #6858: both follow-ups, in order: the additive-aware reconcile preview, then the sync that resumes the source.
    expect(next).toContain(`--preview --auto-additive`);
    expect(next.indexOf('--auto-additive')).toBeLessThan(next.indexOf(`gbrain sync --source ${s.sourceId} --no-pull`));
    expect(readFileSync(join(String(result.outcome_items![0]!.detail!.backup_dir), '0.prior'), 'utf8')).toBe(PRIOR);
  }));

  test('#6858: --keep disk on a maintenance submit_job (not a sync import) still hands off to reconcile first', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    await engine.executeRaw(`UPDATE persistence_requests SET operation='submit_job', intent=intent || '{"kind":"managed_maintenance_page"}'::jsonb WHERE id=$1`, [s.id]);
    const preview = await repair(s.sourceId);
    const result = await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'disk' });
    expect(result.outcomes).toEqual({ resolved: 1 });
    const next = String(result.outcome_items![0]!.detail!.next);
    expect(next).not.toContain("sync import's publication");
    expect(next).toContain(`gbrain sources reconcile ${s.sourceId} page --brain host --preview --auto-additive`);
    expect(next.indexOf('--auto-additive')).toBeLessThan(next.indexOf(`gbrain sync --source ${s.sourceId} --no-pull`));
  }));

  test('absent prior (the write was a create): the preview says so, and --keep prior unlinks the edited file after backing it up', () => run(async () => {
    const s = await stuck({ prior: null, after: AFTER, disk: EDITED });
    const out = await cli(['stuck-recovery', '--source', s.sourceId]);
    expect(out).toContain('prior: absent: prior was a create');
    expect(out).toContain('reproduce: diff -u /dev/null ');
    const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
    const result = await repair(s.sourceId, { apply: true, expect: hash, keep: 'prior' });
    expect(result.outcomes).toEqual({ resolved: 1 });
    expect(existsSync(s.path)).toBe(false);
    expect(readFileSync(join(String(result.outcome_items![0]!.detail!.backup_dir), '0.disk'), 'utf8')).toBe(EDITED);
    expect((await getWriteRequestById(engine, s.id))!.recovery).toBeNull();
  }));

  test('a file deleted on disk is previewed as deleted and --keep disk keeps it deleted', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: null });
    const out = await cli(['stuck-recovery', '--source', s.sourceId]);
    expect(out).toContain('disk:  deleted on disk');
    const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
    expect((await repair(s.sourceId, { apply: true, expect: hash, keep: 'disk' })).outcomes).toEqual({ resolved: 1 });
    expect(existsSync(s.path)).toBe(false);
    expect((await getWriteRequestById(engine, s.id))!.recovery).toBeNull();
  }));

  test('a live request with a recorded failure ends with that failure under either choice; --keep disk keeps its error', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED, failed: true });
    const out = await cli(['stuck-recovery', '--source', s.sourceId]);
    expect(out).toContain('recorded failure storage_error: either choice ends the request with it');
    const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
    await repair(s.sourceId, { apply: true, expect: hash, keep: 'disk' });
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'failed', error_code: 'storage_error', recovery: null });
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
  }));

  test('a terminal request whose recovery record is still set is listed as refused, never resolved: no committed bytes are rolled back', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    await engine.executeRaw("UPDATE persistence_requests SET state='committed',completed_at=now() WHERE id=$1::uuid", [s.id]);
    const out = await cli(['stuck-recovery', '--source', s.sourceId]);
    expect(out).toContain(`refused ${s.requestId}`);
    expect(out).toContain('--keep prior would roll back a committed write');
    expect(out).not.toContain('--keep prior --apply');
    const preview = await repair(s.sourceId);
    expect(preview).toMatchObject({ affected: 0, residuals: { terminal_refused: 1 } });
    const named = await refusal(() => repair(s.sourceId, { requestId: s.requestId }));
    expect(named.code).toBe('recovery_choice_refused');
    expect(named.toJSON()).toMatchObject({ docs: 'docs/guides/repair.md#recovery-choice-refused' });
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'committed', blocked_reason: 'unexpected_file_bytes' });
  }));

  test('a choice the record cannot support is not offered and its apply refuses recovery_choice_refused', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    await engine.executeRaw(`UPDATE persistence_requests SET recovery=jsonb_set(recovery,'{before}','null'::jsonb) WHERE id=$1::uuid`, [s.id]);
    const out = await cli(['stuck-recovery', '--source', s.sourceId]);
    expect(out).toContain('(bytes not stored in the record)');
    expect(out).not.toContain('--keep prior --apply');
    expect(out).toContain('--keep disk --apply');
    const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
    const error = await refusal(() => repair(s.sourceId, { apply: true, expect: hash, keep: 'prior' }));
    expect(error.code).toBe('recovery_choice_refused');
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    expect(await journal(s.id)).toEqual([]);
  }));

  test('multi-file: every blocked record of the root is listed and resolved; --request-id narrows to one', () => run(async () => {
    const at = await source();
    const a = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED, slug: 'alpha', at });
    const b = await stuck({ prior: 'b prior\n', after: 'b after\n', disk: 'b edited\n', slug: 'beta', at });
    const all = await repair(at.sourceId);
    expect(all.listing!.map(entry => entry.item)).toEqual([`${at.sourceId}:alpha`, `${at.sourceId}:beta`]);
    const only = await repair(at.sourceId, { requestId: b.requestId });
    expect(only.listing!.map(entry => entry.item)).toEqual([`${at.sourceId}:beta`]);
    expect(only.preview_hash).not.toBe(all.preview_hash);
    const result = await repair(at.sourceId, { apply: true, expect: all.preview_hash, keep: 'prior' });
    expect(result).toMatchObject({ applied: 2, outcomes: { resolved: 2 } });
    expect(readFileSync(a.path, 'utf8')).toBe(PRIOR);
    expect(readFileSync(b.path, 'utf8')).toBe('b prior\n');
    for (const id of [a.id, b.id]) expect((await getWriteRequestById(engine, id))!.recovery).toBeNull();
  }));

  test('the apply re-verifies the preview: an edit after the preview refuses preview_changed and changes nothing', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const preview = await repair(s.sourceId);
    writeFileSync(s.path, `${EDITED}another edit\n`);
    const error = await refusal(() => repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' }));
    expect(error.code).toBe('preview_changed');
    expect(readFileSync(s.path, 'utf8')).toBe(`${EDITED}another edit\n`);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
    expect(await journal(s.id)).toEqual([]);
  }));

  test('the hash binds the page revision: a database change after the preview refuses preview_changed', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    await engine.putPage('page', { type: 'note', title: 'Page', compiled_truth: 'database body', timeline: '' }, { sourceId: s.sourceId });
    const preview = await repair(s.sourceId);
    await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [s.sourceId, 'page']);
    expect((await refusal(() => repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' }))).code).toBe('preview_changed');
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
  }));

  test('an identical apply after success replays its result; the terminal receipt stays immutable', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED, failed: true });
    const preview = await repair(s.sourceId);
    const first = await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' });
    expect(first.outcome_items![0]!.detail).toMatchObject({ request_state: 'failed' });
    const receipt = await getWriteRequestById(engine, s.id);
    expect(receipt).toMatchObject({ state: 'failed', error_code: 'storage_error', recovery: null });
    const again = await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' });
    expect(again).toMatchObject({ applied: 0, outcomes: { replayed: 1 } });
    expect(again.outcome_items![0]!.detail).toEqual(first.outcome_items![0]!.detail);
    expect(await getWriteRequestById(engine, s.id)).toEqual(receipt);
    expect(readFileSync(s.path, 'utf8')).toBe(PRIOR);
    const other = await refusal(() => repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'disk' }));
    expect(other.code).toBe('idempotency_conflict');
  }));

  test('the CLI apply asks for consent: without --yes a non-interactive run exits 3 with a user_message and changes nothing', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const hash = (await repair(s.sourceId)).preview_hash!;
    _resetCliExitVerdictForTests();
    const out = await cli(['stuck-recovery', '--source', s.sourceId, '--keep', 'prior', '--apply', '--expect', hash, '--json'], { GBRAIN_INTERACTIVE: '0', CI: '1' });
    expect(currentExitCode()).toBe(3);
    expect(out).toContain('user_message');
    expect(out).toContain('keep prior');
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    expect(await journal(s.id)).toEqual([]);
    _resetCliExitVerdictForTests();
    await cli(['stuck-recovery', '--source', s.sourceId, '--keep', 'prior', '--apply', '--expect', hash, '--yes', '--json'], { GBRAIN_INTERACTIVE: '0', CI: '1' });
    expect(readFileSync(s.path, 'utf8')).toBe(PRIOR);
    _resetCliExitVerdictForTests();
  }));

  test('an apply without --keep is refused with both choices named', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const hash = (await repair(s.sourceId)).preview_hash!;
    const error = await refusal(() => repair(s.sourceId, { apply: true, expect: hash }));
    expect(error.code).toBe('invalid_params');
    expect(error.suggestion).toContain('--keep prior');
    expect(error.suggestion).toContain('--keep disk');
  }));

  test('a v2 shared-skill bundle record is previewed with its files (GBRA-130 C-4); one this binary cannot read is refused with recovery_bundle_unsupported', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const [row] = await engine.executeRaw<{ recovery: any }>('SELECT recovery FROM persistence_requests WHERE id=$1::uuid', [s.id]);
    const bundle = (files: unknown[]) => ({ version: 2, target: 'skill_bundle', root: s.root, ownerEpoch: row.recovery.ownerEpoch, attempt: row.recovery.attempt, files });
    // Fixture only: the protocol trigger admits a bundle row solely through the shared-skill writer, so it is bypassed for these updates.
    const setRecovery = (record: unknown) => engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      await tx.executeRaw("UPDATE persistence_requests SET recovery=$2::text::jsonb,target_kind='skill_bundle',protocol_version=2 WHERE id=$1::uuid", [s.id, JSON.stringify(record)]);
    });
    await setRecovery(bundle([row.recovery]));
    const preview = await repair(s.sourceId);
    expect((preview.details as any).recoveries.map((found: any) => [found.target, found.request_id, found.files.map((file: any) => file.matches)]))
      .toEqual([['skill_bundle', s.requestId, ['neither']]]);
    await setRecovery(bundle([]));
    expect((await repair(s.sourceId)).details).toMatchObject({ recoveries: [], refused: [{ code: 'recovery_bundle_unsupported', request_id: s.requestId, fix: { ask_user: true } }] });
    const error = await refusal(() => repair(s.sourceId, { requestId: s.requestId }));
    expect(error.code).toBe('recovery_bundle_unsupported');
    expect(error.toJSON()).toMatchObject({ docs: 'docs/guides/repair.md#recovery-bundle-unsupported' });
    expect(error.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'repair', 'stuck-recovery', '--source', s.sourceId, '--request-id', s.requestId] });
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
  }));

  test('races the resident recovery pass: while the apply holds the worktree lock the pass changes nothing', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const hash = (await repair(s.sourceId)).preview_hash!;
    const seen: unknown[] = [];
    installFaultHook(async point => {
      if (point !== 'stuck_recovery:backed_up') return;
      const resident = await recoverPublication(engine, s.id);
      seen.push({ state: resident.state, blocked_reason: resident.blocked_reason, file: readFileSync(s.path, 'utf8') });
    });
    const result = await repair(s.sourceId, { apply: true, expect: hash, keep: 'prior' });
    expect(seen).toEqual([{ state: 'recovering', blocked_reason: 'unexpected_file_bytes', file: EDITED }]);
    expect(result.outcomes).toEqual({ resolved: 1 });
    expect(readFileSync(s.path, 'utf8')).toBe(PRIOR);
  }));

  const KILLS: Array<[FaultPoint, 'prior' | 'disk', string, boolean]> = [
    ['stuck_recovery:backed_up', 'prior', EDITED, true], ['stuck_recovery:written', 'prior', PRIOR, true], ['stuck_recovery:recovered', 'prior', PRIOR, false],
    ['stuck_recovery:backed_up', 'disk', EDITED, true], ['stuck_recovery:abandoned', 'disk', EDITED, true], ['stuck_recovery:recovered', 'disk', EDITED, false],
  ];
  for (const [point, keep, fileAtKill, recoveryAtKill] of KILLS) {
    test(`a run killed at ${point} (--keep ${keep}) resumes to the same end state`, () => run(async () => {
      const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
      const hash = (await repair(s.sourceId)).preview_hash!;
      installFaultHook(hit => { if (hit === point) throw new Error(`killed at ${hit}`); });
      await expect(repair(s.sourceId, { apply: true, expect: hash, keep })).rejects.toThrow(`killed at ${point}`);
      installFaultHook(undefined);
      expect(readFileSync(s.path, 'utf8')).toBe(fileAtKill);
      expect((await getWriteRequestById(engine, s.id))!.recovery !== null).toBe(recoveryAtKill);
      const resumed = await repair(s.sourceId, { apply: true, expect: hash, keep });
      expect(resumed.outcomes).toEqual({ resolved: 1 });
      expect(readFileSync(s.path, 'utf8')).toBe(keep === 'prior' ? PRIOR : EDITED);
      expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: keep === 'prior' ? 'queued' : 'conflict', recovery: null });
      expect((await journal(s.id)).map(entry => entry.phase)).toEqual(['done']);
      expect(await recoveryAccounting(s.id)).toEqual({ reserved: 0, counter: 0 });
    }));
  }

  for (const [point, keep] of [['stuck_recovery:written', 'prior'], ['stuck_recovery:abandoned', 'disk']] as const) {
    test(`mixed version: an older resident consumer finishes a resolution killed at ${point}, and the rerun records it`, () => run(async () => {
      const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
      const hash = (await repair(s.sourceId)).preview_hash!;
      installFaultHook(hit => { if (hit === point) throw new Error(`killed at ${hit}`); });
      await expect(repair(s.sourceId, { apply: true, expect: hash, keep })).rejects.toThrow(`killed at ${point}`);
      installFaultHook(undefined);
      // The resident pass of any version runs the unchanged recoverPublication: after --keep prior the file equals the
      // recorded prior (requeued); after --keep disk the request is already terminal, so it only cleans and clears the record.
      const state = keep === 'prior' ? 'queued' : 'conflict';
      expect(await recoverPublication(engine, s.id)).toMatchObject({ state, recovery: null });
      const resumed = await repair(s.sourceId, { apply: true, expect: hash, keep });
      expect(resumed.outcomes).toEqual({ resolved: 1 });
      expect(resumed.outcome_items![0]!.detail).toMatchObject({ finished_by: 'another_pass', request_state: state });
      expect(readFileSync(s.path, 'utf8')).toBe(keep === 'prior' ? PRIOR : EDITED);
      expect((await repair(s.sourceId, { apply: true, expect: hash, keep })).outcomes).toEqual({ replayed: 1 });
    }));
  }

  test('a withdrawal-mirror effect recovery on the worktree is listed as refused recovery_effect_unsupported and never touched', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const worktree = (await getWriteRequestById(engine, s.id))!.worktree_id;
    const [effect] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_effects(request_id,kind,data,worktree_id,recovery)
      VALUES($1::uuid,'withdrawal-mirror','{}'::jsonb,$2::uuid,'{"slug":"page"}'::jsonb) RETURNING id::text`, [s.id, worktree]);
    try {
      const out = await cli(['stuck-recovery', '--source', s.sourceId]);
      expect(out).toContain(`refused effect ${effect.id} of ${s.requestId}`);
      expect(out).toContain('recovery_effect_unsupported: A withdrawal-mirror effect recovery blocks the worktree');
      expect((await repair(s.sourceId)).residuals).toMatchObject({ effect_recovery: 1 });
      await engine.executeRaw("UPDATE persistence_requests SET recovery=NULL,recovery_bytes=0,state='committed',completed_at=now() WHERE id=$1::uuid", [s.id]);
      const named = await refusal(() => repair(s.sourceId, { requestId: s.requestId }));
      expect(named.code).toBe('recovery_effect_unsupported');
      expect(named.toJSON()).toMatchObject({ docs: 'docs/guides/repair.md#recovery-effect-unsupported' });
      expect((await engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_effects WHERE id=$1', [effect.id]))[0].recovery).toEqual({ slug: 'page' });
      expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    } finally { await engine.executeRaw('DELETE FROM persistence_effects WHERE id=$1', [effect.id]); }
  }));

  test('the apply waits a bounded time for the worktree lock, then refuses writer_lock_unavailable without changing anything', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const preview = await repair(s.sourceId);
    const [item] = (await scanStuckRecoveries(engine, [s.sourceId])).items;
    const held = await acquireWorktree((await getWorktreeBinding(engine, s.sourceId))!);
    expect(held).not.toBeNull();
    try {
      const started = Date.now();
      const error = await refusal(() => resolveStuckRecovery(engine, item!, { keep: 'prior', previewHash: preview.preview_hash!, lockWaitMs: 300 }));
      expect(error.code).toBe('writer_lock_unavailable');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { await held!.release(); }
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    expect(await journal(s.id)).toEqual([]);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
  }));

  test('--keep prior publishes through the record\'s reserved restoration stage, and a complete stage left by a killed write is cleaned first', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const stage = (await getWriteRequestById(engine, s.id))!.recovery as { staging?: { restoration?: { path: string } } };
    expect(stage.staging?.restoration?.path).toBeTruthy();
    writeFileSync(stage.staging!.restoration!.path, PRIOR);
    const preview = await repair(s.sourceId);
    expect((await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' })).outcomes).toEqual({ resolved: 1 });
    expect(readFileSync(s.path, 'utf8')).toBe(PRIOR);
    expect(existsSync(stage.staging!.restoration!.path)).toBe(false);
    expect(await recoveryAccounting(s.id)).toEqual({ reserved: 0, counter: 0 });
  }));

  test('--keep disk never rewrites the recovery record: the bytes it reserved are released with it', () => run(async () => {
    const s = await stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const before = (await getWriteRequestById(engine, s.id))!;
    expect(Number(before.recovery_bytes)).toBeGreaterThan(0);
    expect(await recoveryAccounting(s.id)).toEqual({ reserved: Number(before.recovery_bytes), counter: Number(before.recovery_bytes) });
    let seen: unknown = null;
    installFaultHook(async point => { if (point === 'stuck_recovery:abandoned') seen = (await getWriteRequestById(engine, s.id))!.recovery; });
    const preview = await repair(s.sourceId);
    await repair(s.sourceId, { apply: true, expect: preview.preview_hash, keep: 'disk' });
    installFaultHook(undefined);
    expect(seen).toEqual(before.recovery);
    expect(await recoveryAccounting(s.id)).toEqual({ reserved: 0, counter: 0 });
  }));

  test('nothing stuck: the preview lists nothing and an apply of its hash changes nothing', () => run(async () => {
    const { sourceId } = await source();
    const preview = await repair(sourceId);
    expect(preview).toMatchObject({ affected: 0, listing: [] });
    expect((await repair(sourceId, { apply: true, expect: preview.preview_hash, keep: 'prior' })).applied).toBe(0);
  }));
});
