/**
 * GBRA-190 G4: forget is a fence edit.
 *   - A withdrawal that strikes several pages is one coordinated publication: every struck file lands in one door commit
 *     on a strict source, before the ledger row and expiries commit, and no withdrawal-mirror effect is queued (D2).
 *   - Interrupted before its commit, recovery restores every file of its version 3 record and the replay commits once;
 *     interrupted after it, the committed files are kept and the replay completes against them.
 *   - Remember linking a fact saved without an entity strikes its memory/unattributed row in the same commit (D3).
 *   - No writer derives ledger rows from markers: a brain rebuilt from Git records no withdrawal, and a remote page write
 *     carrying a struck forgotten: row records nothing, blocks no remember and stays inert after a rebuild.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** The source loses its canonical owner: no binding, and on PGLite activation listed it database-only (no automatic claim). */
const unbind = async (engine: BrainEngine) => {
  await engine.executeRaw(`DELETE FROM persistence_source_bindings WHERE source_id='default'`);
  await engine.setConfig('persistence.database_only_sources', JSON.stringify(['default']));
};
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

  test('a brain rebuilt from Git records no withdrawal: the markers stay in the files and no ledger row is derived', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'gbrain-g4-rebuild-'));
    try {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await twoPagesCarryingTheClaim(ctx, engine);
        expect(await call(ctx, 'forget', { id: String(id) })).toMatchObject({ state: 'committed' });
        const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
        await settleManagedGitEffects(engine);
        expect(git(root, 'status', '--porcelain')).toBe('');
        expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(`~~${CLAIM}~~`);
        execFileSync('git', ['clone', '-q', root, join(copy, 'repo')]);
      }, { databaseUrl, setup });
      await managedBrain(async ({ engine, root }) => {
        expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
        expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain(`~~${CLAIM}~~`);
        expect(await ledger(engine, CLAIM)).toEqual([]);
        expect(await isFactWithdrawn(engine, 'default', 'world', CLAIM, null)).toBe(false);
      }, { databaseUrl, setup: ({ root }) => { rmSync(root, { recursive: true, force: true }); execFileSync('git', ['clone', '-q', join(copy, 'repo'), root]); } });
    } finally { rmSync(copy, { recursive: true, force: true }); }
  }, 240_000);

  test('a source whose owner is unavailable refuses forgetting a claim its canonical file carries, and withdraws nothing', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await call(ctx, 'put_page', { slug: 'notes/a', content: note('A', [`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`]) })).toMatchObject({ state: 'committed' });
    const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
    await settleManagedGitEffects(engine);
    const id = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [CLAIM]))[0]!.id;
    await unbind(engine);
    const before = readFileSync(join(root, 'notes/a.md'), 'utf8');
    const refused = await call(ctx, 'forget', { id: String(id) }).catch((error: { code?: string; detail?: string; message?: string }) => error);
    expect({ code: refused.code, detail: refused.detail, message: refused.message })
      .toEqual({ code: 'unavailable', detail: 'unbound_source', message: 'This source has no designated canonical owner.' });
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toBe(before);
    expect(await ledger(engine, CLAIM)).toEqual([]);
    expect((await engine.executeRaw<{ active: boolean }>('SELECT expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0]!.active).toBe(true);
  }, { databaseUrl, setup }), 180_000);

  test('with sync.write_through off, forget refuses a claim a canonical file carries and still withdraws a database-only one', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await call(ctx, 'put_page', { slug: 'notes/a', content: note('A', [`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`]) })).toMatchObject({ state: 'committed' });
    const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
    await settleManagedGitEffects(engine);
    const id = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [CLAIM]))[0]!.id;
    await engine.setConfig('sync.write_through', 'false');
    const before = readFileSync(join(root, 'notes/a.md'), 'utf8');
    const refused = await call(ctx, 'forget', { id: String(id) }).catch((error: { code?: string; detail?: string }) => error);
    expect({ code: refused.code, detail: refused.detail }).toEqual({ code: 'unavailable', detail: 'sync_write_through_off' });
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toBe(before);
    expect(await ledger(engine, CLAIM)).toEqual([]);
    expect((await engine.executeRaw<{ active: boolean }>('SELECT expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0]!.active).toBe(true);
    expect(await call(ctx, 'put_page', { slug: 'notes/b', content: note('B', [`| 1 | ${OTHER} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`]) })).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/b.md'))).toBe(false);
    const other = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [OTHER]))[0]!.id;
    expect(await call(ctx, 'forget', { id: String(other) })).toMatchObject({ state: 'committed', expired: true });
    expect(await ledger(engine, OTHER)).toEqual(['notes/b']);
  }, { databaseUrl, setup }), 180_000);

  for (const shape of ['repository', 'repo-less'] as const) test(`three parallel first remembers without an entity all commit to memory/unattributed (${shape})`, () => managedBrain(async ({ engine, ctx }) => {
    const facts = ['Parallel claim one g4par', 'Parallel claim two g4par', 'Parallel claim three g4par'];
    const results = await Promise.all(facts.map(fact => call(ctx, 'remember', { fact, provenance: 'test', visibility: 'world', infer_entity: false })));
    expect(results.map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
    const stored = await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source_id='default' AND entity_slug IS NULL AND expired_at IS NULL AND fact LIKE '%g4par' ORDER BY fact`);
    expect(stored.map(row => row.fact)).toEqual([...facts].sort());
  }, { databaseUrl, ...(shape === 'repository' ? { setup } : {}) }), 180_000);

  test('a sandboxed subagent forget refuses a claim a canonical file carries and withdraws nothing', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'wiki/agents/7/notes-a';
    expect(await call(ctx, 'put_page', { slug, content: note('A', [`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`]) })).toMatchObject({ state: 'committed' });
    const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
    await settleManagedGitEffects(engine);
    const id = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [CLAIM]))[0]!.id;
    const before = readFileSync(join(root, `${slug}.md`), 'utf8');
    const refused = await call({ ...ctx, viaSubagent: true, subagentId: 7 } as OperationContext, 'forget', { id: String(id) }).catch((error: { code?: string; detail?: string }) => error);
    expect({ code: refused.code, detail: refused.detail }).toEqual({ code: 'scope_denied', detail: 'subagent_sandbox' });
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(before);
    expect(await ledger(engine, CLAIM)).toEqual([]);
    expect((await engine.executeRaw<{ active: boolean }>('SELECT expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0]!.active).toBe(true);
  }, { databaseUrl, setup }), 180_000);

  test('an unbound connector source still withdraws a claim its page file carries, database-only', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await call(ctx, 'put_page', { slug: 'notes/a', content: note('A', [`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`]) })).toMatchObject({ state: 'committed' });
    const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
    await settleManagedGitEffects(engine);
    const id = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [CLAIM]))[0]!.id;
    await unbind(engine);
    await engine.executeRaw(`UPDATE sources SET local_path=COALESCE(local_path,$1), config = config || '{"kind":"google"}'::jsonb WHERE id='default'`, [root]);
    const before = readFileSync(join(root, 'notes/a.md'), 'utf8');
    expect(await call(ctx, 'forget', { id: String(id) })).toMatchObject({ state: 'committed', expired: true });
    expect(await ledger(engine, CLAIM)).toEqual(['notes/a']);
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toBe(before);
  }, { databaseUrl, setup }), 180_000);

  test('a source whose owner is unavailable still withdraws a claim only a database-only page carries', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect(await call(ctx, 'put_page', { slug: 'notes/b', content: note('B', [`| 1 | ${OTHER} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`]) })).toMatchObject({ state: 'committed' });
    await engine.setConfig('sync.write_through', 'true');
    expect(existsSync(join(root, 'notes/b.md'))).toBe(false);
    const id = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [OTHER]))[0]!.id;
    await unbind(engine);
    expect(await call(ctx, 'forget', { id: String(id) })).toMatchObject({ state: 'committed', expired: true });
    expect(await ledger(engine, OTHER)).toEqual(['notes/b']);
  }, { databaseUrl, setup }), 180_000);

  test('a remote page write of a struck forgotten: row records nothing, blocks no remember, and stays inert after a rebuild from Git', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'gbrain-g4-remote-'));
    const REMOTE = 'Remote marker claim g4remote';
    try {
      await managedBrain(async ({ engine, ctx, root }) => {
        const clientId = `client-${randomUUID().slice(0, 8)}`;
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','example-client','read write','default')`, [clientId]);
        const remote = { ...ctx, remote: true, transport: 'http', auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'], sourceId: 'default' } } as OperationContext;
        const marked = note('Remote', [`| 1 | ~~${REMOTE}~~ | fact | 1.0 | world | medium | 2026-01-01 | ${today} | test | forgotten: no longer true |`]);
        expect(await call(remote, 'put_page', { slug: 'notes/remote', content: marked })).toMatchObject({ state: 'committed' });
        expect(await ledger(engine, REMOTE)).toEqual([]);
        expect(await isFactWithdrawn(engine, 'default', 'world', REMOTE, 'notes/remote')).toBe(false);
        const { settleManagedGitEffects } = await import('./helpers/managed-brain.ts');
        await settleManagedGitEffects(engine);
        expect(git(root, 'status', '--porcelain')).toBe('');
        expect(readFileSync(join(root, 'notes/remote.md'), 'utf8')).toContain('forgotten: no longer true');
        execFileSync('git', ['clone', '-q', root, join(copy, 'repo')]);
      }, { databaseUrl, setup });
      await managedBrain(async ({ engine, ctx }) => {
        expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
        expect(await ledger(engine, REMOTE)).toEqual([]);
        expect(await isFactWithdrawn(engine, 'default', 'world', REMOTE, 'notes/remote')).toBe(false);
        expect(await call(ctx, 'remember', { fact: REMOTE, provenance: 'test', visibility: 'world', entity: 'notes/remote' })).toMatchObject({ state: 'committed' });
      }, { databaseUrl, setup: ({ root }) => { rmSync(root, { recursive: true, force: true }); execFileSync('git', ['clone', '-q', join(copy, 'repo'), root]); } });
    } finally { rmSync(copy, { recursive: true, force: true }); }
  }, 240_000);
});
