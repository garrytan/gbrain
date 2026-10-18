/**
 * `gbrain repair stuck-recovery` on a page recovery whose prior file is over the single-string ceiling (audit C-22).
 *
 * 1. Protects: a write replacing or removing a canonical file over 24 MiB (here a soft delete) keeps the prior file as a staged copy (`staging.before`)
 *    instead of embedding it. When the file is edited while that write publishes, recovery parks the request with
 *    `unexpected_file_bytes` and every write on the worktree stops. The repair kind previews it like a small recovery
 *    (both fingerprints, a bounded summary instead of a full diff) and resolves it under the same preview hash, backup
 *    journal and crash resumption: `--keep prior` puts the staged prior back byte for byte and the write publishes
 *    again, `--keep disk` keeps the edit and abandons the write. Every read, hash and copy of the large file streams:
 *    no whole-file `readFileSync` of the canonical file, its staged copy or a backup, and no piece over a segment.
 *    A staged copy that is missing or does not match its recorded hash refuses `--keep prior` with
 *    `recovery_prior_stage_unavailable`, whose fix is the exact `--keep disk` apply, and `--keep disk` still resolves.
 * 2. Fails when: the preview lists the recovery as refused (`recovery_large_file_unsupported`, the old dead end), the
 *    preview or apply reads the file whole, the apply skips the preview binding or the backup journal, or the
 *    stage refusal names no command.
 * 3. Existing coverage: test/repair-stuck-recovery.test.ts covers the embedded (small) record; segmented-delete-stage-crash.slow.test.ts
 *    builds a large record by SIGKILL and checks the preview scan.
 * 4. Fault seams: `publication:prepared` (the hand edit, then a transient database error, so the publication is
 *    interrupted with no recorded failure) and the `stuck_recovery:*` seams. `largeFileWork` is the module's counter.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (GBRAIN_TEST_BACKEND=postgres runs only the Postgres arm).
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { RESOLUTION_OP } from '../../src/core/persistence/recovery-resolve.ts';
import { largeFileWork } from '../../src/core/persistence/large-file.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { fileSha, writeCanonicalPage } from '../helpers/large-page-file.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-stuck-recovery-large-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const MiB = 1024 * 1024;
const EDIT = 'edited by hand while the write was publishing\n';

beforeAll(async () => {
  for (const kind of testBackends()) {
    if (kind === 'pglite') { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); continue; }
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterEach(() => installFaultHook(undefined));
afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

interface Stuck {
  engine: BrainEngine; sourceId: string; root: string; slug: string; file: string; id: string; requestId: string;
  prior: { sha: string; size: number }; edited: { sha: string; size: number }; stage: { path: string; hash: string; bytes: number };
}

async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; await Bun.sleep(1000); }
  }
}

/**
 * The real blocked state: a managed source with an imported page over the ceiling; a soft delete of it records its
 * recovery and stages the prior file, the file is edited by hand at `publication:prepared`, and a transient database
 * error interrupts the publication, so the owner's recovery pass parks the request on `unexpected_file_bytes`.
 */
async function stuckLarge(engine: BrainEngine, seed: number): Promise<Stuck> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const root = join(home, `src-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `stuck-large-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
  const slug = `notes/large-${seed}`;
  const file = join(root, `${slug}.md`);
  const prior = writeCanonicalPage(file, 25 * MiB, seed);
  expect(await settled(() => importManagedFile(engine, file, `${slug}.md`, { sourceId, noEmbed: true }))).toMatchObject({ status: 'imported' });
  installFaultHook(async (point, detail) => {
    if (point !== 'publication:prepared' || detail.sourceId !== sourceId || detail.operation !== 'delete_page') return;
    appendFileSync(file, EDIT);
    throw Object.assign(new Error('simulated serialization failure'), { code: '40001' });
  });
  const expected_revision = (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
  try { await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision, request_id: randomUUID() } }).catch(() => undefined); }
  finally { installFaultHook(undefined); }
  await disposePersistenceConsumer(engine);
  const [row] = await engine.executeRaw<{ id: string; request_id: string; state: string; blocked_reason: string | null; error_code: string | null; recovery: any }>(
    "SELECT id::text, request_id::text, state, blocked_reason, error_code, recovery FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' ORDER BY sequence DESC LIMIT 1", [sourceId]);
  expect(row).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes', error_code: null });
  expect(row!.recovery).toMatchObject({ before: null, beforeHash: prior.sha, staging: { before: { hash: prior.sha, bytes: prior.size } } });
  expect(fileSha(row!.recovery.staging.before.path)).toBe(prior.sha);
  return { engine, sourceId, root, slug, file, id: row!.id, requestId: row!.request_id, prior, edited: { sha: fileSha(file), size: statSync(file).size },
    stage: row!.recovery.staging.before };
}

