/**
 * #8636: forget_fact on a fact that already expired without a withdrawal (a legacy expiry) still answers
 * fact_already_expired, but first publishes the withdrawal: the ledger row, and on a file-backed source the struck fence
 * row, so neither a stale import nor a fence reconcile reactivates the claim. Repo-less (PGLite, MCP dispatch) and
 * file-backed (managed brain with a Git checkout, operation handlers).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const CLAIM = 'Keeps a rooftop beehive expiredledger';
const fence = (rows: string[]) => ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|', ...rows, '<!--- gbrain:facts:end -->'].join('\n');
const stale = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nNotes.\n\n## Facts\n\n${fence([`| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`])}\n`;
const ledger = (engine: BrainEngine) => engine.executeRaw("SELECT 1 FROM fact_withdrawals WHERE source_id='default' AND fact_hash=gbrain_fact_fingerprint($1)", [CLAIM]);
const active = async (engine: BrainEngine) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL", [CLAIM]))[0]!.n;

describe('repo-less brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await engine.disconnect(); });

  test('forget_fact on a legacy-expired fact answers fact_already_expired, records the ledger row, and a stale import stays withdrawn', async () => {
    const inserted = await engine.insertFact({ fact: CLAIM, kind: 'fact', source: 'test', visibility: 'world' }, { source_id: 'default' });
    await engine.expireFact(inserted.id);
    const r = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, { remote: false, sourceId: 'default' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe('fact_already_expired');
    expect(await ledger(engine)).toHaveLength(1);
    await dispatchToolCall(engine, 'put_page', { slug: 'notes/stale', content: stale('Stale') }, { remote: false, sourceId: 'default' });
    expect(await active(engine)).toBe(0);
  }, 60_000);
});

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

describe('file-backed brain', () => {
  test('forget_fact on a legacy-expired fact strikes its fence row in a commit, records the ledger row, answers fact_already_expired; a stale import stays withdrawn', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await call(ctx, 'put_page', { slug: 'notes/a', content: stale('A') })).toMatchObject({ state: 'committed' });
    const [fact] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL", [CLAIM]);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1', [Number(fact!.id)]), TEST_WRITE_ATTRIBUTION));
    await expect(call(ctx, 'forget_fact', { id: Number(fact!.id) })).rejects.toMatchObject({ code: 'fact_already_expired' });
    expect(await ledger(engine)).toHaveLength(1);
    const text = readFileSync(join(root, 'notes/a.md'), 'utf8');
    expect(text).toContain(`~~${CLAIM}~~`);
    expect(text).toContain('forgotten:');
    await settleManagedGitEffects(engine);
    expect(git(root, 'status', '--porcelain', '--', 'notes/a.md')).toBe('');
    expect(git(root, 'show', 'HEAD:notes/a.md')).toContain('forgotten:');
    await call(ctx, 'put_page', { slug: 'notes/a', content: stale('A') }).catch(() => undefined);
    expect(await active(engine)).toBe(0);
  }, { setup }), 180_000);
});
