/**
 * #6693 (D7): a remember onto a page whose canonical file holds a committed Git change managed sync has not imported
 * yet (another agent's commit) is refused `pending_import`, kept, and replayed once by the sync that imports the file.
 * Managed PGLite brain with a durable Git repo, no providers.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performSync } from '../src/commands/sync.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { lostCallerWrites, replayImportedRemembers } from '../src/core/repair/failed-writes.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';

const slug = 'people/owner-example';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const file = (root: string) => join(root, `${slug}.md`);
const edit = (root: string, line: string) => writeFileSync(file(root), readFileSync(file(root), 'utf8').replace('Body.', `Body.\n\n${line}`));

async function seed(ctx: OperationContext) {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: '---\ntype: person\ntitle: Owner\n---\n\nBody.\n' } });
}
async function refused(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { return error as { code?: string; reason?: string; message?: string; fix?: { actor?: string; argv?: string[] } }; }
  throw new Error('the write was expected to be refused');
}
const lastReceipt = async (engine: BrainEngine, operation: string) => (await engine.executeRaw<{ state: string; error_code: string; error_detail: { origin?: string } | null }>(
  'SELECT state,error_code,error_detail FROM persistence_requests WHERE operation=$1 ORDER BY sequence DESC LIMIT 1', [operation]))[0];
const sync = (engine: BrainEngine, root: string) => performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
const claims = async (engine: BrainEngine) => (await engine.executeRaw<{ fact: string; row_num: number | null }>(
  "SELECT fact,row_num FROM facts WHERE source_id='default' AND entity_slug=$1 AND expired_at IS NULL ORDER BY id", [slug]));

describe('#6693 remember onto a page whose file awaits import', () => {
  test('is refused pending_import, kept, and replayed once by the sync that imports the file', () => managedBrain(async ({ engine, ctx, root }) => {
    await seed(ctx);
    edit(root, 'Another agent added this line through Git.');
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent commit not yet imported');

    const error = await refused(() => submitRememberMutation(ctx, { fact: 'Owner prefers async updates', entity: slug, provenance: 'test', visibility: 'world',
      valid_from: '2026-09-01T00:00:00.000Z' }));
    expect(error.code).toBe('source_changed');
    expect(error.reason).toBe('pending_import');
    expect(error.message).toBe('The canonical file holds a committed Git change that sync has not imported yet.');
    // A remember waits for its replay: a status read under a provider actor renders `next: wait`.
    expect(error.fix?.actor).toBe('provider');
    expect(error.fix?.argv).toEqual(['gbrain', 'sync', 'status', '--source', 'default', '--json']);
    const receipt = await lastReceipt(engine, 'remember');
    expect(receipt.state).toBe('conflict');
    expect(receipt.error_detail?.origin).toBe('pending_import');
    // Before the import, a direct pass replays nothing and admits nothing.
    expect(await replayImportedRemembers(ctx, 'default')).toMatchObject({ examined: 1, replayed: 0, waiting: 1 });
    expect((await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE operation=$1', ['remember'])).length).toBe(1);

    const result = await sync(engine, root);
    expect(result.replayedRemembers).toMatchObject({ examined: 1, replayed: 1, waiting: 0 });
    const content = readFileSync(file(root), 'utf8');
    expect(content).toContain('Another agent added this line through Git.');
    expect(parseFactsFence(content).facts.map(f => [f.claim, f.validFrom])).toEqual([['Owner prefers async updates', '2026-09-01']]);
    expect((await claims(engine)).map(row => [row.fact, Number(row.row_num)])).toEqual([['Owner prefers async updates', 1]]);
    expect((await lostCallerWrites(engine, ['default'])).lost).toEqual([]);

    // The next sync finds the receipt settled and replays nothing again.
    expect((await sync(engine, root)).replayedRemembers).toBeUndefined();
    expect(await claims(engine)).toHaveLength(1);
  }, { setup }), 120_000);

  test('two concurrent passes admit one replay', () => managedBrain(async ({ engine, ctx, root }) => {
    await seed(ctx);
    const original = readFileSync(file(root), 'utf8');
    edit(root, 'Committed elsewhere.');
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent commit');
    await refused(() => submitRememberMutation(ctx, { fact: 'Owner reads email at noon', entity: slug, provenance: 'test', visibility: 'world' }));
    // The other agent takes its change back: the file matches the page again without a sync, so both passes see a replayable write.
    writeFileSync(file(root), original);
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent takes it back');
    const reports = await Promise.all([replayImportedRemembers(ctx, 'default'), replayImportedRemembers(ctx, 'default')]);
    expect(reports.reduce((sum, r) => sum + r.replayed, 0)).toBeGreaterThanOrEqual(1);
    expect((await claims(engine)).map(row => row.fact)).toEqual(['Owner reads email at noon']);
    expect((await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE operation='remember' AND state='committed'")).length).toBe(1);
  }, { setup }), 120_000);

  test('a remember refused by a sync-held file is replayed after the repaired file is imported', () => managedBrain(async ({ engine, ctx, root }) => {
    await seed(ctx);
    writeFileSync(file(root), '---\ntype: person\ntitle: [unclosed\n---\n\nBody.\n');
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'broken frontmatter');
    await sync(engine, root);
    const error = await refused(() => submitRememberMutation(ctx, { fact: 'Owner prefers mornings', entity: slug, provenance: 'test', visibility: 'world' }));
    expect(error.code).toBe('source_changed');
    expect((await lastReceipt(engine, 'remember')).error_detail?.origin).toBe('sync_held');
    writeFileSync(file(root), '---\ntype: person\ntitle: Owner\n---\n\nBody.\n\nRepaired.\n');
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'repair frontmatter');
    expect((await sync(engine, root)).replayedRemembers).toMatchObject({ replayed: 1 });
    expect((await claims(engine)).map(row => row.fact)).toEqual(['Owner prefers mornings']);
    expect(readFileSync(file(root), 'utf8')).toContain('Repaired.');
  }, { setup }), 120_000);

  test('an uncommitted hand edit keeps the reconcile refusal and is never replayed', () => managedBrain(async ({ engine, ctx, root }) => {
    await seed(ctx);
    edit(root, 'A hand edit nobody committed.');
    const error = await refused(() => submitRememberMutation(ctx, { fact: 'Owner likes tea', entity: slug, provenance: 'test', visibility: 'world' }));
    expect(error.code).toBe('source_changed');
    expect(error.reason).toBeUndefined();
    expect(error.message).toBe('The canonical file contains an uncoordinated local edit.');
    expect((await lastReceipt(engine, 'remember')).error_detail).toBeNull();
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'commit the hand edit later');
    expect((await sync(engine, root)).replayedRemembers).toBeUndefined();
    expect(await claims(engine)).toEqual([]);
  }, { setup }), 120_000);

  test('a put_page refused the same way is classified but not replayed', () => managedBrain(async ({ engine, ctx, root }) => {
    await seed(ctx);
    edit(root, 'Committed by another agent.');
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent commit');
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const error = await refused(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: revision,
      content: '---\ntype: person\ntitle: Owner\n---\n\nReplaced body.\n' } }));
    expect(error.reason).toBe('pending_import');
    expect(error.fix?.argv).toEqual(['gbrain', 'sync', '--source', 'default', '--no-pull', '--json']);
    expect((await lastReceipt(engine, 'put_page')).error_detail?.origin).toBe('pending_import');
    expect((await sync(engine, root)).replayedRemembers).toBeUndefined();
    expect(readFileSync(file(root), 'utf8')).toContain('Committed by another agent.');
    expect(readFileSync(file(root), 'utf8')).not.toContain('Replaced body.');
  }, { setup }), 120_000);
});