const run = <T>(fn: () => Promise<T>) => withEnv(env, fn);

async function repair(s: Stuck, opts: { apply?: boolean; expect?: string; keep?: 'prior' | 'disk' } = {}): Promise<RepairResult> {
  const runner = await repairRunner(s.engine, { apply: opts.apply === true });
  return runner.run('stuck-recovery', await resolveRepairScope(s.engine, s.sourceId), { sourceFlag: s.sourceId, explicit: true, expect: opts.expect, keep: opts.keep });
}

async function cli(s: Stuck, args: string[]): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(s.engine, args); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

async function journal(s: Stuck) {
  return (await s.engine.executeRaw<{ completed_keys: any[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2', [RESOLUTION_OP, `${s.id}:%`]))
    .map(row => row.completed_keys[0]);
}

/** No recovery bytes left reserved by the source's worktree: on its rows and on its counter (the brain counter is shared by every test). */
async function countersZero(s: Stuck): Promise<boolean> {
  const worktree = (await getWriteRequestById(s.engine, s.id))!.worktree_id;
  const [counts] = await s.engine.executeRaw<{ reserved: string; counter: string }>(`SELECT (SELECT COALESCE(SUM(recovery_bytes),0) FROM persistence_requests WHERE worktree_id=$1::uuid)::text AS reserved,
    (SELECT recovery_bytes FROM persistence_counters WHERE key='worktree:'||$1)::text AS counter`, [worktree]);
  return Number(counts!.reserved) === 0 && Number(counts!.counter) === 0;
}

const stagingLeft = (s: Stuck) => readdirSync(join(s.root, 'notes')).filter(name => name.includes('.tmp.'));

/**
 * Whole-file `readFileSync` calls made from src/ on any file over the single-string ceiling (the canonical file, its
 * staged copy, a backup), with the call's stack as evidence; and the large-file work counter from zero.
 */
function watchMemory() {
  const original = fs.readFileSync;
  const hits: string[] = [];
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const stack = new Error().stack ?? '';
    const path = typeof args[0] === 'string' ? args[0] : null;
    if (path && stack.includes('/src/core/') && existsSync(path) && statSync(path).isFile() && statSync(path).size > 24 * MiB) hits.push(`${path}: ${stack.split('\n').slice(1, 4).join(' | ')}`);
    return original(...args);
  }) as typeof fs.readFileSync);
  for (const key of Object.keys(largeFileWork) as (keyof typeof largeFileWork)[]) largeFileWork[key] = 0;
  return { hits, restore: () => spy.mockRestore(), work: () => ({ ...largeFileWork }) };
}

