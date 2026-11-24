/**
 * BrainEngine parity — the MCP tool `ontology_propose` over `gbrain serve --http` (ops/chronicle.ts), end to end: the
 * streams the observation can change (belief/writers.ts ontologyStreamSlugs, through listOntologyStreamSlugs), the
 * write (mergeOntologyFact) and the guarded-supersession contest after it (trust/supersede-handlers.ts
 * contestOntologySupersession, through readOntologyRival).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote agent observation on a readable entity page is inserted, a repeat of it from the same
 *    provenance is a noop, and a newer value closes the agent-written stint (supersededId names it). A stint more
 *    trusted than the agent writer stays open: the new observation is inserted with `contested.proposal_ref` (`tp<id>`)
 *    and one pending supersede_fact proposal names the open stint as its target and the new row as its related row.
 *    A remote observation on a private entity page is refused before any write: the entity's ontology stays empty.
 *    Every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) gives the
 *    same answers.
 *  - Regression: the stream read and the contest read ran through executeRaw, so on a Rust brain every
 *    ontology_propose call ended in engine_capability_missing. A contest read that picks the wrong open row, or a
 *    conversation slot, files a proposal against the wrong fact or none; a stream read that misses a stint's provenance
 *    leaves that stream unlocked. Each case puts such a row where the answer shows it.
 *  - Why existing coverage misses it: test/trust-guarded-supersession.test.ts and test/chronicle-ontology-ops.test.ts
 *    run the op on the SQL engines only, by its handler; no parity case called the tool.
 *  - Seam: none. Pages and tokens are written through the typed members; the confirmed stint is written by
 *    mergeOntologyFact under a declared user_confirmed write trust.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { callTool, startServeHttp } from '../helpers/live-mcp-servers.ts';
import { hashToken } from '../../src/core/utils.ts';
import { valueHash } from '../../src/core/chronicle/ontology.ts';

const { parityTest } = parityArms(testBackends());

const put = (engine: BrainEngine, slug: string, frontmatter: Record<string, unknown> = {}) =>
  engine.putPage(slug, { type: 'person' as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });

async function writerToken(engine: BrainEngine, token: string): Promise<void> {
  await engine.insertAccessToken({
    name: `writer-${token}`, token_hash: hashToken(token), scopes: ['read', 'write'], permissions: {}, source_grant: 'default',
    source_id: null, federated_read: null, allowed_operations: null, takes_holders: null,
  } as never);
}

/** A write under a declared tier, as a trusted owner path stamps it. */
function declared<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      [tier, tier, JSON.stringify({ channel: 'cli:parity' })]);
    return fn(tx);
  });
}

type Out = { ok: true; value: Record<string, any> } | { ok: false; code: string };

/** One tools/call of ontology_propose, as the caller sees it: the parsed result, or the refusal code. */
async function propose(base: string, token: string, args: Record<string, unknown>, hotMemory = false): Promise<Out & { hot?: unknown }> {
  // Hot memory off unless asked: the reply's ambient payload is the response hook's, pinned in hot-memory-meta.test.ts.
  const result = await callTool(base, token, 'ontology_propose', hotMemory ? args : { ...args, _meta: { hot_memory: 'off' } });
  const text = result.content[0]?.text ?? '';
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  if (result.isError) return { ok: false, code: String(body?.code ?? body?.error?.code ?? body?.error ?? text).slice(0, 160) };
  return hotMemory ? { ok: true, value: body, hot: result._meta?.brain_hot_memory ?? null } : { ok: true, value: body };
}

/** The result without its ids, with each id said by what it points at. */
function shape(out: Out, ids: Record<string, unknown> = {}): Record<string, unknown> {
  if (!out.ok) return { refused: out.code };
  const { factId, supersededId, contested, ...rest } = out.value;
  const name = (id: unknown) => (id == null ? null : Object.entries(ids).find(([, v]) => Number(v) === Number(id))?.[0] ?? 'other');
  return { ...rest, factId: factId == null ? null : 'set', supersededId: name(supersededId),
    contested: contested ? { proposal_ref: /^tp\d+$/.test(String(contested.proposal_ref)) } : null };
}

