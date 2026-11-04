import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { automaticCaptureDecision } from '../src/core/facts/automatic-capture-policy.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { proposeRevision } from '../src/core/access/policy.ts';

// Protect prospective automatic routing, expiry, read visibility and retained history.
// The unchanged extractor stores all seven fixture candidates privately without expiry.
// Existing tests cover caller-level visibility, not mixed per-claim automatic routing.
// Uses the existing gateway transport seam; no production-only test seam or paid call.

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterEach(async () => { await disposePersistenceConsumer(engine); __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); });
afterAll(async () => { await engine.disconnect(); });

const observed = '2025-01-01T12:00:00Z';
const expires = '2025-01-02T12:00:00Z';
const turn = `user (${observed}): The sample project uses a queue. Its synthetic review is blocked until ${expires}. Personal health and uncertain material remain private. This is an isolated fixture.`;
const candidate = (fact: string, capture_scope: string, capture_lifetime = 'durable', extra = {}) => ({
  fact, kind: 'fact', entity: 'projects/sample', notability: 'high', confidence: 1,
  attributed_to: 'user', valid_from: '2025-01-01', capture_scope, capture_lifetime,
  observed_at: observed, valid_until: null, ...extra,
});

async function setup(managed: boolean, candidates: unknown[]) {
  await resetPgliteState(engine);
  await engine.setConfig('facts.default_visibility', 'private');
  await engine.setConfig('facts.automatic_capture_policy', 'work_shared_expiring');
  await engine.setConfig('memory.auto_writeback', 'salient');
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: candidates }), blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }));
  await engine.putPage('projects/sample', { type: 'project', title: 'Sample', compiled_truth: 'An isolated synthetic project.' }, { sourceId: 'default' });
  await engine.putPage('notes/original', { type: 'note', title: 'Original', compiled_truth: 'Synthetic original.' }, { sourceId: 'default' });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
}

for (const managed of [false, true]) test(`automatic capture policy preserves sharing, privacy and original expiry (${managed ? 'managed' : 'unmanaged'})`, async () => {
  await setup(managed, [
    candidate('The sample project uses a queue.', 'work'),
    candidate('A synthetic personal health fact.', 'personal'),
    candidate('A mixed project and personal fact.', 'mixed'),
    candidate('An uncertain synthetic fact.', 'unknown'),
    candidate('The synthetic review is temporarily blocked.', 'work', 'temporary', { valid_until: expires }),
    candidate('An undated temporary claim.', 'work', 'temporary', { observed_at: null }),
    candidate('A one-shot approval grant.', 'work', 'omit'),
  ]);
  const ctx = { engine, sourceId: 'default', source: 'sweep:corpus' as const, remote: false, sessionId: 'synthetic-capture-policy' };
  await runFactsPipeline(turn, ctx);
  const rows = await engine.executeRaw<{ id: number; fact: string; visibility: string; valid_until: string | Date | null }>('SELECT id,fact,visibility,valid_until FROM facts ORDER BY id');
  expect(rows).toHaveLength(5);
  expect(rows.find(r => r.fact === 'The sample project uses a queue.')?.visibility).toBe('world');
  for (const text of ['A synthetic personal health fact.', 'A mixed project and personal fact.', 'An uncertain synthetic fact.']) expect(rows.find(r => r.fact === text)?.visibility).toBe('private');
  const temporary = rows.find(r => r.fact === 'The synthetic review is temporarily blocked.')!;
  expect(new Date(temporary.valid_until!).toISOString()).toBe(new Date(expires).toISOString());
  expect(rows.find(r => r.fact === 'The sample project uses a queue.')?.valid_until).toBeNull();
  const remote = JSON.parse((await dispatchToolCall(engine, 'recall', { limit: 50 }, { remote: true, sourceId: 'default' })).content[0].text).facts;
  expect(remote).toHaveLength(1);
  expect(Number(remote[0].id)).toBe(Number(rows.find(r => r.fact === 'The sample project uses a queue.')!.id));
  expect(remote[0].visibility).toBe('world');
  const local = JSON.parse((await dispatchToolCall(engine, 'recall', { limit: 50 }, { remote: false, sourceId: 'default' })).content[0].text).facts;
  expect(local).toHaveLength(4);
  const historical = JSON.parse((await dispatchToolCall(engine, 'recall', { limit: 50, include_expired: true }, { remote: false, sourceId: 'default' })).content[0].text).facts;
  expect(historical).toHaveLength(5);
  if (managed) {
    const page = await engine.getPage('projects/sample', { sourceId: 'default' });
    const fenced = parseFactsFence(page!.compiled_truth).facts.find(f => f.claim === temporary.fact);
    expect(new Date(fenced!.validUntil!).toISOString()).toBe(new Date(expires).toISOString());
    expect(page?.compiled_truth).toContain('## Facts');
  }
  await runFactsPipeline(turn, ctx);
  const replay = await engine.executeRaw<{ valid_until: string | Date }>('SELECT valid_until FROM facts WHERE fact=$1', [temporary.fact]);
  expect(replay.every(r => new Date(r.valid_until).toISOString() === new Date(expires).toISOString())).toBe(true);
}, 60_000);