function expectBounded(memory: ReturnType<typeof watchMemory>): void {
  memory.restore();
  expect(memory.hits).toEqual([]);
  const work = memory.work();
  expect(work.largestPiece).toBeGreaterThan(0);
  expect(work.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
}

test('the preview lists a stuck large-file recovery with both fingerprints and a bounded summary, read in pieces', () => run(async () => {
  for (const engine of engines) {
    const s = await stuckLarge(engine, 11);
    const memory = watchMemory();
    let out: string;
    try { out = await cli(s, ['stuck-recovery', '--source', s.sourceId]); } finally { memory.restore(); }
    expectBounded(memory);
    expect(out).toContain(`request ${s.requestId} (delete_page ${s.sourceId}:${s.slug}, recovering, unexpected_file_bytes`);
    expect(out).not.toContain('recovery_large_file_unsupported');
    expect(out).toContain(`prior: sha256 ${s.prior.sha.slice(0, 16)}… size ${s.prior.size} mode 644, staged copy verified`);
    expect(out).toContain(`disk:  sha256 ${s.edited.sha.slice(0, 16)}… size ${s.edited.size}`);
    expect(out).toContain('recovery sees: neither the prior nor the published bytes (blocked)');
    expect(out).toContain('(summary: a version is over the 24 MiB single-string ceiling, so no full diff)');
    const summaryPath = /diff: (\S+)/.exec(out)![1]!;
    expect(statSync(summaryPath).mode & 0o077).toBe(0);
    expect(statSync(summaryPath).size).toBeLessThan(16 * 1024);
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('summary only, no full diff');
    expect(summary).toContain(`sha256 ${s.prior.sha}  ${s.prior.size} bytes`);
    expect(summary).toContain(`sha256 ${s.edited.sha}  ${s.edited.size} bytes`);
    expect(summary).toContain(`first difference at byte ${s.prior.size}`);
    expect(summary).toContain(`+${EDIT.trimEnd()}`);
    const [, priorCopy, diskCopy] = /reproduce: cmp (\S+) (\S+)/.exec(out)!;
    expect(fileSha(priorCopy!)).toBe(s.prior.sha);
    expect(fileSha(diskCopy!)).toBe(s.edited.sha);
    const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
    expect(out).toContain(`gbrain repair stuck-recovery --source ${s.sourceId} --keep prior --apply --expect ${hash} --yes`);
    expect(out).toContain(`gbrain repair stuck-recovery --source ${s.sourceId} --keep disk --apply --expect ${hash} --yes`);
    expect(fileSha(s.file)).toBe(s.edited.sha);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
  }
}), 1_800_000);

test('--keep prior restores the staged prior byte for byte, streamed, and the write publishes again', () => run(async () => {
  for (const engine of engines) {
    const s = await stuckLarge(engine, 21);
    const preview = await repair(s);
    expect(preview.listing).toHaveLength(1);
    const memory = watchMemory();
    let result: RepairResult;
    try { result = await repair(s, { apply: true, expect: preview.preview_hash, keep: 'prior' }); } finally { memory.restore(); }
    expectBounded(memory);
    expect(result).toMatchObject({ applied: 1, complete: true, outcomes: { resolved: 1 } });
    expect(statSync(s.file).size).toBe(s.prior.size);
    expect(fileSha(s.file)).toBe(s.prior.sha);
    expect(stagingLeft(s)).toEqual([]);
    const detail = result.outcome_items![0]!.detail!;
    expect(detail).toMatchObject({ keep: 'prior', request_state: 'queued', finished_by: 'this_run' });
    expect(fileSha(join(String(detail.backup_dir), '0.prior'))).toBe(s.prior.sha);
    expect(fileSha(join(String(detail.backup_dir), '0.disk'))).toBe(s.edited.sha);
    const queued = (await getWriteRequestById(engine, s.id))!;
    expect(queued).toMatchObject({ state: 'queued', recovery: null, blocked_reason: null });
    expect(await countersZero(s)).toBe(true);
    expect((await journal(s)).map(entry => entry.phase)).toEqual(['done']);
    const published = await waitForWrite(engine, queued, { engine: engine.kind } as never, 120_000);
    expect(published.state).toBe('committed');
    expect(existsSync(s.file)).toBe(false);
    const [page] = await engine.executeRaw<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [s.sourceId, s.slug]);
    expect(page?.deleted).toBe(true);
    expect(stagingLeft(s)).toEqual([]);
    await disposePersistenceConsumer(engine);
  }
}), 1_800_000);

test('--keep disk keeps the edit byte for byte and abandons the write; the staged prior is backed up, then released', () => run(async () => {
  for (const engine of engines) {
    const s = await stuckLarge(engine, 31);
    const preview = await repair(s);
    const memory = watchMemory();
    let result: RepairResult;
    try { result = await repair(s, { apply: true, expect: preview.preview_hash, keep: 'disk' }); } finally { memory.restore(); }
    expectBounded(memory);
    expect(result.outcomes).toEqual({ resolved: 1 });
    expect(fileSha(s.file)).toBe(s.edited.sha);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'conflict', error_code: 'source_changed', recovery: null });
    const detail = result.outcome_items![0]!.detail!;
    expect(fileSha(join(String(detail.backup_dir), '0.prior'))).toBe(s.prior.sha);
    expect(fileSha(join(String(detail.backup_dir), '0.disk'))).toBe(s.edited.sha);
    expect(existsSync(s.stage.path)).toBe(false);
    expect(stagingLeft(s)).toEqual([]);
    expect(await countersZero(s)).toBe(true);
  }
}), 1_800_000);

