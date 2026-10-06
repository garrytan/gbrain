/**
 * The write-inference contract, checked at runtime.
 *
 * Saving text or a fact never waits on a generative model: every write
 * surface commits and is keyword-queryable with zero generative model calls.
 * Embeddings are allowed. Generative work a write triggers (facts extraction)
 * runs after commit, attributed to the job that ran it, and stops when
 * `facts.extraction_enabled` is false.
 *
 * Keys are configured for chat and embeddings so gated paths are live; the
 * chat transport answers with no facts, the embed transport is deterministic, and
 * any outbound request is recorded and blocked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import type { MinionHandler } from '../src/core/minions/types.ts';
import { writeInferenceOf, ZERO_GENERATIVE_BEFORE_COMMIT } from '../src/core/ops/write-inference.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';
import { drainFeedbackQueue, recordAnswer } from '../src/core/feedback/record.ts';
import { runPhaseEdgeContradictions, applyEdgeProposal, rejectEdgeProposal, undoEdgeProposal } from '../src/core/cycle/edge-contradictions.ts';

let engine: PGLiteEngine;
let wire: Tripwire;
const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
const BODY = 'A substantive meeting note about the quarterly roadmap with acme-example. '.repeat(4);

function body(r: { isError?: boolean; content: Array<{ text?: string }> }): Record<string, any> {
  const parsed = JSON.parse(r.content[0]?.text ?? '{}');
  if (r.isError) throw new Error(`tool error: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function call(name: string, params: Record<string, unknown>, remote = false) {
  return body(await dispatchToolCall(engine, name, params, remote
    ? { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' }
    : { remote: false }));
}

async function drainEffects(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const n = await runPersistenceEffects(engine, { engine: 'pglite' }, { hostId: localHostId(), limit: 32 });
    if (!n) break;
  }
}

async function runFactsJobs(): Promise<number> {
  const handlers = new Map<string, MinionHandler>();
  await registerBuiltinHandlers({ register: (name: string, handler: MinionHandler) => handlers.set(name, handler) } as never, engine, { quiet: true });
  const jobs = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
    "SELECT id,data FROM minion_jobs WHERE name='facts-absorb' AND status IN ('waiting','active','delayed')");
  for (const job of jobs) {
    await handlers.get('facts-absorb')!({
      ...job, name: 'facts-absorb', attempts_made: 0, signal: new AbortController().signal,
      deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {},
      updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [],
    } as never).catch(() => {});
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [job.id]);
  }
  return jobs.length;
}

function expectNoGenerative(label: string): void {
  const gen = wire.generative();
  if (gen.length) throw new Error(`${label}: ${gen.length} generative model call(s) before commit: ${gen.map(e => e.call.operation).join(', ')}`);
  expect(wire.egress).toEqual([]);
}

beforeAll(async () => {
  for (const k of PINNED) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENAI_API_KEY = 'sk-test-fake';
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((v, i) => Array.from({ length: 1536 }, (_, j) => ((v.length + i + j) % 7) / 7 + 0.01)),
    usage: { tokens: values.length * 4 },
  }) as never);
  __setChatTransportForTests(async () => ({
    text: '{"facts":[]}', blocks: [{ type: 'text', text: '{"facts":[]}' }], stopReason: 'end',
    usage: { input_tokens: 40, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  }) as never);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
  wire = installTripwire();
}, 60_000);

beforeEach(() => { wire.reset(); });
afterEach(async () => { await disposePersistenceConsumer(engine); });

afterAll(async () => {
  wire.dispose();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const COVERED = new Set<string>();

describe('writes commit with zero generative model calls', () => {
  test('put_page (local and remote), keyword-queryable at commit', async () => {
    COVERED.add('put_page');
    await call('put_page', { slug: 'meetings/roadmap-local', content: `---\ntype: meeting\ntitle: Roadmap local\n---\n${BODY}` });
    await call('put_page', { slug: 'meetings/roadmap-remote', content: `---\ntype: meeting\ntitle: Roadmap remote\n---\n${BODY} See [[meetings/roadmap-local]].` }, true);
    expectNoGenerative('put_page');
    const hits = await engine.searchKeyword('quarterly roadmap');
    expect(hits.map(h => h.slug)).toEqual(expect.arrayContaining(['meetings/roadmap-local', 'meetings/roadmap-remote']));
  });

  test('put_pages (remote batch)', async () => {
    COVERED.add('put_pages');
    await call('put_pages', { request_id: '7d3c2b1a-0f9e-4d8c-a7b6-5e4d3c2b1a09', pages: [
      { slug: 'meetings/batch-one', content: `---\ntype: meeting\ntitle: Batch one\n---\n${BODY}` },
      { slug: 'meetings/batch-two', content: `---\ntype: meeting\ntitle: Batch two\n---\n${BODY}` },
    ] }, true);
    expectNoGenerative('put_pages');
  });

  test('capture and edit_page', async () => {
    COVERED.add('capture'); COVERED.add('edit_page');
    await call('capture', { slug: 'notes/captured', content: `Captured thought about pricing tiers. ${BODY}` });
    const page = await call('get_page', { slug: 'meetings/roadmap-local', include_content: true });
    await call('edit_page', { slug: 'meetings/roadmap-local', expected_revision: page.revision,
      edits: [{ old_text: 'Roadmap local', new_text: 'Roadmap local (edited)' }] });
    expectNoGenerative('capture/edit_page');
  });

  test('graph, tags, timeline and takes', async () => {
    for (const n of ['add_link', 'remove_link', 'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add']) COVERED.add(n);
    await call('put_page', { slug: 'companies/acme-example', content: `---\ntype: company\ntitle: Acme Example\n---\nA company.` });
    await call('add_link', { from: 'meetings/roadmap-local', to: 'companies/acme-example', link_type: 'mentions' });
    await call('remove_link', { from: 'meetings/roadmap-local', to: 'companies/acme-example' });
    await call('add_tag', { slug: 'companies/acme-example', tag: 'customer' });
    await call('remove_tag', { slug: 'companies/acme-example', tag: 'customer' });
    await call('add_timeline_entry', { slug: 'companies/acme-example', date: '2026-09-01', summary: 'Signed the pilot.' });
    await call('takes_add', { page_slug: 'companies/acme-example', claim: 'Acme Example will expand the pilot.', kind: 'bet', holder: 'self', weight: 0.6 }).catch(() => undefined);
    expectNoGenerative('graph/tags/timeline/takes');
  });

  test('remember (fresh, duplicate, cosine supersede) and forget', async () => {
    COVERED.add('remember'); COVERED.add('forget');
    const first = await call('remember', { fact: 'Alice Example prefers async standups.', provenance: 'test', entity: 'companies/acme-example' });
    await call('remember', { fact: 'Alice Example prefers async standups.', provenance: 'test', entity: 'companies/acme-example' });
    await call('remember', { fact: 'Alice Example now prefers daily standups.', provenance: 'test', entity: 'companies/acme-example' }, true);
    expect(wire.events.some(e => e.call.kind === 'embedding')).toBe(true);
    await call('forget', { id: String(first.fact_id ?? first.id) });
    expectNoGenerative('remember/forget');
  });

  test('remember items[] (a pre-compaction batch) embeds at most, never generates', async () => {
    const batch = await call('remember', { provenance: 'test', items: [
      { fact: 'Alice Example ships on Fridays.', entity: 'companies/acme-example' },
      'Bob Example prefers written updates.',
    ] }, true);
    expect(batch.saved).toBe(2);
    expectNoGenerative('remember items[]');
  });

  test('delete_page and restore_page', async () => {
    COVERED.add('delete_page'); COVERED.add('restore_page');
    await call('put_page', { slug: 'notes/temp', content: `---\ntype: note\ntitle: Temp\n---\nTemporary.` });
    const temp = await call('get_page', { slug: 'notes/temp', include_content: true });
    await call('delete_page', { slug: 'notes/temp', expected_revision: temp.revision });
    const deleted = await call('get_page', { slug: 'notes/temp', include_content: true, include_deleted: true }).catch(() => ({} as Record<string, any>));
    await call('restore_page', { slug: 'notes/temp', ...(deleted.revision ? { expected_revision: deleted.revision } : {}) });
    expectNoGenerative('delete/restore');
  });

  test('CLI edge-proposals accept, undo and reject (P1 edge contradictions)', async () => {
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    await call('put_page', { slug: 'companies/edge-a', content: '---\ntype: company\ntitle: Edge A\n---\nA company.' });
    await call('put_page', { slug: 'companies/edge-b', content: '---\ntype: company\ntitle: Edge B\n---\nA company.' });
    await call('put_page', { slug: 'people/edge-person', content: '---\ntype: person\ntitle: Edge Person\n---\nWorks at [Edge A](../companies/edge-a) and at [Edge B](../companies/edge-b).\n\n## Timeline\n\n- **2019-02-01** | test — joined [Edge A](../companies/edge-a)\n- **2024-05-01** | test — joined [Edge B](../companies/edge-b)' });
    await runPhaseEdgeContradictions(engine, { judge: async () => [{ a: 1, b: 2, conflict: true, confidence: 0.9 }] });
    const [p] = await engine.executeRaw<{ id: number }>("SELECT id FROM link_edge_proposals WHERE status = 'proposed' ORDER BY id DESC LIMIT 1");
    expect(p).toBeDefined();
    wire.reset();
    expect((await applyEdgeProposal(engine, Number(p!.id))).status).toBe('applied');
    expect((await undoEdgeProposal(engine, Number(p!.id))).status).toBe('undone');
    expectNoGenerative('edge-proposals accept/undo');
    const [q] = await engine.executeRaw<{ id: number }>("SELECT id FROM link_edge_proposals ORDER BY id DESC LIMIT 1");
    await rejectEdgeProposal(engine, Number(q!.id));
    expectNoGenerative('edge-proposals reject');
  });

  test('rate_answer and the answer/citation recording behind it (P3 feedback)', async () => {
    COVERED.add('rate_answer');
    await engine.setConfig('feedback.enabled', 'true');
    try {
      wire.reset();
      const ctx = { engine, config: { engine: 'pglite' }, remote: false, dryRun: false, sourceId: 'default',
        logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;
      const meta = await recordAnswer(ctx, { op: 'search', pages: [{ slug: 'meetings/roadmap-local', cited: true }] });
      const answerId = meta?.answer_id;
      expect(answerId).toMatch(/^ans_/);
      await drainFeedbackQueue(10_000);
      await call('rate_answer', { answer_id: answerId, rating: 4 });
      await drainFeedbackQueue(10_000);
      expectNoGenerative('search answer recording + rate_answer');
    } finally {
      await engine.unsetConfig('feedback.enabled');
    }
  });

  test('CLI import (importFromContent)', async () => {
    await importFromContent(engine, 'notes/imported', `---\ntype: note\ntitle: Imported\n---\n${BODY}`, { sourceId: 'default' });
    expectNoGenerative('importFromContent');
    expect((await engine.searchKeyword('roadmap')).some(h => h.slug === 'notes/imported')).toBe(true);
  });
});

describe('generative work a write triggers runs after commit, attributed and switchable', () => {
  test('extraction off: draining effects and jobs makes zero generative calls', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    await call('put_page', { slug: 'meetings/off-arm', content: `---\ntype: meeting\ntitle: Off arm\n---\n${BODY}` });
    await drainEffects();
    await runFactsJobs();
    expectNoGenerative('extraction off');
  });

  test('extraction on: every generative call belongs to facts extraction for the originating request', async () => {
    await engine.setConfig('facts.extraction_enabled', 'true');
    const receipt = await call('put_page', { slug: 'meetings/on-arm', content: `---\ntype: meeting\ntitle: On arm\n---\n${BODY}` });
    expectNoGenerative('commit before drain');
    await drainEffects();
    const ran = await runFactsJobs();
    expect(ran).toBeGreaterThan(0);
    const gen = wire.generative();
    expect(gen.length).toBeGreaterThan(0);
    for (const e of gen) {
      expect(['facts-absorb', 'facts-queue']).toContain(e.attribution?.effect ?? 'unattributed');
    }
    // The receipt carries an opaque public id; attribution uses the internal write-request id.
    const [request] = await engine.executeRaw<{ id: string }>(
      "SELECT id::text AS id FROM persistence_requests WHERE slug='meetings/on-arm' AND operation='put_page' ORDER BY created_at DESC LIMIT 1");
    const requestId = request?.id;
    expect(typeof receipt.request_id).toBe('string');
    expect(typeof requestId).toBe('string');
    expect(gen.some(e => e.attribution?.request_id === requestId)).toBe(true);
    expect(wire.egress).toEqual([]);
  });
});

describe('coverage of the classification', () => {
  test('every mutating op resolves to a class; uncovered zero-generative ops are reported', () => {
    const mutating = operations.filter(op => op.mutating);
    const uncovered = mutating
      .filter(op => ZERO_GENERATIVE_BEFORE_COMMIT.has(writeInferenceOf(op)) && !COVERED.has(op.name))
      .map(op => `${op.name}:${writeInferenceOf(op)}`);
    for (const op of mutating) expect(typeof writeInferenceOf(op)).toBe('string');
    if (uncovered.length) console.info(`[write-inference] zero-generative ops without a runtime case here: ${uncovered.join(', ')}`);
    for (const core of ['put_page', 'capture', 'edit_page', 'remember', 'forget', 'add_link', 'add_timeline_entry']) {
      expect(COVERED.has(core)).toBe(true);
    }
  });
});
