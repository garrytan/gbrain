import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

interface Fixture { engine: BrainEngine; sourceId: string; path: string; original: string; pageId: number;
  binding: Awaited<ReturnType<typeof claimWorktree>>; }
const slug = 'notes/withdrawal-file-race';
const engines: BrainEngine[] = [];
const fixtures: Fixture[] = [];
const roots: string[] = [];
// prepareFileTarget resolves the canonical worktree through this host's identity.
let hostId: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  hostId = localHostId();
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    // Repo topology is fixed before activation; later changes need writer administration.
    const sourceId = `withdrawal-file-race-${engine.kind}`;
    const root = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-file-')); roots.push(root);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const binding = await claimWorktree(engine, sourceId, root, hostId);
    const page = await engine.putPage(slug, { type: 'note', title: 'Withdrawal file race', compiled_truth: 'Original body.' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [`${slug}.md`, sourceId, slug]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`), original = serializePageToMarkdown(snapshot.page, snapshot.tags);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, original);
    fixtures.push({ engine, sourceId, path, original, pageId: page.id, binding });
    await registerLocalWriter(engine, 'cli');
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}, 60_000);

test('a prepared repo-file write racing a withdrawal leaves the canonical file and page unchanged', async () => {
  for (const { engine, sourceId, path, original, pageId, binding } of fixtures) {
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(readFileSync(path, 'utf8')).toBe(original);

    const claim = 'withdrawn between file preparation and publication';
    const fence = renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world',
      notability: 'medium', active: true, context: 'test evidence' }]);
    const content = `---\ntitle: Withdrawal file race\ntype: note\n---\nFacts: ${fence}\n`;
    const context: OperationContext = { engine, sourceId, remote: false, dryRun: false,
      config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
    const authority = await submissionAuthority(context, 'put_page', sourceId, binding.source_incarnation, slug);
    await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId,
      sourceIncarnation: binding.source_incarnation, slug, pageId, requestId: randomUUID(),
      callerIntent: { slug, content, expected_revision: before.revision },
      intent: { slug, content, expected_revision: before.revision }, authority,
      worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const claimed = (await claimNextWrite(engine, hostId))!;
    const prepared = await preparePageMutation(engine, claimed, { engine: engine.kind });
    expect(prepared.file?.path).toBe(path);
    expect(prepared.file?.content).toContain(claim);

    const fact = await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
      tx.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: sourceId })));
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => recordFactWithdrawal(tx, fact.id, sourceId, true)));

    // Refusal must precede publication, not rely on the apply-time recheck and file rollback.
    const boundaries: string[] = [];
    const rejected = await publishMutation(engine, claimed, prepared, hostId, {
      boundary: async name => { boundaries.push(name); }, fileBoundary: name => { boundaries.push(name); } });

    expect(rejected).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
    expect(boundaries).not.toContain('before_publication');
    expect(boundaries).not.toContain('before_file');
    expect(readFileSync(path, 'utf8')).toBe(original);
    const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(after.revision).toBe(before.revision);
    expect(after.page.compiled_truth).toBe('Original body.');
  }
}, 120_000);
