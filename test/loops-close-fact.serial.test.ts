/**
 * #5869: `loops_close` retires the commitment fact through one coordinated
 * publication (fact expired + fence row struck) on managed and unmanaged
 * brains, reports the real outcome, and stays retryable until it commits.
 *
 * Authoring gate. (1) Protects closing a commitment loop: the promise must
 * leave entity cards and recall, and the page's `## Facts` fence must agree
 * with the database. (2) Fails on the baseline: on a managed brain the raw
 * `UPDATE facts` was refused by `managed_writer_guard`, swallowed, and the op
 * still answered `fact_expired: true`; the fence row was never struck in
 * either mode; a second call could never retry. (3) `ops-loops.test.ts`
 * covers loops_close on a bare facts row in an unmanaged in-memory brain
 * only. (4) Serial: the chat transport is the gateway's process-global seam,
 * and the fixture toggles the brain-wide persistence switch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { loopFactsDriftCheck } from '../src/commands/doctor/checks/loop-facts.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, googleConfig } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
beforeAll(fixture.setup, 120_000);
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await fixture.teardown(); });

const loopsClose = loopsOperations.find((o) => o.name === 'loops_close')!;
const ctxFor = (engine: BrainEngine, sourceId: string, over: Partial<OperationContext> = {}) => ({
  engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} }, ...over,
}) as unknown as OperationContext;

type CloseResult = { closed: boolean; id?: number; status?: string; fact_expired?: boolean; retryable?: boolean; reason?: string };

/** A connector source with one commitment loop and its fact, made by the real extractor. */
async function seedCommitment(engine: BrainEngine, managed: boolean) {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ commitments: [{ text: 'Send the deck by Friday', direction: 'owed_by_me',
    counterparty_name: 'people/alice-example', counterparty_email: '', due_iso: null, quote: 'I will send the deck by Friday.' }], decisions_pending: [] }),
  blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  const f = await source(engine, googleConfig);
  await engine.setConfig('loops.extraction_enabled', 'true');
  const ctx = ctxFor(engine, f.id);
  if (managed) {
    const put = (slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
    await put('people/alice-example', '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n');
    await put('emails/example', '---\ntitle: Synthetic exchange\ntype: email\nthread_id: example\nfrom: sender@example.invalid\n---\nI will send the deck by Friday.\n');
  } else {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const written = [await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: '# Alice Example' }, { sourceId: f.id }),
      await engine.putPage('emails/example', { title: 'Synthetic exchange', type: 'email', compiled_truth: 'I will send the deck by Friday.',
        frontmatter: { thread_id: 'example', from: 'sender@example.invalid' } }, { sourceId: f.id })];
    // The pages have their files, as a local_path source's pages do (#6398: a DB-only page takes the DB-only fact route).
    const [{ local_path: root }] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [f.id]);
    for (const page of written) if (root) {
      mkdirSync(join(root, page.slug, '..'), { recursive: true });
      writeFileSync(join(root, `${page.slug}.md`), serializePageToMarkdown(page, []));
    }
  }
  const extracted = await runLoopsExtract(engine, { slug: 'emails/example', sourceId: f.id });
  expect(extracted).toMatchObject({ status: 'extracted', commitments: 1 });
  const [loop] = await engine.executeRaw<{ id: number; fact_id: number }>('SELECT id, fact_id FROM open_loops WHERE source_id=$1 AND fact_id IS NOT NULL', [f.id]);
  expect(loop?.fact_id).not.toBeNull();
  return { sourceId: f.id, ctx, loopId: Number(loop.id), factId: Number(loop.fact_id) };
}

async function factState(engine: BrainEngine, sourceId: string, factId: number) {
  const [fact] = await engine.executeRaw<{ expired_at: unknown; row_num: number | null; source_markdown_slug: string | null }>(
    'SELECT expired_at, row_num, source_markdown_slug FROM facts WHERE id=$1', [factId]);
  const page = fact.source_markdown_slug ? await engine.getPage(fact.source_markdown_slug, { sourceId }) : null;
  const row = page ? parseFactsFence(page.compiled_truth).facts.find((r) => r.rowNum === fact.row_num) : undefined;
  return { expired: fact.expired_at !== null, fenced: row !== undefined, rowActive: row?.active ?? null };
}

async function restore(engine: BrainEngine) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

