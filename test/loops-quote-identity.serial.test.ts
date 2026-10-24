/** #7289: one obligation per validated quote, not per model paraphrase.
 * Serial: the real gateway transport is process-global. Synthetic mail only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { closeOpenLoop, upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { sha8 } from '../src/core/google/google-render.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { createConnectorFixture, googleConfig } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const fixture = createConnectorFixture();
beforeAll(fixture.setup, 120_000);
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await fixture.teardown(); });
const quote = 'I will send the deck by Friday.';
const decision = 'Which week works for the kickoff?';
const commitment = (text: string, evidence = quote, direction = 'owed_by_me') => ({ text, quote: evidence, direction,
  counterparty_name: '', counterparty_email: '', due_iso: null });
let response: { commitments: ReturnType<typeof commitment>[]; decisions_pending: Array<{ text: string; quote: string }> };

async function seed(engine: BrainEngine, thread = 'example-thread', managed = false) {
  const { id } = await fixture.source(engine, googleConfig);
  if (managed) {
    const ctx = { engine, sourceId: id, remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'emails/example',
      content: `---\ntype: email\ntitle: Synthetic exchange\nthread_id: ${thread}\ndate: 2026-10-20T10:00:00Z\n---\n${quote}\n${decision}\nI will send the report.` } });
    expect(receipt).toMatchObject({ state: 'committed' });
  } else {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.putPage('emails/example', { type: 'email', title: 'Synthetic exchange', compiled_truth: `${quote}\n${decision}\nI will send the report.`,
      frontmatter: { thread_id: thread, date: '2026-10-20T10:00:00Z' } }, { sourceId: id });
  }
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify(response), blocks: [], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  return { id, run: () => runLoopsExtract(engine, { sourceId: id, slug: 'emails/example' }) };
}
async function loops(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ id: number; status: string; dedup_key: string; fact_id: number | null }>('SELECT id,status,dedup_key,fact_id FROM open_loops WHERE source_id=$1 ORDER BY id', [sourceId]);
}

test('collapses same-quote paraphrases before all three projections, for commitments and decisions', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine);
    response = { commitments: [commitment('Send the deck'), commitment('Share the deck', 'I will send\n the deck by Friday.')],
      decisions_pending: [{ text: 'Choose a kickoff week', quote: decision }, { text: 'Pick a week', quote: decision }] };
    const result = await f.run();
    expect(result).toMatchObject({ commitments: 1, decisions: 1 });
    expect(new Set(result.loop_ids).size).toBe(2);
    expect(await loops(engine, f.id)).toHaveLength(2);
    const facts = await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND kind=\'commitment\'', [f.id]);
    expect(facts).toHaveLength(1);
  }
}), 120_000);

test('paraphrased replay preserves loop and fact IDs and does not bypass a manual close', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine);
    response = { commitments: [commitment('Send the deck')], decisions_pending: [{ text: 'Pick a week', quote: decision }] };
    const first = await f.run();
    const before = await loops(engine, f.id);
    expect(before[0].fact_id).not.toBeNull();
    await closeOpenLoop(engine, f.id, first.loop_ids[0], 'done', 'manual');
    response = { commitments: [commitment('Share the presentation')], decisions_pending: [{ text: 'Choose kickoff timing', quote: decision }] };
    const replay = await f.run();
    expect(replay.loop_ids.map(Number)).toEqual(first.loop_ids.map(Number));
    expect((await loops(engine, f.id)).map(r => [Number(r.id), r.status, Number(r.fact_id)])).toEqual(before.map((r, i) => [Number(r.id), i === 0 ? 'done' : r.status, Number(r.fact_id)]));
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND kind=\'commitment\'', [f.id])).toHaveLength(1);
  }
}), 120_000);

test('adopts legacy text-keyed quote identity without rewriting history or reopening a closed obligation', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine);
    const key = `commit:${sha8(JSON.stringify({ t: 'example-thread', d: 'owed_by_me', x: 'old paraphrase' }))}`;
    const old = await upsertOpenLoop(engine, { sourceId: f.id, dedupKey: key, loopType: 'commitment_owed_by_me', detector: 'llm_extract', summary: 'Old paraphrase',
      threadId: 'example-thread', evidence: [{ page_slug: 'emails/example', quote }], lastActivityAt: '2026-10-20T10:00:00Z' });
    await closeOpenLoop(engine, f.id, old.id, 'dropped', 'manual');
    response = { commitments: [commitment('A different paraphrase')], decisions_pending: [] };
    expect((await f.run()).loop_ids.map(Number)).toEqual([old.id]);
    expect(await loops(engine, f.id)).toEqual([expect.objectContaining({ dedup_key: key, status: 'dropped' })]);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [f.id])).toHaveLength(0);
  }
}), 120_000);

test('keeps distinct quotes, directions, decisions and source/thread identities separate', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine);
    response = { commitments: [commitment('Send it'), commitment('Send it', 'I will send the report.'), commitment('Send it', quote, 'owed_to_me')],
      decisions_pending: [{ text: 'Send it', quote }] };
    const first = await f.run();
    expect(new Set(first.loop_ids).size).toBe(4);
    const otherSource = await seed(engine);
    expect((await otherSource.run()).loop_ids.every(id => !first.loop_ids.includes(id))).toBe(true);
    const page = await engine.getPage('emails/example', { sourceId: f.id });
    await engine.putPage('emails/example', { type: 'email', title: page!.title, compiled_truth: page!.compiled_truth,
      frontmatter: { ...page!.frontmatter, thread_id: 'another-thread' } }, { sourceId: f.id });
    expect((await f.run()).loop_ids.every(id => !first.loop_ids.includes(id))).toBe(true);
  }
}), 120_000);

test('newer activity still reopens the same loop and retries a retired fact projection', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine);
    response = { commitments: [commitment('Send the deck')], decisions_pending: [] };
    const first = await f.run();
    const [old] = await loops(engine, f.id);
    expect(old.fact_id).not.toBeNull();
    await closeOpenLoop(engine, f.id, first.loop_ids[0], 'done', 'manual');
    await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1', [old.fact_id]);
    const page = await engine.getPage('emails/example', { sourceId: f.id });
    await engine.putPage('emails/example', { type: 'email', title: page!.title, compiled_truth: page!.compiled_truth,
      frontmatter: { ...page!.frontmatter, date: '2026-10-21T10:00:00Z' } }, { sourceId: f.id });
    response = { commitments: [commitment('Share the presentation')], decisions_pending: [] };
    expect((await f.run()).loop_ids.map(Number)).toEqual(first.loop_ids.map(Number));
    const [reopened] = await loops(engine, f.id);
    expect(reopened.status).toBe('open');
    expect(Number(reopened.fact_id)).not.toBe(Number(old.fact_id));
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND expired_at IS NULL', [f.id])).toHaveLength(1);
  }
}), 120_000);

test('managed publication retains one fact and loop across paraphrased extraction', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine, 'example-thread', true);
    response = { commitments: [commitment('Send the deck'), commitment('Share the slides')], decisions_pending: [] };
    const first = await f.run();
    expect(first.commitments).toBe(1);
    const before = await loops(engine, f.id);
    expect(before[0].fact_id).not.toBeNull();
    response = { commitments: [commitment('Deliver the presentation')], decisions_pending: [] };
    expect((await f.run()).loop_ids.map(Number)).toEqual(first.loop_ids.map(Number));
    expect((await loops(engine, f.id)).map(r => Number(r.fact_id))).toEqual(before.map(r => Number(r.fact_id)));
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND expired_at IS NULL', [f.id])).toHaveLength(1);
  }
}), 120_000);

test('unverified or empty quotes use text fallback, never a hallucinated identity', async () => withEnv(fixture.env, async () => {
  for (const engine of fixture.engines) {
    const f = await seed(engine);
    response = { commitments: [commitment('First promise', 'not in the thread'), commitment('Second promise', 'not in the thread'),
      commitment('First promise', ''), commitment('First promise', ' \n\t '), commitment('Second promise', ' \n\t ')], decisions_pending: [] };
    expect((await f.run()).commitments).toBe(2);
    expect(await loops(engine, f.id)).toHaveLength(2);
    response = { commitments: [commitment('FIRST PROMISE', '')], decisions_pending: [] };
    await f.run();
    expect(await loops(engine, f.id)).toHaveLength(2);
  }
}), 120_000);
