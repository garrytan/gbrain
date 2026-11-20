/**
 * Whole-class apply, rerun cases (`gbrain repair file-drift --held --side unknown --prefer file --whole-class --apply --expect <hash> --yes`):
 *   - an apply that finished without applying a page (every pin refused, here changed_since_preview) leaves no progress record, so the
 *     same class previewed again under the same hash applies its pages instead of reporting complete with nothing applied;
 *   - a database error while reading the saved approval surfaces as that error, not class_manifest_stale: the approval stands
 *     and a plain rerun applies it;
 *   - a running apply renews its lease, so a second apply is refused class_apply_busy even past the lease's length; one whose
 *     lease another apply took stops class_apply_busy and leaves that apply's progress record alone;
 *   - the mirror flag is read for each page: a source made writable during the apply skips its later pages changed_since_preview.
 * PGLite only: the Postgres arm's shards have no room left, and neither case depends on the backend. Synthetic content only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { PREVIEW_APPROVAL_OP } from '../src/core/persistence/preview-approval.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { FILE_DRIFT_VERSION, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { applyFileDriftClass, classLock, CLASS_PROGRESS_OP, classWindow, previewFileDriftClass, type ClassSelection } from '../src/core/repair/file-drift-class.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/n00', 'notes/n01'];
const doc = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const write = (root: string, body: (slug: string) => string) => {
  for (const slug of SLUGS) { mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, `${slug}.md`), doc(slug, body(slug))); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'pages');
};
const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const sel: ClassSelection = { sourceId: 'default', side: 'unknown', only: [], skip: [] };
const asCli = <T>(engine: BrainEngine, run: () => Promise<T>) => registerLocalWriter(engine, 'cli').then(writer => withVerifiedLocalRegistration(engine, writer, run));
const preview = (engine: BrainEngine) => asCli(engine, async () => previewFileDriftClass(engine, await resolveRepairScope(engine, 'default'), sel, { remote: false }));
const apply = (ctx: OperationContext, hash: string, opts: Parameters<typeof applyFileDriftClass>[4] = {}) =>
  asCli(ctx.engine, async () => applyFileDriftClass({ ...ctx, remote: false }, await resolveRepairScope(ctx.engine, 'default'), sel, hash, opts));
const progressLock = async (engine: BrainEngine, hash: string) => (await engine.executeRaw<{ t: string | null }>(
  "SELECT completed_keys->0->'lock'->>'token' AS t FROM op_checkpoints WHERE op=$1 AND fingerprint=$2", [CLASS_PROGRESS_OP, hash]))[0];
const setMirror = (engine: BrainEngine, on: boolean) => engine.executeRaw(`UPDATE sources SET config = config || jsonb_build_object('mirror_read_only', $1::boolean) WHERE id='default'`, [on]);
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ b: string }>("SELECT compiled_truth AS b FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]?.b;

/** A read-only mirror whose two pages changed in the database two hours ago and whose files were rewritten upstream since, each held file_drift on side unknown. */
async function mirrorHolds(engine: BrainEngine, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await coordinated(engine, "UPDATE pages SET compiled_truth='An old database body.', updated_at=now() - interval '2 hours' WHERE source_id='default' AND slug = ANY($1::text[])", [SLUGS]);
  write(root, slug => `A newer file body of ${slug}.`);
  await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
  await coordinated(engine, "UPDATE pages SET knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default'");
  await setMirror(engine, true);
  for (const slug of SLUGS) {
    const [page] = await engine.executeRaw<{ id: string; revision: string; incarnation: string }>(`SELECT p.id::text AS id, p.knowledge_revision::text AS revision,
      s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug=$1`, [slug]);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: page!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
      page_id: Number(page!.id), code: 'file_drift', message: `${slug}.md is held: file drift`, upstream_version: null, observed_at: new Date().toISOString(),
      run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, page_revision: page!.revision, sides: 'unknown', side: 'unknown', drift_version: FILE_DRIFT_VERSION } as never }));
  }
}

afterEach(() => { classWindow.pages = 200; classLock.ttlMs = 120_000; });