test('the preview hash binds the disk bytes: an edit after the preview refuses preview_changed and changes nothing', () => run(async () => {
  for (const engine of engines) {
    const s = await stuckLarge(engine, 41);
    const preview = await repair(s);
    appendFileSync(s.file, 'another edit after the preview\n');
    const changed = fileSha(s.file);
    const error = await refusal(() => repair(s, { apply: true, expect: preview.preview_hash, keep: 'prior' }));
    expect(error.code).toBe('preview_changed');
    expect(fileSha(s.file)).toBe(changed);
    expect(fileSha(s.stage.path)).toBe(s.prior.sha);
    expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
    expect(await journal(s)).toEqual([]);
  }
}), 1_800_000);

for (const point of ['stuck_recovery:backed_up', 'stuck_recovery:written'] as const) {
  test(`a --keep prior run killed at ${point} resumes from its journal to the same end state`, () => run(async () => {
    for (const engine of engines) {
      const s = await stuckLarge(engine, point.endsWith('backed_up') ? 51 : 52);
      const hash = (await repair(s)).preview_hash!;
      installFaultHook(hit => { if (hit === point) throw new Error(`killed at ${hit}`); });
      await expect(repair(s, { apply: true, expect: hash, keep: 'prior' })).rejects.toThrow(`killed at ${point}`);
      installFaultHook(undefined);
      expect(fileSha(s.file)).toBe(point.endsWith('backed_up') ? s.edited.sha : s.prior.sha);
      expect((await journal(s)).map(entry => entry.phase)).toEqual(point.endsWith('backed_up') ? [] : ['backed_up']);
      expect((await getWriteRequestById(engine, s.id))!.recovery).not.toBeNull();
      const resumed = await repair(s, { apply: true, expect: hash, keep: 'prior' });
      expect(resumed.outcomes).toEqual({ resolved: 1 });
      expect(fileSha(s.file)).toBe(s.prior.sha);
      expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'queued', recovery: null });
      expect((await journal(s)).map(entry => entry.phase)).toEqual(['done']);
      expect(stagingLeft(s)).toEqual([]);
      expect(await countersZero(s)).toBe(true);
    }
  }), 1_800_000);
}

for (const damage of ['missing', 'mismatched'] as const) {
  test(`a ${damage} staged prior refuses --keep prior with recovery_prior_stage_unavailable naming the exact --keep disk apply, which resolves`, () => run(async () => {
    for (const engine of engines) {
      const s = await stuckLarge(engine, damage === 'missing' ? 61 : 62);
      if (damage === 'missing') unlinkSync(s.stage.path);
      else truncateSync(s.stage.path, Math.floor(s.stage.bytes / 2));
      const torn = damage === 'mismatched' ? fileSha(s.stage.path) : null;
      const out = await cli(s, ['stuck-recovery', '--source', s.sourceId]);
      expect(out).toContain(damage === 'missing' ? 'staged copy missing' : 'staged copy does not match its recorded SHA-256');
      expect(out).not.toContain('--keep prior --apply');
      expect(out).toContain('--keep disk --apply');
      expect(out).not.toContain('by hand');
      const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
      const error = await refusal(() => repair(s, { apply: true, expect: hash, keep: 'prior' }));
      expect(error.code).toBe('recovery_prior_stage_unavailable');
      expect(error.suggestion).not.toContain('by hand');
      const keepDisk = ['gbrain', 'repair', 'stuck-recovery', '--source', s.sourceId, '--keep', 'disk', '--apply', '--expect', hash, '--yes'];
      expect(error.fix).toMatchObject({ argv: keepDisk, consent: ['destructive'], verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', s.sourceId, '--json'] } });
      expect(error.toJSON()).toMatchObject({ docs: 'docs/guides/repair.md#recovery-prior-stage-unavailable' });
      expect(fileSha(s.file)).toBe(s.edited.sha);
      expect(await journal(s)).toEqual([]);
      const result = await repair(s, { apply: true, expect: hash, keep: 'disk' });
      expect(result.outcomes).toEqual({ resolved: 1 });
      expect(fileSha(s.file)).toBe(s.edited.sha);
      expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: 'conflict', recovery: null });
      const backup = String(result.outcome_items![0]!.detail!.backup_dir);
      expect(fileSha(join(backup, '0.disk'))).toBe(s.edited.sha);
      if (torn) expect(fileSha(join(backup, '0.prior-stage'))).toBe(torn);
      expect(existsSync(s.stage.path)).toBe(false);
      expect(stagingLeft(s)).toEqual([]);
      expect(await countersZero(s)).toBe(true);
    }
  }), 1_800_000);
}
