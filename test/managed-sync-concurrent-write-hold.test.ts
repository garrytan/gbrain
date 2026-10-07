/**
 * #6194 (D4): a database-only write that commits to a page while managed sync imports a newer Git version of it
 * failed the import with `revision_conflict`, and that terminal receipt replayed on every later sync, so the
 * source stayed `blocked_by_failures`. A conflict proven to come from such a write (the live revision was written
 * by a committed non-sync request for the same page) is now a `concurrent_write` hold: the sync finishes, the
 * database version is kept, nothing is overwritten, and the hold points at `sources reconcile --preview`.
 * Without that proof (a revision no journal request wrote) the failure still blocks.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { waitFor } from './helpers/wait-for.ts';

const SLUG = 'people/alice-example';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (body: string) => `---\ntype: person\ntitle: Alice Example\n---\n\n${body}\n`;
async function storedPending(engine: BrainEngine): Promise<string | null> {
  const [row] = await engine.executeRaw<{ slug: string | null }>("SELECT completed_keys->0->'pending'->>'slug' AS slug FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'='default'");
  return row?.slug ?? null;
}

/** First sync imports the page; then Git gets a newer version and a database-only write races the next import. */
async function raced(engine: BrainEngine, root: string, write: () => Promise<unknown>) {
  expect(await performManagedSync(engine, { sourceId: 'default', noPull: true })).toMatchObject({ status: 'first_sync' });
  const before = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  writeFileSync(join(root, 'people', 'alice-example.md'), note('Works at acme-example; the Git edit.'));
  commit(root, 'git edit');
  let fired = false;
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:mid_checkpoint' || detail.sourceId !== 'default' || fired || await storedPending(engine) !== SLUG) return;
    fired = true;
    await write();
  });
  try {
    const first = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(fired).toBe(true);
    return { first, before: before! };
  } finally { installFaultHook(undefined); }
}

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#6194 concurrent write during import (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'people'), { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, 'people', 'alice-example.md'), note('Works at acme-example.'));
    commit(root, 'notes');
  };

  test('a proven concurrent database-only write becomes a concurrent_write hold; the sync finishes and nothing is overwritten', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    let requestId = '';
    const { first } = await raced(engine, root, async () => {
      requestId = randomUUID();
      const current = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
      await submitPageMutation(ctx as OperationContext, { operation: 'put_page', params: { slug: SLUG, request_id: requestId, expected_revision: current!.revision,
        content: note('Works at acme-example; the database-only edit.') } });
      await waitFor(async () => (await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE request_id=$1::uuid", [requestId]))[0]?.state === 'committed',
        { timeoutMs: 20_000, label: 'the database-only put_page commits' });
    });
    expect(first.status).not.toBe('blocked_by_failures');
    expect(first.held?.map(hold => ({ path: hold.path, code: hold.code }))).toEqual([{ path: 'people/alice-example.md', code: 'concurrent_write' }]);
    const item = first.held![0]!;
    expect(item.fix.argv).toEqual(['gbrain', 'sources', 'reconcile', 'default', SLUG, '--preview']);
    expect(item.fix.why).toContain(requestId);
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))?.compiled_truth).toContain('the database-only edit');
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'");
    const record = await readGitHold(engine, 'default', source!.incarnation, 'people/alice-example.md');
    expect(record).toMatchObject({ code: 'concurrent_write', meta: { competing_request_id: requestId, competing_operation: 'put_page' } });
    const [summary] = await engine.executeRaw<{ concurrent: number }>("SELECT (completed_keys->0->>'concurrent')::int AS concurrent FROM op_checkpoints WHERE op='sync-hold-summary' AND fingerprint=$1", [`default:${source!.incarnation}`]);
    expect(summary?.concurrent).toBe(1);
    // The next sync does not replay a failure: the file stays held and the page keeps the database version.
    const again = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(again.status).not.toBe('blocked_by_failures');
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))?.compiled_truth).toContain('the database-only edit');
  }, { databaseUrl, setup }), 120_000);

  test('a database-only delete of the page during the import is held the same way and stays deleted', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    let requestId = '';
    const { first } = await raced(engine, root, async () => {
      requestId = randomUUID();
      const current = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
      await submitPageMutation(ctx as OperationContext, { operation: 'delete_page', params: { slug: SLUG, request_id: requestId, expected_revision: current!.revision } });
      await waitFor(async () => (await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE request_id=$1::uuid", [requestId]))[0]?.state === 'committed',
        { timeoutMs: 20_000, label: 'the database-only delete_page commits' });
    });
    expect(first.held?.map(hold => hold.code)).toEqual(['concurrent_write']);
    expect(first.held![0]!.fix.why).toContain(requestId);
    expect(await engine.getPage(SLUG, { sourceId: 'default' })).toBeNull();
  }, { databaseUrl, setup }), 120_000);

  test('a revision conflict no journal request explains keeps blocking', () => managedBrain(async ({ engine, root }) => {
    const { first } = await raced(engine, root, () => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.putPage(SLUG, {
      type: 'person', title: 'Alice Example', compiled_truth: 'An unattributed database edit.', timeline: '', frontmatter: {}, content_hash: 'unattributed',
    }, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION)));
    expect(first).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'revision_conflict', count: 1 }] });
    expect(first.held ?? []).toEqual([]);
    expect(first.managedWrite?.suggestion).toContain(`gbrain sources reconcile default ${SLUG} --preview`);
  }, { databaseUrl, setup }), 120_000);
});
