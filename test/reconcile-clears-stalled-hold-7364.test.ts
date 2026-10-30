/**
 * #7364: a page write refused because its canonical file "is held by sync (preparation_stalled)" had no sanctioned way
 * out: `sources retry-held` reported no held files, `sources reconcile --apply` reconciled the page, and later writes still
 * named the hold. An out-of-attempts hold (`preparation_stalled`, `write_interrupted`) is about the write owner, not the
 * file, so a committed reconcile whose page and file now agree clears it; a file that still differs keeps it. The
 * refusal and `retry-held` both name the hold row they read, so a refusal naming a row the listing missed is visible.
 * Both explanations the report fits: a write refused before the hold cleared runs once it is retried, and a
 * formatting-only reconcile (the file's bytes still differ, its content agrees) clears the hold.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/frontmatter-recovery.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { readGitHold, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'notes/a', PATH = 'notes/a.md';
const PAGE = '---\ntype: concept\ntitle: a\n---\n\nA note about a.\n';
const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const setup = ({ root }: { root: string }) => {
  git(root, ['init', '-q']); mkdirSync(join(root, 'notes')); writeFileSync(join(root, PATH), PAGE);
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'pages']);
};

async function stalled(engine: BrainEngine): Promise<string> {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: PATH, source_path: PATH, slug: SLUG, page_id: null, code: 'preparation_stalled',
    message: 'The write owner stalled while preparing this file.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION } }));
  return `default:${incarnation}:${PATH}`;
}

const put = async (engine: BrainEngine, ctx: OperationContext, body: string) => operationsByName.put_page!.handler(ctx, { slug: SLUG, content: PAGE.replace('A note about a.', body),
  expected_revision: (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision, request_id: randomUUID() });

async function reconcile(engine: BrainEngine, requestId = randomUUID()) {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () => {
    const preview = await runReconcilePreview(engine, { source_id: 'default', slug: SLUG });
    expect(preview.status).toBe('ready');
    return { preview, applied: await runReconcileApply(engine, { source_id: 'default', slug: SLUG, preview: preview.preview, request_id: requestId }), requestId };
  });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`#7364 [${backend}]: a write refused for a stalled hold names its row; the reconcile that makes page and file agree clears it and the retried write runs`, () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
    const fingerprint = await stalled(engine);
    writeFileSync(join(root, PATH), PAGE.replace('title: a', 'title: a\nfile_field: kept'));
    const refused = await put(engine, ctx, 'An edited note.').then(() => null, error => error);
    expect(refused?.code).toBe('source_changed');
    const incarnation = fingerprint.split(':')[1]!;
    expect(refused.message).toContain('held by sync (preparation_stalled)');
    expect(refused.message).toContain(`Hold row: source default, incarnation ${incarnation}.`);
    expect(refused.suggestion).toContain(`read the sync-hold row of source default, incarnation ${incarnation}`);
    const listed = await retryHeld(engine, 'default', { dryRun: true });
    expect(listed.items.map(item => [item.code, item.fingerprint])).toEqual([['preparation_stalled', fingerprint]]);
    expect(listed.hold_rows).toEqual({ op: 'sync-hold', source_id: 'default', incarnation, read: 1 });

    const { applied, requestId } = await reconcile(engine);
    expect(applied.state).toBe('committed');
    expect(applied.cleared_hold).toEqual({ op: 'sync-hold', fingerprint, code: 'preparation_stalled' });
    expect(await readGitHold(engine, 'default', fingerprint.split(':')[1]!, PATH)).toBeNull();
    // The refused write's error predates the clearing: retried, it runs.
    expect(await put(engine, ctx, 'An edited note.')).toMatchObject({ state: 'committed' });

    // A replayed apply while the file differs again leaves a newer stalled hold in place, and the refusal names it.
    await stalled(engine);
    writeFileSync(join(root, PATH), readFileSync(join(root, PATH), 'utf8').replace('title: a', 'title: a\nother_field: kept'));
    const replayed = await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      runReconcileApply(engine, { source_id: 'default', slug: SLUG, preview: (await runReconcilePreview(engine, { source_id: 'default', slug: SLUG })).preview, request_id: requestId }).catch(error => error));
    expect(replayed.cleared_hold).toBeUndefined();
    expect(await readGitHold(engine, 'default', fingerprint.split(':')[1]!, PATH)).toMatchObject({ code: 'preparation_stalled' });
    expect(((await put(engine, ctx, 'Another note.').then(() => null, error => error))?.message)).toContain(`Hold row: source default, incarnation ${incarnation}.`);
  }, { databaseUrl, setup }), 120_000);

  test(`#7364 [${backend}]: a formatting-only reconcile (the bytes differ, the content agrees) clears the stalled hold`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
    const fingerprint = await stalled(engine);
    writeFileSync(join(root, PATH), PAGE.replace('A note about a.', 'A note about a.  ').replace('type: concept', 'type: "concept"'));
    const { preview, applied } = await reconcile(engine);
    expect(preview.formatting_only).toBe(true);
    expect(applied.state).toBe('committed');
    expect(applied.cleared_hold).toEqual({ op: 'sync-hold', fingerprint, code: 'preparation_stalled' });
    expect(await liveFileDrift(engine, 'default', SLUG)).toMatchObject({ still_present: false });
    expect(await readGitHold(engine, 'default', fingerprint.split(':')[1]!, PATH)).toBeNull();
  }, { databaseUrl, setup }), 120_000);
}
