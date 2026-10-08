/**
 * DX-T2 / ENG-O5: `gbrain jobs cancel --select <filter>` previews and hashes
 * the complete cancellation closure (selected rows plus parent transitions),
 * cancels exactly that set through cancelJobs with `--expect <hash> --yes`,
 * and refuses a selection that would cascade to a descendant outside it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { applyLegacyCancel, previewLegacyCancel } from '../src/core/minions/legacy-cancel.ts';
import { parseLegacyJobSelection } from '../src/core/minions/legacy-selection.ts';
import { assertNoUnreviewedJobs } from '../src/core/minions/submission-authority.ts';
import { PREVIEW_APPROVAL_OP } from '../src/core/persistence/preview-approval.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);
beforeEach(async () => {
  _resetCliExitVerdictForTests();
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op = $1', [PREVIEW_APPROVAL_OP]);
});
afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

const sel = (raw: string) => parseLegacyJobSelection(raw, 'cancel');
async function job(name: string, opts: { parent?: number; authority?: string | null; status?: string } = {}): Promise<number> {
  const added = await queue.add(name, { n: Math.random() }, opts.parent ? { parent_job_id: opts.parent } : {});
  if (opts.status) await engine.executeRaw('UPDATE minion_jobs SET status = $2 WHERE id = $1', [added.id, opts.status]);
  if (opts.authority !== undefined) await engine.executeRaw('UPDATE minion_jobs SET submission_authority = $2::text::jsonb WHERE id = $1', [added.id, opts.authority]);
  return added.id;
}
async function statuses(): Promise<Record<number, string>> {
  const rows = await engine.executeRaw<{ id: number; status: string }>('SELECT id, status FROM minion_jobs ORDER BY id');
  return Object.fromEntries(rows.map(r => [r.id, r.status]));
}
async function refusal(fn: () => unknown): Promise<OperationError> {
  try { await fn(); } catch (error) { expect(error).toBeInstanceOf(OperationError); return error as OperationError; }
  throw new Error('expected a refusal');
}

describe('jobs cancel --select', () => {
  test('preview lists and hashes the closure, including parent transitions, and changes nothing', async () => {
    const parent = await job('fanout');
    const child = await job('legacy-child', { parent, authority: null });
    const loner = await job('legacy-loner', { authority: 'null' });
    const keep = await job('legacy-child', { authority: null, status: 'completed' });
    const before = await statuses();
    const preview = await previewLegacyCancel(engine, sel('status=waiting'));
    expect(preview.summary.first_ids).toEqual([child, loner]);
    expect(preview.unsupported_ids).toEqual([loner]);
    expect(preview.parent_transitions).toEqual([{ id: parent, from: 'waiting-children', to: 'waiting' }]);
    expect(preview.apply_command).toBe(`gbrain jobs cancel --select "status=waiting" --expect ${preview.preview_hash} --yes`);
    expect(await statuses()).toEqual(before);
    expect(before[keep]).toBe('completed');
  });

  test('apply cancels exactly the previewed set, applies the parent transition and unblocks workers', async () => {
    const parent = await job('fanout');
    const child = await job('legacy-child', { parent, authority: null });
    const loner = await job('legacy-loner', { authority: 'null' });
    const preview = await previewLegacyCancel(engine, sel('status=waiting'));
    const late = await job('legacy-late', { authority: null, status: 'paused' });
    await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('legacy jobs');
    const result = await applyLegacyCancel(engine, sel('status=waiting'), preview.preview_hash!, true);
    expect(result.cancelled_ids).toEqual([child, loner]);
    const now = await statuses();
    expect(now[child]).toBe('cancelled');
    expect(now[loner]).toBe('cancelled');
    expect(now[parent]).toBe('waiting');
    expect(now[late]).toBe('paused');
    expect((await refusal(() => applyLegacyCancel(engine, sel('status=waiting'), preview.preview_hash!, true))).code).toBe('preview_changed');
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [late]);
    await assertNoUnreviewedJobs(engine);
  });

  test('a stale hash refuses with preview_changed and cancels nothing', async () => {
    const a = await job('legacy', { authority: null });
    const preview = await previewLegacyCancel(engine, sel('status=waiting'));
    await engine.executeRaw('UPDATE minion_jobs SET priority = priority + 1, updated_at = now() + interval \'1 second\' WHERE id = $1', [a]);
    const error = await refusal(() => applyLegacyCancel(engine, sel('status=waiting'), preview.preview_hash!, true));
    expect(error.code).toBe('preview_changed');
    expect(error.message).toBe(`The preview changed since ${preview.preview_hash}; re-run gbrain jobs cancel --select "status=waiting" and use the new hash.`);
    expect((await statuses())[a]).toBe('waiting');
  });

  test('a mixed-authority tree refuses: the application child is outside the selection', async () => {
    const parent = await job('legacy-parent');
    const appChild = await job('worker-step', { parent });
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [parent]);
    const error = await refusal(() => previewLegacyCancel(engine, sel('status=waiting-children')));
    expect(error.code).toBe('legacy_job_selection_invalid');
    expect(error.message).toBe(`Cancelling the selection would also cancel 1 descendant job(s) outside it: ${appChild}.`);
    expect(error.suggestion).toContain(`gbrain jobs cancel ${appChild}`);
    expect((await statuses())[appChild]).toBe('waiting');
  });

  test('an outside-set legacy descendant refuses until the filter selects it', async () => {
    const parent = await job('legacy-parent');
    const child = await job('legacy-child', { parent });
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = ANY($1::int[])', [[parent, child]]);
    const error = await refusal(() => previewLegacyCancel(engine, sel('name=legacy-parent')));
    expect(error.message).toContain(`outside it: ${child}.`);
    const widened = await previewLegacyCancel(engine, sel('name=legacy-parent|legacy-child'));
    expect(widened.summary.first_ids).toEqual([parent, child]);
    await applyLegacyCancel(engine, sel('name=legacy-parent|legacy-child'), widened.preview_hash!, true);
    expect(await statuses()).toEqual({ [parent]: 'cancelled', [child]: 'cancelled' });
  });

  test('active jobs refuse with legacy_jobs_active', async () => {
    await job('legacy', { authority: null });
    const busy = await job('busy');
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 't', lock_until = now() + interval '1 hour', claim_generation = claim_generation + 1 WHERE id = $1`, [busy]);
    const error = await refusal(() => previewLegacyCancel(engine, sel('status=waiting')));
    expect(error.code).toBe('legacy_jobs_active');
    expect(error.suggestion).toContain(`gbrain jobs cancel ${busy}`);
  });

  test('CLI: preview, --json and apply through runJobs; jobs cancel <id> is unchanged', async () => {
    const out: string[] = [];
    const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    console.error = () => {};
    try {
      const a = await job('synthesize-legacy', { authority: null });
      await runJobs(engine, ['cancel', '--select', 'status=waiting']);
      expect(out.join('\n')).toContain('Legacy jobs matching status=waiting to cancel (missing or unsupported authority): 1');
      out.length = 0;
      await runJobs(engine, ['cancel', '--select', 'status=waiting', '--json']);
      const preview = JSON.parse(out.join('\n'));
      expect(preview.rows.map((r: { id: number }) => r.id)).toEqual([a]);
      out.length = 0;
      await runJobs(engine, ['cancel', '--select', 'status=waiting', '--expect', preview.preview_hash, '--yes', '--dry-run']);
      expect(out.join('\n')).toContain('Nothing was changed.');
      expect((await statuses())[a]).toBe('waiting');
      out.length = 0;
      await runJobs(engine, ['cancel', '--select', 'status=waiting', '--expect', preview.preview_hash, '--yes']);
      expect(out.join('\n')).toBe('Cancelled 1 legacy job(s) matching status=waiting.');
      out.length = 0;
      await runJobs(engine, ['cancel', '--select', 'status=active', '--json']);
      expect(JSON.parse(out.join('\n')).error).toBe('legacy_job_selection_invalid');
      expect(currentExitCode()).toBe(1);
      const plain = await job('plain');
      out.length = 0;
      await runJobs(engine, ['cancel', String(plain)]);
      expect(out.join('\n')).toBe(`Job #${plain} cancelled.`);
    } finally {
      console.log = log; console.error = err;
    }
  });
});
