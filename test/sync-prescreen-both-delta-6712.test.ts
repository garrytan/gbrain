/**
 * #6712: an incremental managed sync whose Git delta changed a file must not publish it over a database-only edit of
 * the same page. Before the fix, `classifyBaseline` guarded the both-moved case only in a tree walk, so a plain delta
 * sync imported the committed edit over a `put_page` written with write-through off: no `file_drift` hold, no backup.
 *
 * Protects:
 * - both moved, delta sync: the page keeps the database edit and the file is held `file_drift` (side `both`);
 * - control: a file-only edit still imports on a delta sync with no hold;
 * - control: a database-only change an import keeps (a tag) is not guarded: the page still holds what the recorded disk
 *   blob imports (sync-run.ts `sameContentAtOrigin`, `pageOnly`), so the committed edit imports and the tag stays;
 * - control: a page whose current revision write-through wrote to its file is not guarded (`fileBackedRevisions`), so the
 *   committed file edit imports.
 *
 * The first test fails on the base (the page loses the edit and no hold is written). PGLite always; Postgres too when
 * DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['notes/a', 'notes/b']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  commit(root, 'notes');
};
const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'"))[0]!.incarnation;
const holdOf = async (engine: BrainEngine, path: string) => readGitHold(engine, 'default', await incarnationOf(engine), path);
const bodyOf = async (engine: BrainEngine, slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '';
async function putPage(engine: BrainEngine, ctx: OperationContext, slug: string, body: string): Promise<void> {
  const snap = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const requestId = randomUUID();
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: snap.revision, content: note(slug, body) } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed', { timeoutMs: 30_000 });
}

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#6712 delta drift guard (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('a delta sync holds a committed file edit over a database-only put_page instead of publishing it', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    await putPage(engine, ctx, 'notes/a', 'DBONLYMARKER agent edit.');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'The second committed body.'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A file-only edit.'));
    commit(root, 'edit a and b');
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('DBONLYMARKER');
    const hold = await holdOf(engine, 'notes/a.md');
    expect(hold?.code).toBe('file_drift');
    expect(await bodyOf(engine, 'notes/b')).toContain('A file-only edit.');
    expect(await holdOf(engine, 'notes/b.md')).toBeNull();
  }, { setup, databaseUrl }), 120_000);

  test('a database-only tag does not guard the page: the committed edit imports and keeps the tag', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.addTag('notes/a', 'kept-in-brain', { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'The second committed body.'));
    commit(root, 'edit a');
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('The second committed body.');
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))?.tags).toContain('kept-in-brain');
    expect(await holdOf(engine, 'notes/a.md')).toBeNull();
  }, { setup, databaseUrl }), 120_000);

  test('a page whose revision write-through wrote to its file is not guarded: the committed edit imports', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await putPage(engine, ctx, 'notes/a', 'A write-through edit.');
    commit(root, 'write-through publication');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A later committed body.'));
    commit(root, 'edit a');
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('A later committed body.');
    expect(await holdOf(engine, 'notes/a.md')).toBeNull();
  }, { setup, databaseUrl }), 120_000);
});