describe('whole-class apply reruns', () => {
  const pgliteClone = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-whole-class-reapply-'));
    const engine = await connectTemplateBrain(join(dir, 'brain'));
    return { engine, close: async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); } };
  };
  const opts = () => ({ open: pgliteClone, setup: ({ root }: { root: string }) => { git(root, 'init', '-q'); write(root, slug => `The committed body of ${slug}.`); } });

  test('an apply that applied nothing leaves no progress record, so the same class previewed again applies its pages', () => managedBrain(async ({ engine, ctx, root }) => {
    await mirrorHolds(engine, root);
    const first = (await preview(engine)).class_manifest!;
    expect(first.pages).toBe(2);
    await setMirror(engine, false);
    const skipped = await apply(ctx, first.hash);
    expect([skipped.complete, skipped.applied, skipped.skipped_pages.map(page => page.reason)]).toEqual([true, 0, ['changed_since_preview', 'changed_since_preview']]);
    expect((await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1', [CLASS_PROGRESS_OP])).length).toBe(0);
    await setMirror(engine, true);
    const again = (await preview(engine)).class_manifest!;
    expect(again.hash).toBe(first.hash);
    const applied = await apply(ctx, again.hash);
    expect([applied.complete, applied.applied, applied.skipped]).toEqual([true, 2, 0]);
    expect(await body(engine, 'notes/n00')).toBe('A newer file body of notes/n00.');
  }, opts()), 300_000);

  test('a database error reading the saved approval is reported as that error, and a rerun applies the same approval', () => managedBrain(async ({ engine, ctx, root }) => {
    await mirrorHolds(engine, root);
    const m = (await preview(engine)).class_manifest!;
    let failed = false;
    const flaky = new Proxy(engine, { get(target, key, receiver) {
      if (key !== 'readOpCheckpointRecord') return Reflect.get(target, key, receiver);
      return (op: string, fingerprint: string, opts?: { freshWithinDays?: number }) => {
        if (!failed && op === PREVIEW_APPROVAL_OP) { failed = true; return Promise.reject(new Error('connection terminated unexpectedly')); }
        return target.readOpCheckpointRecord(op, fingerprint, opts);
      };
    } }) as BrainEngine;
    const error = await apply({ ...ctx, engine: flaky }, m.hash).then(() => null, e => e);
    expect([failed, (error as { code?: string })?.code, (error as Error)?.message]).toEqual([true, undefined, 'connection terminated unexpectedly']);
    const applied = await apply(ctx, m.hash);
    expect([applied.complete, applied.applied, applied.skipped]).toEqual([true, 2, 0]);
  }, opts()), 300_000);

  test('a running apply renews its lease: a second apply past the lease length is refused class_apply_busy', () => managedBrain(async ({ engine, ctx, root }) => {
    await mirrorHolds(engine, root);
    const m = (await preview(engine)).class_manifest!;
    classWindow.pages = 1;
    classLock.ttlMs = 600;
    let second: unknown;
    const first = await apply(ctx, m.hash, { onWindow: async window => {
      if (window !== 0) return;
      await new Promise(resolve => setTimeout(resolve, 2000));
      second = await apply(ctx, m.hash).then(result => result, e => e);
    } });
    expect((second as { code?: string })?.code).toBe('class_apply_busy');
    expect([first.complete, first.applied]).toEqual([true, 2]);
  }, opts()), 300_000);

  test('an apply whose lease another apply took stops class_apply_busy, applies nothing more and leaves that progress record', () => managedBrain(async ({ engine, ctx, root }) => {
    await mirrorHolds(engine, root);
    const m = (await preview(engine)).class_manifest!;
    classWindow.pages = 1;
    const foreign = '00000000-0000-4000-8000-000000000001';
    const first = await apply(ctx, m.hash, { onWindow: async window => {
      if (window !== 0) return;
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,lock}', jsonb_build_object('token', $3::text, 'pid', 1, 'host', 'other-host', 'expires_at', 9999999999999))
        WHERE op=$1 AND fingerprint=$2`, [CLASS_PROGRESS_OP, m.hash, foreign]);
    } });
    expect([first.complete, first.applied, first.stopped?.code]).toEqual([false, 1, 'class_apply_busy']);
    expect((await progressLock(engine, m.hash))?.t).toBe(foreign);
    expect(await body(engine, 'notes/n01')).toBe('An old database body.');
  }, opts()), 300_000);

  test('a source made writable during the apply skips its later pages changed_since_preview and leaves them held', () => managedBrain(async ({ engine, ctx, root }) => {
    await mirrorHolds(engine, root);
    const m = (await preview(engine)).class_manifest!;
    classWindow.pages = 1;
    const result = await apply(ctx, m.hash, { onWindow: async window => { if (window === 0) await setMirror(engine, false); } });
    expect([result.complete, result.applied, result.skipped_pages]).toEqual([true, 1, [{ slug: 'notes/n01', reason: 'changed_since_preview' }]]);
    expect(await body(engine, 'notes/n01')).toBe('An old database body.');
    const held = await engine.executeRaw<{ p: string }>("SELECT completed_keys->0->>'path' AS p FROM op_checkpoints WHERE op='sync-hold'");
    expect(held.map(row => row.p)).toContain('notes/n01.md');
  }, opts()), 300_000);
});