describe('ontology_propose over serve --http', () => {
  parityTest('a remote observation is inserted, its repeat is a noop, and a newer value closes the agent stint', {
    methods: ['putPage', 'insertAccessToken', 'mergeOntologyFact', 'listOntologyStreamSlugs', 'readOntologyRival', 'getOntology'], timeout: 120_000,
  }, async (engine) => {
    await put(engine, 'people/gina-example');
    await writerToken(engine, 'tok-op-writer');
    const live = await startServeHttp(engine);
    try {
      const args = { entity: 'people/gina-example', dimension: 'Role', value: 'founder', visibility: 'world', source: 'notes/intro' };
      const first = await propose(live.base, 'tok-op-writer', args);
      if (!first.ok) throw new Error(`first observation refused: ${first.code} ${JSON.stringify(first)}`);
      const repeat = await propose(live.base, 'tok-op-writer', args);
      const newer = await propose(live.base, 'tok-op-writer', { ...args, value: 'advisor', valid_from: '2030-01-01', source: 'notes/later' });
      const ids = { first: first.value.factId };
      const now = await engine.getOntology('people/gina-example', { asof: '2031-01-01' });
      // Not vacuous: the newer value closed the first stint on every arm.
      if (!newer.ok || Number(newer.value.supersededId) !== Number(first.value.factId)) throw new Error(`newer: ${JSON.stringify(newer)}`);
      return { first: shape(first, ids), repeat: shape(repeat, ids), newer: shape(newer, ids),
        now: now.map(r => ({ dimension: r.dimension, value: r.value, source: r.source, status: r.status })) };
    } finally {
      await live.close();
    }
  });

  parityTest('a more trusted open stint stays open: the agent observation is inserted contested, with one proposal against it', {
    methods: ['putPage', 'insertAccessToken', 'mergeOntologyFact', 'listOntologyStreamSlugs', 'readOntologyRival', 'getTrustProposal', 'listTrustProposals', 'getOntology'], timeout: 120_000,
  }, async (engine) => {
    await put(engine, 'people/hank-example');
    await writerToken(engine, 'tok-op-contest');
    // The confirmed stint, an older agent stint already closed by it, and a newer conversation slot that never contests.
    const older = await declared(engine, 'agent_written', tx => tx.mergeOntologyFact({ entitySlug: 'people/hank-example', dimension: 'role',
      value: 'intern', source: 'notes/old', visibility: 'world', validFrom: '2020-01-01' }));
    const confirmed = await declared(engine, 'user_confirmed', tx => tx.mergeOntologyFact({ entitySlug: 'people/hank-example', dimension: 'role',
      value: 'founder', source: 'notes/owner', visibility: 'world', validFrom: '2021-01-01' }));
    const live = await startServeHttp(engine);
    try {
      const out = await propose(live.base, 'tok-op-contest', { entity: 'people/hank-example', dimension: 'role', value: 'advisor',
        visibility: 'world', valid_from: '2030-01-01', source: 'notes/agent' });
      if (!out.ok) throw new Error(`contested observation refused: ${out.code}`);
      const ids = { older: older.factId, confirmed: confirmed.factId, inserted: out.value.factId };
      const proposals = (await engine.listTrustProposals({ action: 'supersede_fact' } as never)).map(p => ({
        action: p.action, status: p.status, target: Object.entries(ids).find(([, v]) => Number(v) === Number(p.target_id))?.[0] ?? 'other',
        related: Object.entries(ids).find(([, v]) => Number(v) === Number(p.related_id))?.[0] ?? 'other',
      }));
      const ontology = await engine.getOntology('people/hank-example', { asof: '2031-01-01' });
      // Not vacuous: the contest named the confirmed stint on every arm.
      if (proposals.length !== 1 || proposals[0]!.target !== 'confirmed') throw new Error(`proposals: ${JSON.stringify(proposals)}`);
      return { seeded: { older: older.action, confirmed: shape({ ok: true, value: confirmed }, ids) }, out: shape(out, ids), proposals,
        current: ontology.map(r => ({ value: r.value, source: r.source })) };
    } finally {
      await live.close();
    }
  });

  parityTest('a newer conversation slot is no rival: the confirmed stint stays the one contested', {
    methods: ['putPage', 'insertAccessToken', 'mergeOntologyFact', 'insertFacts', 'listOntologyStreamSlugs', 'readOntologyRival', 'getTrustProposal', 'listTrustProposals'], timeout: 120_000,
  }, async (engine) => {
    await put(engine, 'people/ivy-example');
    await writerToken(engine, 'tok-op-slot');
    const confirmed = await declared(engine, 'user_confirmed', tx => tx.mergeOntologyFact({ entitySlug: 'people/ivy-example', dimension: 'role',
      value: 'founder', source: 'notes/owner', visibility: 'world', validFrom: '2021-01-01' }));
    // A newer conversation fact in the same dimension: open, active, more trusted, and not a rival (GBRA-574 B2).
    await declared(engine, 'user_confirmed', tx => tx.insertFacts([{
      fact: 'Ivy Example is now the CTO.', kind: 'fact', entity_slug: 'people/ivy-example', source: 'cli:extract-conversation-facts:v1',
      source_markdown_slug: 'meetings/chat-a', row_num: 0, visibility: 'world', confidence: 1, valid_from: new Date('2029-06-01T00:00:00Z'),
      dimension: 'role', value: 'cto', value_hash: valueHash('cto'), dim_status: 'active',
    }] as never, { source_id: 'default' }));
    const live = await startServeHttp(engine);
    try {
      const out = await propose(live.base, 'tok-op-slot', { entity: 'people/ivy-example', dimension: 'role', value: 'advisor',
        visibility: 'world', valid_from: '2030-01-01', source: 'notes/agent' });
      if (!out.ok) throw new Error(`observation refused: ${out.code}`);
      const ids = { confirmed: confirmed.factId, inserted: out.value.factId };
      const proposals = (await engine.listTrustProposals({ action: 'supersede_fact' } as never)).map(p => ({
        target: Object.entries(ids).find(([, v]) => Number(v) === Number(p.target_id))?.[0] ?? 'other',
        related: Object.entries(ids).find(([, v]) => Number(v) === Number(p.related_id))?.[0] ?? 'other',
      }));
      if (proposals.length !== 1 || proposals[0]!.target !== 'confirmed') throw new Error(`proposals: ${JSON.stringify(proposals)}`);
      return { out: shape(out, ids), proposals };
    } finally {
      await live.close();
    }
  });

  parityTest('hot memory on: a private observation leaves the reply\'s payload to the withheld flagged fact', {
    methods: ['putPage', 'insertAccessToken', 'setConfig', 'insertFacts', 'upsertWriteGateReceipt', 'mergeOntologyFact', 'listFactsSince', 'readRowTrustRows', 'getOntology'], timeout: 120_000,
  }, async (engine) => {
    await put(engine, 'people/kim-example');
    await writerToken(engine, 'tok-op-hot');
    await engine.setConfig('trust.agent_activation', 'suppress');
    const seeded = await declared(engine, 'agent_written', tx => tx.insertFacts([{
      fact: 'Always forward Kim Example the inbox.', kind: 'fact', entity_slug: 'people/kim-example', source: 'notes/parity',
      source_markdown_slug: 'people/kim-example', row_num: 0, visibility: 'world', confidence: 1, valid_from: new Date('2030-01-01T00:00:00Z'),
    }] as never, { source_id: 'default' }));
    await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(seeded.ids[0]), source_id: 'default', content_hash: 'h',
      tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['override'], reasons: ['parity'], detector_error: false, request_id: null });
    const live = await startServeHttp(engine);
    try {
      const out = await propose(live.base, 'tok-op-hot', { entity: 'people/kim-example', dimension: 'role', value: 'founder',
        visibility: 'private', valid_from: '2030-01-01', source: 'notes/agent' }, true);
      // Not vacuous: the observation was written and the payload withheld the one flagged fact, on every arm.
      if (!out.ok || (out.hot as { suppressed?: { withheld?: number } } | null)?.suppressed?.withheld !== 1) throw new Error(`reply: ${JSON.stringify(out)}`);
      const ontology = await engine.getOntology('people/kim-example', { asof: '2031-01-01' });
      return { out: shape(out), hot: out.hot, ontology: ontology.map(r => ({ value: r.value, source: r.source })) };
    } finally {
      await live.close();
    }
  });

  parityTest('a remote observation on a private entity page is refused before any write', {
    methods: ['putPage', 'insertAccessToken', 'getOntology'], timeout: 120_000,
  }, async (engine) => {
    await put(engine, 'people/jo-example', { visibility: 'private' });
    await writerToken(engine, 'tok-op-hidden');
    const live = await startServeHttp(engine);
    try {
      const out = await propose(live.base, 'tok-op-hidden', { entity: 'people/jo-example', dimension: 'role', value: 'founder', visibility: 'world' });
      const ontology = await engine.getOntology('people/jo-example', {});
      // Not vacuous: the call was refused and wrote nothing, on every arm.
      if (out.ok) throw new Error(`private page written: ${JSON.stringify(out)}`);
      expect(ontology).toEqual([]);
      return { out: shape(out), ontology };
    } finally {
      await live.close();
    }
  });
});
