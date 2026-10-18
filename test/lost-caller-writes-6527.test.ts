/**
 * #6527: doctor `lost_caller_writes` counted every retained refused caller
 * write, while `gbrain repair failed-writes` (the command it names) keeps an
 * unpinned `remember` and a `put_page` whose page moved past the revision the
 * caller read out of its replay set. The count now leaves those two
 * SQL-decidable classes out and reports them under `not_replayable`, so the
 * count equals what the preview offers to replay; and the doctor text says the
 * preview records an approval checkpoint instead of calling it read-only.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { lostCallerWrites, failedWritesRepair } from '../src/core/repair/failed-writes.ts';
import { lostCallerWritesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

const gitRoot = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

async function replaySet(engine: Parameters<typeof lostCallerWrites>[0]) {
  const [{ brain_id }] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  return failedWritesRepair.plan(engine, { brain_id, source_ids: ['default'] }, null, { apply: false });
}

for (const entitySlug of ['absent', 'null'] as const) {
  test(`#6527 an unpinned remember (entity_slug ${entitySlug}) is not counted as lost; it is reported not_replayable`, () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'people/owner-example';
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: person\ntitle: Owner\n---\n\nBody.\n' } });
    const file = join(root, `${slug}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Body.', 'Body.\n\nLocal edit.'));
    await submitRememberMutation(ctx, { fact: 'Owner prefers async updates', entity: slug, provenance: 'test', visibility: 'world' }).catch(() => null);
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(entitySlug === 'absent' ? "UPDATE persistence_requests SET intent = intent - 'entity_slug' WHERE operation='remember'"
        : "UPDATE persistence_requests SET intent = jsonb_set(intent, '{entity_slug}', 'null'::jsonb) WHERE operation='remember'");
    });
    const result = await lostCallerWrites(engine, ['default']);
    const plan = await replaySet(engine);
    expect(plan.residuals).toEqual({ unpinned_target: 1 });
    expect(result.lost.reduce((n, row) => n + row.count, 0)).toBe(plan.items.length);
    expect(result.not_replayable).toEqual({ unpinned_target: 1, revision_superseded: 0 });
    const check = await lostCallerWritesCheck(engine, ['default']);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('1 refused caller write(s) cannot be replayed');
  }, { setup: gitRoot }), 120_000);
}

test('#6527 a put_page bound to a revision the page has since moved past is not counted as lost', () => managedBrain(async ({ engine, ctx, root }) => {
  const slug = 'notes/revision-example';
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: note\ntitle: Example\n---\n\nFirst.\n' } });
  const read = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const file = join(root, `${slug}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('First.', 'First.\n\nLocal edit.'));
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: read.revision,
    content: '---\ntype: note\ntitle: Example\n---\n\nCaller edit.\n' } }).catch(() => null);
  const [refused] = await engine.executeRaw<{ state: string; error_code: string }>(
    "SELECT state, error_code FROM persistence_requests WHERE operation='put_page' ORDER BY sequence DESC LIMIT 1");
  expect(refused).toEqual({ state: 'conflict', error_code: 'source_changed' });
  expect((await lostCallerWrites(engine, ['default'])).lost.reduce((n, row) => n + row.count, 0)).toBe(1);
  // The page moves on outside the journal (a sync import of the edited file would do the same).
  await engine.transaction(async tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.executeRaw("UPDATE pages SET compiled_truth=compiled_truth||'\n\nMoved on.' WHERE source_id='default' AND slug=$1", [slug]);
  }, await maintenanceAttribution(tx)));
  const result = await lostCallerWrites(engine, ['default']);
  const plan = await replaySet(engine);
  expect(plan.items.length).toBe(0);
  expect(result.lost.reduce((n, row) => n + row.count, 0)).toBe(0);
  expect(result.not_replayable).toEqual({ unpinned_target: 0, revision_superseded: 1 });
}, { setup: gitRoot }), 120_000);

test('#6527 doctor says the preview records an approval checkpoint, not that it is read-only', () => managedBrain(async ({ engine, ctx, root }) => {
  const slug = 'people/owner-example';
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: person\ntitle: Owner\n---\n\nBody.\n' } });
  const file = join(root, `${slug}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Body.', 'Body.\n\nLocal edit.'));
  await submitRememberMutation(ctx, { fact: 'Owner prefers async updates', entity: slug, provenance: 'test', visibility: 'world' }).catch(() => null);
  const check = await lostCallerWritesCheck(engine, ['default']);
  expect(check.status).toBe('warn');
  expect(check.fix?.why).not.toContain('Read-only');
  expect(check.fix?.why).toContain('approval checkpoint');
  const plan = await replaySet(engine);
  expect(plan.items.length).toBe(1);
  expect(plan.warnings?.join(' ')).toContain('recorded an approval checkpoint');
  expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='repair-approval'"))[0]!.n).toBe(1);
}, { setup: gitRoot }), 120_000);
