/**
 * GBRA-130 C-7: the shared-skills content receipt after a writer transfer or relocation.
 *
 * Protects: a gbrain-owned content-directory source keeps a content receipt
 * (config `shared_skills.content.v1.<source>.<incarnation>`) naming its root and
 * the root's device/inode. A cross-host transfer (or `sources set-path`) moved the
 * checkout but left the receipt on the old root, so doctor `sync_freshness`
 * failed forever and prescribed `gbrain sync --no-pull`, which refuses
 * `sync_not_applicable`. Now accept and set-path rebind every owned receipt of
 * the moved sources (nested ones by relative_path) in their own transaction, so
 * a failed accept rolls the receipt back with it; a receipt that is already
 * stale gets doctor's typed `content_receipt_stale` with the explicit,
 * preview-bound `gbrain repair content-receipt-root`, which rebinds only when
 * the owner's tree still hashes to the recorded worktree manifest and otherwise
 * refuses naming the mismatch and its exit.
 * Fails when: accept or set-path leaves a receipt on the old root, a failed
 * accept keeps a rebound receipt, doctor points at sync again, or the repair
 * rebinds without the tree evidence or touches anything but the receipt.
 * Why new: nothing covered the receipt across a topology change (#6892).
 * Seams: none (the run cases wrap the engine's transaction to inject a
 * run-scoped error mid-transaction).
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { noSuccessfulSync } from '../../src/commands/doctor/sync-outcome.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { claimWorktree, getWorktreeBinding, worktreeManifest } from '../../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { ownedContentFreshness } from '../../src/core/shared-skills/content-freshness.ts';
import { contentSetupKey } from '../../src/core/shared-skills/setup.ts';
import { failTransactionAt } from '../helpers/fail-transaction.ts';
import { reviewedWriterIntent } from '../helpers/writer-admin-intent.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, renderFix, runScopedErrors, snapshotItems } from './harness.ts';

const SLUGS = ['notes/alice-example', 'notes/acme-example'];
const OLD_ROOT = '/srv/old-host-example/content';

async function seed({ engine, root }: { engine: BrainEngine; root: string }, nested: boolean) {
  for (const slug of SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId: 'default' });
  writeFileSync(join(root, 'notes.md'), '# notes\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'nested.md'), '# nested\n');
  if (!nested) return;
  await claimWorktree(engine, 'default', root);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('nested','nested',$1)", [join(root, 'sub')]);
  await claimWorktree(engine, 'nested', join(root, 'sub'));
}

/** A complete, ready, owned content receipt for a source, naming `root` with the device/inode of `identityOf` (default: root itself). */
async function writeReceipt(engine: BrainEngine, sourceId: string, root: string, identity?: { device: number; inode: number }) {
  const [{ brain_id }] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const stat = identity ? null : statSync(root);
  await engine.setConfig(contentSetupKey(sourceId, incarnation), JSON.stringify({ version: 1, brain_id, source_id: sourceId, source_incarnation: incarnation, root,
    repository_kind: 'content_directory', backup: 'not_verified', status: 'ready', stage: 'complete', pending_actions: [], owned_root: true,
    root_identity: identity ?? { device: stat!.dev, inode: stat!.ino } }));
  return contentSetupKey(sourceId, incarnation);
}

async function receipt(engine: BrainEngine, sourceId: string) {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const raw = await engine.getConfig(contentSetupKey(sourceId, incarnation));
  return raw ? JSON.parse(raw) as { root: string; root_identity: { device: number; inode: number } } : null;
}

const identityOf = (path: string) => { const stat = statSync(path); return { device: stat.dev, inode: stat.ino }; };
const fresh = async (engine: BrainEngine) => (await ownedContentFreshness(engine)).map(row => row.sourceId).sort();

