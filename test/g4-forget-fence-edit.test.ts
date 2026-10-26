/**
 * GBRA-190 G4: forget is a fence edit, and the withdrawal ledger is derived from Git.
 *   - A withdrawal that strikes several pages is one coordinated publication: every struck file lands in one door commit
 *     on a strict source, before the ledger row and expiries commit, and no withdrawal-mirror effect is queued (D2).
 *   - Interrupted before its commit, recovery restores every file of its version 3 record and the replay commits once;
 *     interrupted after it, the committed files are kept and the replay completes against them.
 *   - Remember linking a fact saved without an entity strikes its memory/unattributed row in the same commit (D3).
 *   - A trusted local import of a withdrawal marker records its ledger row, so a brain rebuilt from Git keeps the
 *     withdrawal; subject '*' only for memory/unattributed rows, the page's slug otherwise. A remote page write carrying
 *     the marker records no ledger row and blocks no remember (D1).
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { isFactWithdrawn } from '../src/core/facts/withdrawal.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const CLAIM = 'Keeps a rooftop beehive g4claim';
const OTHER = 'Moved the hives indoors g4other';
const today = new Date().toISOString().slice(0, 10);
const fence = (rows: string[]) => ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|', ...rows, '<!--- gbrain:facts:end -->'].join('\n');
const note = (title: string, rows: string[], type = 'note') => `---\ntype: ${type}\ntitle: ${title}\n---\n\nNotes.\n\n## Facts\n\n${fence(rows)}\n`;
/** notes/a holds CLAIM as a row superseded by OTHER: no active entity-linked copy, so forgetting the unlinked copy is allowed. */
const SUPERSEDED = [`| 1 | ~~${CLAIM}~~ | fact | 1.0 | world | medium | 2026-01-01 | 2026-02-01 | test | superseded by #2 |`,
  `| 2 | ${OTHER} | fact | 1.0 | world | medium | 2026-02-01 |  | test |  |`];
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>;
const interruption = (code: string) => Object.assign(new Error(`database interruption ${code}`), { code });
const commitsTouching = (root: string, rel: string) => git(root, 'log', '--format=%H', '--', rel).split('\n').filter(Boolean);
const ledger = async (engine: BrainEngine, claim: string) => (await engine.executeRaw<{ subject: string }>(
  `SELECT subject FROM fact_withdrawals WHERE source_id='default' AND fact_hash=gbrain_fact_fingerprint($1) ORDER BY subject`, [claim])).map(row => row.subject);
const unlinkedFactId = async (engine: BrainEngine) => (await engine.executeRaw<{ id: number }>(
  `SELECT id FROM facts WHERE source_id='default' AND entity_slug IS NULL AND fact=$1 AND expired_at IS NULL`, [CLAIM]))[0]?.id;

/** notes/a (CLAIM superseded) and CLAIM remembered without an entity (a row of memory/unattributed). Returns that fact's id. */
async function twoPagesCarryingTheClaim(ctx: OperationContext, engine: BrainEngine): Promise<number> {
  expect(await call(ctx, 'put_page', { slug: 'notes/a', content: note('A', SUPERSEDED) })).toMatchObject({ state: 'committed' });
  expect(await call(ctx, 'remember', { fact: CLAIM, provenance: 'test', visibility: 'world', infer_entity: false })).toMatchObject({ state: 'committed', entity_slug: null });
  const id = await unlinkedFactId(engine);
  expect(id).toBeDefined();
  return Number(id);
}

