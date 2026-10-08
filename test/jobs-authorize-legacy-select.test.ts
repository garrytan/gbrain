/**
 * #5157 Taste T3: `gbrain jobs authorize-legacy --select <filter>` previews
 * every matching SQL NULL row with a hash, and `--expect <hash> --yes`
 * authorizes exactly that set through the shared preview-approval helper.
 * Also pins the coded refusals that replaced the module's plain Errors
 * (DX-O2) and that the command is CLI-only (ENG-O13).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { applyLegacySelection, authorizeLegacyJobs, parseLegacyJobIds, previewLegacySelection } from '../src/core/minions/authorize-legacy.ts';
import { parseLegacyJobSelection } from '../src/core/minions/legacy-selection.ts';
import { assertNoUnreviewedJobs } from '../src/core/minions/submission-authority.ts';
import { PREVIEW_APPROVAL_OP } from '../src/core/persistence/preview-approval.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { argv } from './helpers/legacy-journey.ts';

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

async function legacy(name: string, status = 'waiting', authority: string | null = null): Promise<number> {
  const job = await queue.add(name, { n: Math.random() }, {}, { allowProtectedSubmit: true });
  if (status !== 'waiting') await engine.executeRaw('UPDATE minion_jobs SET status = $2 WHERE id = $1', [job.id, status]);
  await engine.executeRaw('UPDATE minion_jobs SET submission_authority = $2::text::jsonb WHERE id = $1', [job.id, authority]);
  return job.id;
}
async function authorities(): Promise<Record<number, unknown>> {
  const rows = await engine.executeRaw<{ id: number; submission_authority: unknown }>('SELECT id, submission_authority FROM minion_jobs ORDER BY id');
  return Object.fromEntries(rows.map(r => [r.id, r.submission_authority]));
}
async function refusal(fn: () => unknown): Promise<OperationError> {
  try { await fn(); } catch (error) { expect(error).toBeInstanceOf(OperationError); return error as OperationError; }
  throw new Error('expected a refusal');
}
async function cli(args: string[]): Promise<{ out: string; err: string; exit: number }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try { await runJobs(engine, args); } finally { console.log = log; console.error = error; }
  return { out: out.join('\n'), err: err.join('\n'), exit: currentExitCode() };
}

describe('--select grammar', () => {
  test('status and name keys with | alternatives', () => {
    expect(parseLegacyJobSelection('status=waiting|paused,name=synthesize|ingest_capture', 'authorize-legacy'))
      .toEqual({ statuses: ['waiting', 'paused'], names: ['synthesize', 'ingest_capture'] });
    expect(parseLegacyJobSelection('name=synthesize', 'authorize-legacy')).toEqual({ statuses: [], names: ['synthesize'] });
  });

  test('an unknown key or value refuses with legacy_job_selection_invalid listing the valid ones', async () => {
    for (const raw of ['state=waiting', 'status=active', 'status=bogus', 'status=waiting,status=paused', 'status=', 'status=waiting|', '', undefined]) {
      const error = await refusal(() => parseLegacyJobSelection(raw, 'authorize-legacy'));
      expect(error.code, String(raw)).toBe('legacy_job_selection_invalid');
      expect(error.message).toContain('status and name');
      expect(error.message).toContain('waiting|delayed|waiting-children|paused|completed|failed');
      expect(error.suggestion).toBe('gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize|ingest_capture"');
      expect(error.docs).toBe('docs/guides/repair.md#legacy-job-selection-invalid');
    }
  });
});

describe('authorize-legacy --select preview and apply', () => {
  test('preview lists every matching SQL NULL id with a hash and changes nothing', async () => {
    const a = await legacy('synthesize');
    const b = await legacy('synthesize', 'paused');
    const c = await legacy('ingest_capture');
    const unsupported = await legacy('synthesize', 'waiting', '{"version":2,"kind":"application"}');
    await queue.add('synthesize', { fresh: true }, {}, { allowProtectedSubmit: true });
    const before = await authorities();
    const preview = await previewLegacySelection(engine, parseLegacyJobSelection('status=waiting|paused,name=synthesize', 'authorize-legacy'));
    expect(preview.summary).toEqual({ total: 2, by_name: { synthesize: { waiting: 1, paused: 1 } }, first_ids: [a, b] });
    expect(preview.unsupported_ids).toEqual([unsupported]);
    expect(preview.preview_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.apply_command).toBe(`gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize" --expect ${preview.preview_hash} --yes`);
    expect(await authorities()).toEqual(before);
    expect(c).toBeGreaterThan(0);
  });

  test('apply authorizes exactly the previewed set, not rows that match later', async () => {
    const a = await legacy('synthesize');
    const selection = parseLegacyJobSelection('status=waiting', 'authorize-legacy');
    const preview = await previewLegacySelection(engine, selection);
    const late = await legacy('synthesize');
    const result = await applyLegacySelection(engine, selection, preview.preview_hash!, true);
    expect(result.authorized_ids).toEqual([a]);
    const now = await authorities();
    expect(now[a]).toEqual({ version: 1, kind: 'application' });
    expect(now[late]).toBeNull();
    // The approved set is consumed: replaying the same hash refuses.
    expect((await refusal(() => applyLegacySelection(engine, selection, preview.preview_hash!, true))).code).toBe('preview_changed');
  });

  test('a stale or unknown hash refuses with preview_changed and authorizes nothing', async () => {
    const a = await legacy('synthesize');
    const selection = parseLegacyJobSelection('status=waiting', 'authorize-legacy');
    const preview = await previewLegacySelection(engine, selection);
    await engine.executeRaw('UPDATE minion_jobs SET priority = priority + 1 WHERE id = $1', [a]);
    const stale = await refusal(() => applyLegacySelection(engine, selection, preview.preview_hash!, true));
    expect(stale.code).toBe('preview_changed');
    expect(stale.message).toContain(preview.preview_hash!);
    expect(stale.suggestion).toBe('Re-run the preview: gbrain jobs authorize-legacy --select "status=waiting"');
    expect(stale.docs).toBe('docs/guides/repair.md#preview-changed');
    const unknown = await refusal(() => applyLegacySelection(engine, selection, 'b'.repeat(64), true));
    expect(unknown.message).toBe(`The preview changed since ${'b'.repeat(64)}; re-run gbrain jobs authorize-legacy --select "status=waiting" and use the new hash.`);
    // A hash previewed for another filter does not apply under this one.
    const other = parseLegacyJobSelection('status=waiting,name=synthesize', 'authorize-legacy');
    const otherPreview = await previewLegacySelection(engine, other);
    expect((await refusal(() => applyLegacySelection(engine, selection, otherPreview.preview_hash!, true))).code).toBe('preview_changed');
    expect((await authorities())[a]).toBeNull();
  });

  test('two filters that select the same rows keep separate approvals (Codex review)', async () => {
    const a = await legacy('example-job');
    const broad = parseLegacyJobSelection('status=waiting', 'authorize-legacy');
    const narrow = parseLegacyJobSelection('status=waiting,name=example-job', 'authorize-legacy');
    const first = await previewLegacySelection(engine, broad);
    const second = await previewLegacySelection(engine, narrow);
    expect(first.snapshot!.snapshot_digest).toBe(second.snapshot!.snapshot_digest);
    expect(first.preview_hash).not.toBe(second.preview_hash);
    expect((await applyLegacySelection(engine, broad, first.preview_hash!, true)).authorized_ids).toEqual([a]);
  });

  test('active jobs refuse with legacy_jobs_active listing up to 10 cancel commands', async () => {
    await legacy('synthesize');
    const active: number[] = [];
    for (let i = 0; i < 11; i++) {
      const job = await queue.add('busy', { i });
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 't', lock_until = now() + interval '1 hour', claim_generation = claim_generation + 1 WHERE id = $1`, [job.id]);
      active.push(job.id);
    }
    const error = await refusal(() => previewLegacySelection(engine, parseLegacyJobSelection('status=waiting', 'authorize-legacy')));
    expect(error.code).toBe('legacy_jobs_active');
    expect(error.message).toContain('11 job(s) are active');
    expect(error.suggestion).toContain('Stop producers (gbrain serve, gbrain autopilot) and workers');
    for (const id of active.slice(0, 10)) expect(error.suggestion).toMatch(new RegExp(`gbrain jobs cancel ${id}\\b`));
    expect(error.suggestion).not.toMatch(new RegExp(`gbrain jobs cancel ${active[10]}\\b`));
    expect(error.suggestion).toContain('gbrain jobs list --status active');
    expect(error.docs).toBe('docs/guides/repair.md#legacy-jobs-active');
  });

  test('17.8k-scale selection previews with a summary and applies in one transaction', async () => {
    await engine.executeRaw(`INSERT INTO minion_jobs (name, status, data, submission_authority)
      SELECT CASE WHEN g % 10 = 0 THEN 'ingest_capture' ELSE 'synthesize' END, 'waiting', jsonb_build_object('g', g), '{"version":1,"kind":"application"}'::jsonb
        FROM generate_series(1, 17800) g`);
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL');
    const selection = parseLegacyJobSelection('status=waiting', 'authorize-legacy');
    const preview = await previewLegacySelection(engine, selection);
    expect(preview.summary.total).toBe(17800);
    expect(preview.summary.by_name).toEqual({ synthesize: { waiting: 16020 }, ingest_capture: { waiting: 1780 } });
    expect(preview.summary.first_ids).toHaveLength(20);
    await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('legacy jobs');
    const result = await applyLegacySelection(engine, selection, preview.preview_hash!, true);
    expect(result.authorized).toBe(17800);
    await assertNoUnreviewedJobs(engine);
  }, 120_000);
});

describe('coded refusals on the --ids path (DX-O2)', () => {
  test('missing ids, non-SQL-NULL rows and a stale digest carry codes, hints and anchors', async () => {
    const missing = await refusal(() => parseLegacyJobIds(undefined));
    expect(missing.code).toBe('legacy_job_selection_invalid');
    expect(missing.suggestion).toContain('gbrain jobs authorize-legacy --ids 12,34');
    const future = await legacy('synthesize', 'waiting', '{"version":2,"kind":"application"}');
    const unsupported = await refusal(() => authorizeLegacyJobs(engine, [future]));
    expect(unsupported.message).toContain('SQL NULL');
    expect(unsupported.suggestion).toContain(`gbrain jobs cancel ${future}`);
    const id = await legacy('synthesize');
    const stale = await refusal(() => authorizeLegacyJobs(engine, [id], 'a'.repeat(64), true));
    expect(stale.code).toBe('preview_changed');
    expect(stale.message).toContain('snapshot changed');
    expect(stale.suggestion).toBe(`Re-run the preview: gbrain jobs authorize-legacy --ids ${id}`);
    const flags = await refusal(() => authorizeLegacyJobs(engine, [id], 'a'.repeat(64), false));
    expect(flags.suggestion).toBe(`gbrain jobs authorize-legacy --ids ${id} --expect ${'a'.repeat(64)} --yes`);
  });
});

describe('CLI transport (ENG-O12) and CLI-only pin (ENG-O13)', () => {
  test('human preview summarizes and marks paid job names; --json carries the full rows', async () => {
    const a = await legacy('synthesize');
    await legacy('lint', 'paused');
    await legacy('ingest_capture', 'paused');
    const human = await cli(['authorize-legacy', '--select', 'status=waiting|paused']);
    expect(human.exit).toBe(0);
    expect(human.out).toContain('Legacy jobs matching status=waiting|paused (SQL NULL authority, authorizable): 3');
    expect(human.out).toContain('  synthesize: waiting 1  [may make paid provider calls]');
    expect(human.out).toContain('  ingest_capture: paused 1  [may make paid provider calls]');
    expect(human.out).toContain('  lint: paused 1');
    expect(human.out).not.toContain('lint: paused 1  [may');
    expect(human.out).toMatch(/Apply exactly this set: gbrain jobs authorize-legacy --select "status=waiting\|paused" --expect [a-f0-9]{64} --yes/);
    const json = JSON.parse((await cli(['authorize-legacy', '--select', 'status=waiting|paused', '--json'])).out);
    expect(json.snapshot.jobs.map((job: { id: number }) => job.id)).toContain(a);
    expect(json.paid_job_names).toEqual(['ingest_capture', 'synthesize']);
    const applied = await cli(['authorize-legacy', '--select', 'status=waiting|paused', '--expect', json.preview_hash, '--yes']);
    expect(applied.out).toContain('Authorized 3 legacy job(s) matching status=waiting|paused.');
  });

  test('--dry-run next to --expect/--yes previews and authorizes nothing (Codex review)', async () => {
    const a = await legacy('synthesize');
    const json = JSON.parse((await cli(['authorize-legacy', '--select', 'status=waiting', '--json'])).out);
    const dry = await cli(['authorize-legacy', '--select', 'status=waiting', '--expect', json.preview_hash, '--yes', '--dry-run']);
    expect(dry.out).toContain('Nothing was changed.');
    expect((await authorities())[a]).toBeNull();
  });

  test('the printed recovery still selects a parent that a required cancel moved to waiting (Codex review)', async () => {
    const parent = await legacy('fanout', 'waiting');
    const child = await queue.add('busy', {}, { parent_job_id: parent });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 't', lock_until = now() + interval '1 hour', claim_generation = claim_generation + 1 WHERE id = $1`, [child.id]);
    const gate = await refusal(() => assertNoUnreviewedJobs(engine));
    const preview = /preview with (gbrain jobs authorize-legacy --select "[^"]+")/.exec(gate.suggestion!)![1]!;
    await queue.cancelJob(child.id);
    expect((await queue.getJob(parent))?.status).toBe('waiting');
    const printed = await cli(argv(preview).slice(2));
    expect(printed.out).toContain('(SQL NULL authority, authorizable): 1');
  });

  test('a refusal prints the toJSON envelope with --json and exits 1', async () => {
    const result = await cli(['authorize-legacy', '--select', 'state=waiting', '--json']);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      error: 'legacy_job_selection_invalid',
      suggestion: 'gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize|ingest_capture"',
      docs: 'docs/guides/repair.md#legacy-job-selection-invalid',
    });
    expect(result.err).toContain('Error [legacy_job_selection_invalid]: Unknown --select key "state"');
    expect(result.err).toContain('Docs: docs/guides/repair.md#legacy-job-selection-invalid');
  });

  test('no operation exposes legacy authorization or bulk cancel to MCP or remediation', () => {
    const names = operations.map(op => op.name);
    expect(names.filter(name => /legacy|authorize_job|cancel_jobs/.test(name))).toEqual([]);
    const cancel = operations.find(op => op.name === 'cancel_job')!;
    expect(Object.keys(cancel.params)).toEqual(['id']);
  });
});