async function topology(engine: BrainEngine, sql: string, params: unknown[]) {
  await engine.transaction(async tx => { await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)"); await tx.executeRaw(sql, params); });
}

/** Copies the canonical content (not the ownership markers) to a successor directory. */
function successorOf(root: string, name: string): string {
  const next = join(root, '..', name);
  mkdirSync(join(next, 'sub'), { recursive: true });
  cpSync(join(root, 'notes.md'), join(next, 'notes.md'));
  cpSync(join(root, 'sub', 'nested.md'), join(next, 'sub', 'nested.md'));
  return realpathSync(next);
}

async function prepare(engine: BrainEngine) {
  return await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as { owner_epoch: string; manifest: { digest: string } };
}

async function accept(engine: BrainEngine, path: string, prepared: { owner_epoch: string; manifest: { digest: string } }, extra: Record<string, unknown> = {}) {
  return runPersistenceAdministration(engine, 'writer_transfer_accept', { source_id: 'default', path, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest,
    ...extra, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') });
}

const ctxOf = (engine: BrainEngine) => ({ engine, sourceId: 'default', remote: false as const, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } }) as never;

async function repairKind(engine: BrainEngine, opts: { apply: boolean; expect?: string }) {
  const { contentReceiptRootRepair } = await import('../../src/core/repair/content-receipt-root.ts');
  const { repairSpec } = await import('../../src/core/repair/registry.ts');
  return runRepair(ctxOf(engine), contentReceiptRootRepair, await resolveRepairScope(engine, 'default'),
    { ...opts, explicit: true, spec: repairSpec('content-receipt-root' as never), sourceFlag: 'default' });
}

const refusedFix = (result: { details?: Record<string, unknown> }) => renderFix((result.details?.refused as Array<{ fix?: unknown }> | undefined)?.[0]?.fix);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`C-7 content receipt follows the canonical root (${backend})`, () => {
    test('C-7 accept: a transfer rebinds every owned receipt on the worktree, nested included; set-path then makes the sources fresh', () => managedBrain(async ({ engine, root }) => {
      await writeReceipt(engine, 'default', root);
      await writeReceipt(engine, 'nested', join(root, 'sub'));
      expect(await fresh(engine)).toEqual(['default', 'nested']);
      const before = await snapshotItems(engine, 'default');
      const prepared = await prepare(engine);
      const successor = successorOf(root, 'successor');
      await expectUnitNotAborted(() => accept(engine, successor, prepared));
      expect({ default: await receipt(engine, 'default'), nested: await receipt(engine, 'nested') }).toMatchObject({
        default: { root: successor, root_identity: identityOf(successor) }, nested: { root: join(successor, 'sub'), root_identity: identityOf(join(successor, 'sub')) } });
      // Until set-path moves sources.local_path the receipt and the source disagree: doctor names the repair, whose preview names set-path.
      const never = await noSuccessfulSync(engine, 'default', "'default'", true);
      expectItemFailure({ key: never.entry.source_id, code: never.entry.code, fix: never.entry.fix }, { key: 'default', code: 'content_receipt_stale', fix: /^gbrain repair content-receipt-root --source default$/ });
      const preview = await repairKind(engine, { apply: false });
      expect(preview.listing).toEqual([expect.objectContaining({ item: 'default', class: 'source_path_mismatch' })]);
      expect(refusedFix(preview)).toBe(`gbrain sources set-path default ${successor}`);
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
    }, { setup: brain => seed(brain, true), databaseUrl }), 180_000);

    test('C-7 accept then set-path: a transferred content source is fresh again with no manual receipt edit', () => managedBrain(async ({ engine, root }) => {
      await writeReceipt(engine, 'default', root);
      const before = await snapshotItems(engine, 'default');
      const prepared = await prepare(engine);
      const successor = successorOf(root, 'successor');
      const accepted = await accept(engine, successor, prepared);
      expect(accepted.content_receipts).toEqual([expect.objectContaining({ source_id: 'default', from: root, to: successor })]);
      await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'default', path: successor });
      expect(await fresh(engine)).toEqual(['default']);
      expect((await repairKind(engine, { apply: false })).listing).toEqual([]);
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
    }, { setup: brain => seed(brain, false), databaseUrl }), 180_000);

    test('C-7 set-path: relocating a source on its host rebinds its receipt in the same lifecycle change', () => managedBrain(async ({ engine, root }) => {
      await writeReceipt(engine, 'default', root);
      const before = await snapshotItems(engine, 'default');
      const moved = successorOf(root, 'moved');
      await expectUnitNotAborted(() => runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'default', path: moved }));
      expect(await receipt(engine, 'default')).toMatchObject({ root: moved, root_identity: identityOf(moved) });
      expect(await fresh(engine)).toEqual(['default']);
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
    }, { setup: brain => seed(brain, false), databaseUrl }), 180_000);

    for (const { name, error } of runScopedErrors().filter(entry => entry.name !== 'owner_unavailable')) {
      test(`C-7 run: a run-scoped error (${name}) after the receipt rebind rolls the accept back, receipt included`, () => managedBrain(async ({ engine, root }) => {
        await writeReceipt(engine, 'default', root);
        const was = await receipt(engine, 'default');
        const prepared = await prepare(engine);
        const successor = successorOf(root, 'successor');
        const injected = error();
        const restore = failTransactionAt(engine, /SET owner_host_id=/, () => injected);
        try { await expect(accept(engine, successor, prepared)).rejects.toBe(injected); } finally { restore(); }
        expect(await receipt(engine, 'default')).toEqual(was);
        expect((await getWorktreeBinding(engine, 'default'))!).toMatchObject({ state: 'draining', local_path: realpathSync(root) });
      }, { setup: brain => seed(brain, false), databaseUrl }), 180_000);
    }

    test('C-7 stale: doctor names the repair; the preview rebinds when the tree hash matches; the apply clears it and nothing else changes', () => managedBrain(async ({ engine, root }) => {
      const key = await writeReceipt(engine, 'default', OLD_ROOT, { device: 1, inode: 2 });
      const { worktree_id } = (await getWorktreeBinding(engine, 'default'))!;
      await topology(engine, 'UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [worktree_id, JSON.stringify(worktreeManifest(root))]);
      expect(await fresh(engine)).toEqual([]);
      const never = await noSuccessfulSync(engine, 'default', "'default'", true);
      expectItemFailure({ key: never.entry.source_id, code: never.entry.code, fix: never.entry.fix }, { key: 'default', code: 'content_receipt_stale', fix: /^gbrain repair content-receipt-root --source default$/ });
      const before = await snapshotItems(engine, 'default');
      const configBefore = await engine.executeRaw<{ key: string; value: string }>("SELECT key,value FROM config WHERE key<>$1 ORDER BY key", [key]);
      const preview = await repairKind(engine, { apply: false });
      expect(preview.listing).toEqual([expect.objectContaining({ item: 'default', class: 'rebind' })]);
      expect(preview.apply_command).toContain(`--expect ${preview.preview_hash}`);
      expect(await receipt(engine, 'default')).toMatchObject({ root: OLD_ROOT });
      await expect(repairKind(engine, { apply: true, expect: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'preview_changed' });
      const injected = runScopedErrors()[0]!.error();
      const restore = failTransactionAt(engine, /UPDATE config SET value/, () => injected);
      try { await expect(repairKind(engine, { apply: true, expect: preview.preview_hash })).rejects.toBe(injected); } finally { restore(); }
      expect(await receipt(engine, 'default')).toMatchObject({ root: OLD_ROOT });
      const applied = await expectUnitNotAborted(() => repairKind(engine, { apply: true, expect: preview.preview_hash }));
      expect({ applied: applied.applied, failed: applied.failed }).toEqual({ applied: 1, failed: [] });
      expect(await receipt(engine, 'default')).toMatchObject({ root: realpathSync(root), root_identity: identityOf(root) });
      expect(await fresh(engine)).toEqual(['default']);
      const backup = JSON.parse((await engine.getConfig(`${key}.backup`))!);
      expect(JSON.parse(backup.previous)).toMatchObject({ root: OLD_ROOT, root_identity: { device: 1, inode: 2 } });
      expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
      expect(await engine.executeRaw<{ key: string; value: string }>("SELECT key,value FROM config WHERE key<>$1 AND key<>$2 ORDER BY key", [key, `${key}.backup`])).toEqual(configBefore);
      expect((await repairKind(engine, { apply: false })).listing).toEqual([]);
    }, { setup: brain => seed(brain, false), databaseUrl }), 180_000);

    test('C-7 recovery: a tree that no longer matches its manifest is refused naming both digests; a self-transfer re-verifies and rebinds it', () => managedBrain(async ({ engine, root }) => {
      await writeReceipt(engine, 'default', OLD_ROOT, { device: 1, inode: 2 });
      const { worktree_id } = (await getWorktreeBinding(engine, 'default'))!;
      const recorded = worktreeManifest(root);
      await topology(engine, 'UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [worktree_id, JSON.stringify(recorded)]);
      writeFileSync(join(root, 'later.md'), '# written after the manifest\n');
      const preview = await repairKind(engine, { apply: false });
      expect(preview.listing).toEqual([expect.objectContaining({ item: 'default', class: 'tree_mismatch' })]);
      expect(preview.listing![0]!.detail).toContain(recorded.digest);
      expect(preview.listing![0]!.detail).toContain(worktreeManifest(root).digest);
      expect(refusedFix(preview)).toStartWith('gbrain sources writer transfer prepare default --self-transfer');
      expect(await receipt(engine, 'default')).toMatchObject({ root: OLD_ROOT });
      const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare',
        { source_id: 'default', self_transfer: true, ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as { owner_epoch: string; manifest: { digest: string } };
      await accept(engine, realpathSync(root), prepared, { self_transfer: true });
      expect(await receipt(engine, 'default')).toMatchObject({ root: realpathSync(root), root_identity: identityOf(root) });
      expect(await fresh(engine)).toEqual(['default']);
    }, { setup: brain => seed(brain, false), databaseUrl }), 180_000);
  });
}