for (const backend of testBackends()) describe(`[${backend}] G4: forget is a fence edit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a withdrawal that strikes two pages lands in one door commit, before its ledger row; no mirror is queued', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const id = await twoPagesCarryingTheClaim(ctx, engine);
    const requestId = randomUUID();
    const seen: { files?: string[]; ledger?: number } = {};
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:before_commit' || detail.requestId !== requestId) return;
      seen.files = git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    });
    try {
      const done = await call(ctx, 'forget', { id: String(id), request_id: requestId });
      expect(done).toMatchObject({ state: 'committed', expired: true });
      expect(done.persistence).toMatchObject({ git_state: 'committed' });
      // The commit holding both struck files existed inside the publication transaction, before the row.
      expect(seen.files).toEqual(['memory/unattributed.md', 'notes/a.md']);
      expect(done.persistence.git_commit).toBe(git(root, 'rev-parse', 'HEAD').trim());
    } finally { installFaultHook(undefined); }
    for (const rel of ['memory/unattributed.md', 'notes/a.md']) {
      const text = readFileSync(join(root, rel), 'utf8');
      expect(text).toContain(`~~${CLAIM}~~`);
      expect(text).toContain('forgotten:');
      expect(git(root, 'status', '--porcelain', '--', rel)).toBe('');
    }
    expect(commitsTouching(root, 'notes/a.md')[0]).toBe(commitsTouching(root, 'memory/unattributed.md')[0]);
    expect(await ledger(engine, CLAIM)).toEqual(['*']);
    const [request] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(await engine.executeRaw(`SELECT kind FROM persistence_effects WHERE request_id=$1::uuid AND kind='withdrawal-mirror'`, [request!.id])).toHaveLength(0);
  }, { databaseUrl, setup }), 180_000);

  test('interrupted before its commit, recovery restores both files of its version 3 record and the replay commits once', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const id = await twoPagesCarryingTheClaim(ctx, engine);
    const before = { a: commitsTouching(root, 'notes/a.md').length, m: commitsTouching(root, 'memory/unattributed.md').length };
    const requestId = randomUUID();
    const at: { record?: { version?: number; files?: unknown[] }; restored?: string[] } = {};
    let thrown = 0;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      // The record is durable before any file is written (read outside the publication transaction).
      if (point === 'publication:prepared' && !thrown && !at.record) {
        at.record = (await engine.executeRaw<{ recovery: { version: number; files: unknown[] } }>('SELECT recovery FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!.recovery;
      }
      if (point === 'publication:after_publication' && !thrown) { thrown++; throw interruption('CONNECTION_CLOSED'); }
      if (point === 'publication:prepared' && thrown && !at.restored) at.restored = ['notes/a.md', 'memory/unattributed.md'].map(rel => readFileSync(join(root, rel), 'utf8'));
    });
    try {
      expect(await call(ctx, 'forget', { id: String(id), request_id: requestId })).toMatchObject({ state: 'committed' });
    } finally { installFaultHook(undefined); }
    expect(thrown).toBe(1);
    expect(at.record).toMatchObject({ version: 3, target: 'pages' });
    expect(at.record!.files).toHaveLength(2);
    // The retry prepared against the restored prior bytes of both files.
    for (const text of at.restored!) expect(text).not.toContain('forgotten:');
    expect(commitsTouching(root, 'notes/a.md')).toHaveLength(before.a + 1);
    expect(commitsTouching(root, 'memory/unattributed.md')).toHaveLength(before.m + 1);
    expect(commitsTouching(root, 'notes/a.md')[0]).toBe(commitsTouching(root, 'memory/unattributed.md')[0]);
    expect(git(root, 'show', 'HEAD:notes/a.md')).toContain('forgotten:');
    expect(await ledger(engine, CLAIM)).toEqual(['*']);
  }, { databaseUrl, setup }), 180_000);

  test('interrupted after its commit, the committed files are kept and the replay completes against that one commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const id = await twoPagesCarryingTheClaim(ctx, engine);
    const requestId = randomUUID();
    let crash = '';
    installFaultHook(async (point, detail) => {
      if (point === 'publication:before_commit' && detail.requestId === requestId && !crash) { crash = git(root, 'rev-parse', 'HEAD').trim(); throw interruption('CONNECTION_CLOSED'); }
    });
    try {
      expect(await call(ctx, 'forget', { id: String(id), request_id: requestId })).toMatchObject({ state: 'committed' });
    } finally { installFaultHook(undefined); }
    expect(crash).not.toBe('');
    expect(commitsTouching(root, 'notes/a.md')[0]).toBe(crash);
    expect(commitsTouching(root, 'memory/unattributed.md')[0]).toBe(crash);
    const [receipt] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(receipt!.outcome.persistence).toMatchObject({ git_commit: crash });
    expect(await ledger(engine, CLAIM)).toEqual(['*']);
  }, { databaseUrl, setup }), 180_000);

  test('remember linking a fact saved without an entity strikes its memory/unattributed row in the same commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    expect(await call(ctx, 'put_page', { slug: 'people/alice-example', content: '---\ntype: person\ntitle: Alice Example\n---\n\nFictional.\n' })).toMatchObject({ state: 'committed' });
    const unlinked = await call(ctx, 'remember', { fact: CLAIM, provenance: 'test', visibility: 'world', infer_entity: false });
    const linked = await call(ctx, 'remember', { fact: CLAIM, provenance: 'test', visibility: 'world', entity: 'people/alice-example' });
    expect(linked).toMatchObject({ state: 'committed', status: 'superseded', superseded_fact_id: unlinked.id });
    const head = git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    expect(head).toEqual(['memory/unattributed.md', 'people/alice-example.md']);
    const unattributed = readFileSync(join(root, 'memory/unattributed.md'), 'utf8');
    expect(unattributed).toContain(`~~${CLAIM}~~`);
    expect(unattributed).toContain('linked to people/alice-example');
    expect(readFileSync(join(root, 'people/alice-example.md'), 'utf8')).toContain(`| ${CLAIM} |`);
    // A re-import of the struck row keeps the old fact retired and records no withdrawal.
    expect((await engine.executeRaw<{ active: boolean }>('SELECT expired_at IS NULL AS active FROM facts WHERE id=$1', [Number(unlinked.id)]))[0]!.active).toBe(false);
    expect(await ledger(engine, CLAIM)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('a brain rebuilt from Git keeps the withdrawal: the local import derives the ledger from the markers', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'gbrain-g4-rebuild-'));
    try {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await twoPagesCarryingTheClaim(ctx, engine);
        expect(await call(ctx, 'forget', { id: String(id) })).toMatchObject({ state: 'committed' });
        const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
        await settleManagedGitEffects(engine);
        expect(git(root, 'status', '--porcelain')).toBe('');
        execFileSync('git', ['clone', '-q', root, join(copy, 'repo')]);
      }, { databaseUrl, setup });
      await managedBrain(async ({ engine, ctx }) => {
        expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
        // memory/unattributed rows are withdrawn for every subject; a page's own marker for that page's subject.
        expect(await ledger(engine, CLAIM)).toEqual(['*', 'notes/a']);
        expect(await isFactWithdrawn(engine, 'default', 'world', CLAIM, null)).toBe(true);
        const again = await call(ctx, 'remember', { fact: CLAIM, provenance: 'test', visibility: 'world', infer_entity: false }).catch((error: { code?: string; message?: string }) => error);
        expect(String((again as { message?: string }).message)).toContain('fact_withdrawn');
      }, { databaseUrl, setup: ({ root }) => { rmSync(root, { recursive: true, force: true }); execFileSync('git', ['clone', '-q', join(copy, 'repo'), root]); } });
    } finally { rmSync(copy, { recursive: true, force: true }); }
  }, 240_000);

  test('a local page write of a withdrawal marker records it under the page; a remote one records nothing and blocks no remember', () => managedBrain(async ({ engine, ctx }) => {
    const marked = (claim: string) => [`| 1 | ~~${claim}~~ | fact | 1.0 | world | medium | 2026-01-01 | ${today} | test | forgotten: no longer true |`];
    const clientId = `client-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','example-client','read write','default')`, [clientId]);
    const remote = { ...ctx, remote: true, transport: 'http', auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'], sourceId: 'default' } } as OperationContext;
    const REMOTE = 'Remote marker claim g4remote', LOCAL = 'Local marker claim g4local';
    expect(await call(remote, 'put_page', { slug: 'notes/remote', content: note('Remote', marked(REMOTE)) })).toMatchObject({ state: 'committed' });
    expect(await ledger(engine, REMOTE)).toEqual([]);
    expect((await engine.executeRaw<{ active: boolean }>(`SELECT expired_at IS NULL AS active FROM facts WHERE source_id='default' AND fact=$1`, [REMOTE]))[0]!.active).toBe(false);
    expect(await call(ctx, 'remember', { fact: REMOTE, provenance: 'test', visibility: 'world', entity: 'notes/remote' })).toMatchObject({ state: 'committed' });
    expect(await call(ctx, 'put_page', { slug: 'notes/local', content: note('Local', marked(LOCAL)) })).toMatchObject({ state: 'committed' });
    expect(await ledger(engine, LOCAL)).toEqual(['notes/local']);
    const refused = await call(ctx, 'remember', { fact: LOCAL, provenance: 'test', visibility: 'world', entity: 'notes/local' }).catch((error: { message?: string }) => error);
    expect(String((refused as { message?: string }).message)).toContain('fact_withdrawn');
    // A struck, forgotten row without its valid_until date is not the marker forget writes: no ledger row, so the next
    // import's withdrawal overlay never dates the row and the stored body stays the file's.
    const UNDATED = 'Undated marker claim g4undated';
    const undated = note('Undated', [`| 1 | ~~${UNDATED}~~ | fact | 1.0 | world | medium | 2026-01-01 |  | test | forgotten: no longer true |`]);
    expect(await call(ctx, 'put_page', { slug: 'notes/undated', content: undated })).toMatchObject({ state: 'committed' });
    expect(await ledger(engine, UNDATED)).toEqual([]);
    expect((await engine.readPageSnapshot('notes/undated', { sourceId: 'default' }))!.page.compiled_truth).toContain(`| ~~${UNDATED}~~ | fact | 1.0 | world | medium | 2026-01-01 |  |`);
  }, { databaseUrl, setup }), 180_000);
});