/** A real database refusal inside the publication (no mock): any expiry of a facts row raises. */
const BLOCK_EXPIRY = [`CREATE OR REPLACE FUNCTION test_block_fact_expiry() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN IF OLD.expired_at IS NULL AND NEW.expired_at IS NOT NULL THEN RAISE EXCEPTION 'test refusal: fact expiry blocked'; END IF; RETURN NEW; END $fn$`,
'DROP TRIGGER IF EXISTS test_block_fact_expiry ON facts',
'CREATE TRIGGER test_block_fact_expiry BEFORE UPDATE ON facts FOR EACH ROW EXECUTE FUNCTION test_block_fact_expiry()'];

describe('#5869 loops_close retires the commitment fact through the coordinator', () => {
  for (const managed of [true, false]) {
    const mode = managed ? 'managed' : 'unmanaged';
    test(`${mode}: the fact is expired, its fence row struck, and fact_expired is the real outcome`, async () => withEnv(env, async () => {
      for (const engine of engines) {
        const { sourceId, ctx, loopId, factId } = await seedCommitment(engine, managed);
        expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: false, fenced: true, rowActive: true });
        const res = await loopsClose.handler(ctx, { id: loopId, status: 'done' }) as CloseResult;
        expect(res).toMatchObject({ closed: true, status: 'done', fact_expired: true, retryable: false });
        expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: true, fenced: true, rowActive: false });
        expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1', [sourceId])).toHaveLength(0);
        await restore(engine);
      }
    }), 180_000);

    test(`${mode}: a refused retirement answers retryable and the next call expires the fact`, async () => withEnv(env, async () => {
      for (const engine of engines) {
        const { sourceId, ctx, loopId, factId } = await seedCommitment(engine, managed);
        for (const sql of BLOCK_EXPIRY) await engine.executeRaw(sql);
        let res: CloseResult;
        try {
          res = await loopsClose.handler(ctx, { id: loopId, status: 'done' }) as CloseResult;
        } finally {
          await engine.executeRaw('DROP TRIGGER IF EXISTS test_block_fact_expiry ON facts');
        }
        expect(res).toMatchObject({ closed: true, fact_expired: false, retryable: true });
        expect(typeof res.reason).toBe('string');
        expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: false, rowActive: true });
        const retry = await loopsClose.handler(ctx, { id: loopId, status: 'done' }) as CloseResult;
        expect(retry).toMatchObject({ closed: true, fact_expired: true, retryable: false });
        expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: true, rowActive: false });
        const third = await loopsClose.handler(ctx, { id: loopId, status: 'done' }) as CloseResult;
        expect(third).toEqual({ closed: false, reason: 'not_found_or_already_closed' });
        await restore(engine);
      }
    }), 180_000);
  }

  test('E8: a fact shared by two open loops stays active until the last one closes', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { sourceId, ctx, loopId, factId } = await seedCommitment(engine, true);
      const { id: twin } = await upsertOpenLoop(engine, { sourceId, dedupKey: 'commit:twin', loopType: 'commitment_owed_by_me',
        summary: 'Send the deck by Friday', evidence: [], threadId: 'example-2', pageSlug: 'emails/example', detector: 'llm_extract', factId });
      const first = await loopsClose.handler(ctx, { id: loopId, status: 'done' }) as CloseResult;
      expect(first).toMatchObject({ closed: true, fact_expired: false, retryable: false, reason: 'shared_with_open_loop' });
      expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: false, rowActive: true });
      const second = await loopsClose.handler(ctx, { id: twin, status: 'dropped' }) as CloseResult;
      expect(second).toMatchObject({ closed: true, fact_expired: true, retryable: false });
      expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: true, rowActive: false });
      await restore(engine);
    }
  }), 180_000);

  test('E26: a remote read-only federated grant is refused; the write-bound OAuth caller retires the fact', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { sourceId, loopId, factId } = await seedCommitment(engine, true);
      const clientId = `loops-close-${sourceId}`;
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations)
        VALUES($1,'loops_close fixture','read write',$2,$3)`, [clientId, sourceId, ['loops_close']]);
      const remoteCtx = (writeSource: string) => ctxFor(engine, writeSource, { remote: true, auth: { token: 'synthetic-token', clientId,
        principal: { kind: 'oauth_client', id: clientId }, sourceId: writeSource, scopes: ['read', 'write'], allowedOperations: ['loops_close'],
        allowedSources: [writeSource, sourceId] } as never });
      await expect(loopsClose.handler(remoteCtx('default'), { id: loopId, status: 'done', source_id: sourceId })).rejects.toThrow(/permission_denied|outside the caller's write scope/);
      const foreign = await loopsClose.handler(remoteCtx('default'), { id: loopId, status: 'done' }) as CloseResult;
      expect(foreign).toEqual({ closed: false, reason: 'not_found_or_already_closed' });
      expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: false, rowActive: true });
      const res = await loopsClose.handler(remoteCtx(sourceId), { id: loopId, status: 'done' }) as CloseResult;
      expect(res).toMatchObject({ closed: true, fact_expired: true, retryable: false });
      expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: true, rowActive: false });
      await restore(engine);
    }
  }), 180_000);

  test('E26: a loop whose fact lives in another source never retires that fact', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { sourceId, ctx, factId } = await seedCommitment(engine, true);
      const other = await source(engine, googleConfig);
      const { id } = await upsertOpenLoop(engine, { sourceId: other.id, dedupKey: 'commit:foreign', loopType: 'commitment_owed_by_me',
        summary: 'Send the deck by Friday', evidence: [], threadId: 'foreign', pageSlug: null, detector: 'llm_extract', factId });
      const res = await loopsClose.handler({ ...ctx, sourceId: other.id } as OperationContext, { id, status: 'done', source_id: other.id }) as CloseResult;
      expect(res).toMatchObject({ closed: true, fact_expired: false, retryable: false, reason: 'source_mismatch' });
      expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: false, rowActive: true });
      await restore(engine);
    }
  }), 180_000);
});

describe('#5869 gbrain repair loop-facts and doctor loop_facts_drift', () => {
  async function repair(engine: BrainEngine, args: string[]) {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    try { await runRepairCommand(engine, ['loop-facts', ...args, '--json']); } finally { console.log = original; }
    return JSON.parse(lines.join('\n')) as { results: Array<{ affected: number; applied: number; apply_command: string; listing?: unknown[]; outcomes?: Record<string, number> }> };
  }

  for (const managed of [true, false]) {
    test(`${managed ? 'managed' : 'unmanaged'}: a loop closed before the fix is found, previewed, and retired by the explicit apply`, async () => withEnv(env, async () => {
      for (const engine of engines) {
        const { sourceId, loopId, factId } = await seedCommitment(engine, managed);
        // What the pre-fix loops_close left: the loop closed, its fact active and fenced.
        await engine.executeRaw("UPDATE open_loops SET status='done', closed_at=now(), closed_by='manual' WHERE id=$1", [loopId]);
        const before = await loopFactsDriftCheck(engine, [sourceId]);
        expect(before).toMatchObject({ name: 'loop_facts_drift', status: 'warn', details: { drifted: 1 } });
        expect(before.message).toContain('gbrain repair loop-facts');
        const preview = await repair(engine, ['--source', sourceId]);
        expect(preview.results[0]).toMatchObject({ affected: 1, applied: 0 });
        expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: false, rowActive: true });
        const hash = preview.results[0].apply_command.match(/--expect ([0-9a-f]+)/)![1];
        const applied = await repair(engine, ['--source', sourceId, '--apply', '--expect', hash]);
        expect(applied.results[0]).toMatchObject({ applied: 1, outcomes: { retired: 1 } });
        expect(await factState(engine, sourceId, factId)).toMatchObject({ expired: true, rowActive: false });
        expect(await loopFactsDriftCheck(engine, [sourceId])).toMatchObject({ status: 'ok', details: { drifted: 0 } });
        await restore(engine);
      }
    }), 180_000);
  }

  test('the drift rule skips a fact still shared with an open loop', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { sourceId, loopId, factId } = await seedCommitment(engine, true);
      await upsertOpenLoop(engine, { sourceId, dedupKey: 'commit:shared', loopType: 'commitment_owed_by_me',
        summary: 'Send the deck by Friday', evidence: [], threadId: 'example-3', pageSlug: 'emails/example', detector: 'llm_extract', factId });
      await engine.executeRaw("UPDATE open_loops SET status='done', closed_at=now(), closed_by='manual' WHERE id=$1", [loopId]);
      expect(await loopFactsDriftCheck(engine, [sourceId])).toMatchObject({ status: 'ok', details: { drifted: 0 } });
      await restore(engine);
    }
  }), 180_000);
});