test('an explicit private capture scope overrides a work classification', async () => {
  await setup(false, [candidate('Private scoped project detail.', 'work')]);
  await runFactsPipeline(turn, { engine, sourceId: 'default', sessionId: null, source: 'hook:writeback', remote: false, visibility: 'private' });
  const rows = await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts');
  expect(rows.map(r => r.visibility)).toEqual(['private']);
});

test('automatic recapture cannot publish an existing private claim or alter its history', async () => {
  await setup(false, [candidate('Previously private project detail.', 'work')]);
  const old = await engine.insertFact({ fact: 'Previously private project detail.', entity_slug: 'projects/sample', visibility: 'private', source: 'synthetic:prior', valid_from: new Date(observed), valid_until: new Date(expires) }, { source_id: 'default' });
  const before = await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [old.id]);
  await runFactsPipeline(turn, { engine, sourceId: 'default', sessionId: null, source: 'sweep:corpus', remote: false });
  expect(await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [old.id])).toEqual(before);
  expect(await engine.executeRaw("SELECT id FROM facts WHERE visibility='world'")).toHaveLength(0);
});

test('private pages, non-work identity, unknown project identity and remote callers cannot enable automatic sharing', async () => {
  for (const scenario of ['private-page', 'non-work', 'unknown-project', 'remote'] as const) {
    await setup(false, [candidate('A scoped synthetic detail.', 'work')]);
    if (scenario === 'private-page') await engine.putPage('projects/sample', { type: 'project', title: 'Sample', compiled_truth: 'Private fixture.', frontmatter: { visibility: 'private' } }, { sourceId: 'default' });
    if (scenario === 'unknown-project') await engine.deletePage('projects/sample', { sourceId: 'default' });
    if (scenario === 'non-work') await engine.putPage('projects/sample', { type: 'person', title: 'Sample', compiled_truth: 'A person, not a work identity.' }, { sourceId: 'default' });
    await runFactsPipeline(turn, { engine, sourceId: 'default', sessionId: null, source: 'hook:writeback', remote: scenario === 'remote' });
    expect((await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts')).map(r => r.visibility)).toEqual(['private']);
  }
});

test('expiry requires original literal timestamps and a valid bounded interval', () => {
  const meta = { capture_scope: 'work', capture_lifetime: 'temporary', observed_at: observed, valid_until: expires };
  expect(automaticCaptureDecision(meta, turn)?.validUntil?.toISOString()).toBe(new Date(expires).toISOString());
  expect(automaticCaptureDecision(meta, 'No original dates.')).toBeNull();
  for (const valid_until of [null, 'tomorrow', observed, '2025-02-30T12:00:00Z', '2027-01-02T12:00:00Z']) {
    expect(automaticCaptureDecision({ ...meta, valid_until }, `${turn} ${valid_until}`)).toBeNull();
  }
});

test('temporary capture preserves its original observation even when event grounding is off or proposes a later date', async () => {
  for (const managed of [false, true]) for (const grounding of ['off', 'on']) {
    await setup(managed, [candidate('The synthetic review is temporarily blocked.', 'work', 'temporary', { valid_from: '2026-01-01', valid_until: expires })]);
    await engine.setConfig('extraction.date_grounding', grounding);
    await runFactsPipeline(turn, { engine, sourceId: 'default', sessionId: null, source: 'sweep:corpus', remote: false, turnAt: new Date('2026-01-02T12:00:00Z') });
    const rows = await engine.executeRaw<{ valid_from: Date | string; valid_until: Date | string }>('SELECT valid_from,valid_until FROM facts');
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.valid_from).toISOString()).toBe(new Date(observed).toISOString());
    expect(new Date(rows[0]!.valid_until).toISOString()).toBe(new Date(expires).toISOString());
  }
}, 60_000);

test('folder restrictions on a target or origin clamp automatic sharing in both writers', async () => {
  for (const managed of [false, true]) for (const restricted of ['target', 'origin']) {
    await setup(managed, [candidate('A restricted synthetic project detail.', 'work')]);
    await proposeRevision(engine, 'default', [{ id: 'secret', prefix: restricted === 'target' ? 'projects/' : 'notes/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
    await runFactsPipeline(turn, { engine, sourceId: 'default', sessionId: null, source: 'hook:writeback', sourceSlug: 'notes/original', remote: false });
    expect((await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts')).map(r => r.visibility)).toEqual(['private']);
  }
}, 60_000);
