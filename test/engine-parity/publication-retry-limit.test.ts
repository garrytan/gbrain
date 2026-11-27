/**
 * Engine parity for the publication retry limit (persistence/capability-retry.ts): a write its engine refuses at
 * publication with the typed capability refusal is claimed again at most PUBLICATION_CAPABILITY_ATTEMPTS times, then
 * ends failed with that refusal; its waiter gets the typed error, never write_pending, and the next write in the same
 * source commits.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a publication-stage `engine_capability_missing` refusal (here injected at the before_commit boundary, so
 *    every arm sees the same refusal) ends the request `failed` with code engine_capability_missing, its stored detail
 *    names the stage and the claim count; the waiter's error is that code with the capability as its reason and the
 *    member in its detail; a second write to the same source commits. Over MCP (dispatchToolCall, stdio and http) the
 *    same refusal comes back inside the tool result.
 *  - Regression: coordinator.ts finishUnpublishedFailure released every publication-stage capability refusal back to
 *    queued with no limit, so the consumer re-claimed it forever, the waiter got write_pending (cause_unknown), and
 *    every later write to the source waited behind it. On the baseline these cases end write_pending.
 *  - Why existing coverage misses it: the other parity cases hit the refusal only through real Rust members (and
 *    test/engine-parity/bench-save-repro.test.ts covers those), and the persistence suites never refuse at publication.
 *  - Seam: the persistence fault hook (fault-points.ts), the one the persistence gate's workers use; real engines and
 *    the real consumer, operation handlers and MCP dispatcher otherwise.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { PUBLICATION_CAPABILITY_ATTEMPTS, countedCapabilityRefusalsForTests, resetCapabilityRefusalsForTests } from '../../src/core/persistence/capability-retry.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';

const { parityTest } = parityArms(testBackends());
const WAIT_MS = 8000;
/** The contract, pinned apart from the constant that enforces it. */
const LIMIT = 3;

afterEach(() => { installFaultHook(undefined); resetCapabilityRefusalsForTests(); });

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'default', remote: false as const, writeWaitMs: WAIT_MS,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const put = async (engine: BrainEngine, slug: string, body: string) => {
  try {
    const r = await operations.find(o => o.name === 'put_page')!.handler(ctxFor(engine) as never, { slug, content: page(body) }) as Record<string, unknown>;
    return { ok: true, state: r.state ?? null };
  } catch (error) { return refusal(error); }
};
const page = (body: string) => `---\ntitle: Example\n---\n${body}.\n`;
/** The waiter's error and the receipt it carries, without the ids and times that differ per run. */
const refusal = (error: unknown) => {
  const e = error as { code?: string; reason?: string; detail?: unknown; writeRequest?: Record<string, unknown> };
  const receipt = e.writeRequest ?? {};
  return { ok: false, code: e.code ?? String(error), reason: e.reason ?? null, detail: e.detail ?? null,
    receipt: { state: receipt.state ?? null, write_error: receipt.write_error ?? null, write_error_detail: receipt.write_error_detail ?? null } };
};
/**
 * Refuses the first request that reaches the before_commit boundary, on every claim (or on its first `times` claims),
 * the way an engine that lacks a member does.
 */
const refuseFirstWrite = (times = Infinity) => {
  const refused = { id: undefined as string | undefined, claims: 0 };
  installFaultHook(async (point, detail) => {
    if (point !== 'publication:before_commit') return;
    refused.id ??= detail.requestId;
    if (detail.requestId !== refused.id) return;
    refused.claims++;
    if (refused.claims > times) return;
    throw capabilityMissing('page_versions', 'createVersion');
  });
  return refused;
};
const TYPED = { ok: false, code: 'engine_capability_missing', reason: 'page_versions', detail: 'member=createVersion capability=page_versions outcome=none written=nothing',
  receipt: { state: 'failed', write_error: 'engine_capability_missing', write_error_detail: { origin: 'engine_capability', stage: 'publication' } } };

describe('the publication retry limit', () => {
  parityTest('a write refused at publication ends failed and typed after the limit, and the next write in its source commits', { methods: ['insertWriteRequest', 'readWriteRequest', 'lockWriteRequest', 'releaseUnpublishedClaim', 'transaction', 'getPage'] }, async (engine) => {
    try {
      const refused = refuseFirstWrite();
      const started = performance.now();
      const first = await put(engine, 'notes/refused-example', 'refused');
      const ended = performance.now() - started < WAIT_MS;
      const next = await put(engine, 'notes/after-example', 'after');
      const stored = { refused: await engine.getPage('notes/refused-example', { sourceId: 'default' }) !== null,
        after: await engine.getPage('notes/after-example', { sourceId: 'default' }) !== null };
      const out = { limit: PUBLICATION_CAPABILITY_ATTEMPTS, first, claims: refused.claims, endedBeforeTheWait: ended, next, stored,
        stillCounted: countedCapabilityRefusalsForTests() };
      expect(out).toEqual({ limit: LIMIT, first: TYPED, claims: LIMIT, endedBeforeTheWait: true,
        next: { ok: true, state: 'committed' }, stored: { refused: false, after: true }, stillCounted: 0 });
      return out;
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  });

  parityTest('over MCP, put_page refused at publication answers the typed refusal in the tool result, on stdio and http', { methods: ['insertWriteRequest', 'readWriteRequest', 'lockWriteRequest', 'releaseUnpublishedClaim', 'transaction'] }, async (engine, backend) => {
    // http needs a remote credential. The Rust store keeps no legacy tokens or OAuth write grants (rust/docs/store/journal.md),
    // so a remote write on Rust is refused permission_denied at admission and never reaches publication: http runs on the SQL arms.
    const transports = backend === 'rust' ? ['stdio'] as const : ['stdio', 'http'] as const;
    const minted = backend === 'rust' ? null : await mintLegacyToken(engine, { name: `parity-${randomUUID()}`, scopes: ['read', 'write'], sourceGrant: ['default'], takesHolders: ['world'] });
    const call = async (slug: string, transport: 'stdio' | 'http') => {
      const opts = transport === 'stdio' ? { remote: false, sourceId: 'default' } : { remote: true, transport: 'http', sourceId: 'default', admissionOrigin: 'interactive', takesHoldersAllowList: ['world'],
        auth: { token: '', clientId: minted!.id, principal: { kind: 'legacy_token', id: minted!.id }, sourceId: 'default', allowedSources: ['default'], scopes: ['read', 'write'] } };
      const result = await dispatchToolCall(engine, 'put_page', { slug, content: page(slug), request_id: randomUUID() }, opts as never);
      const body = JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown> | null;
      return { isError: result.isError === true, error: body?.error ?? null, reason: body?.reason ?? null, state: body?.state ?? null };
    };
    const expected = { refused: { isError: true, error: 'engine_capability_missing', reason: 'page_versions', state: null },
      claims: LIMIT, next: { isError: false, error: null, reason: null, state: 'committed' } };
    try {
      const out: Record<string, unknown> = {};
      for (const transport of transports) {
        const refused = refuseFirstWrite();
        const first = await call(`notes/mcp-refused-${transport}`, transport);
        const claims = refused.claims;
        installFaultHook(undefined);
        out[transport] = { refused: first, claims, next: await call(`notes/mcp-after-${transport}`, transport) };
        expect({ transport, ...out[transport] as object }).toEqual({ transport, ...expected });
      }
      return out.stdio;
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  });

  parityTest('a write refused once at publication commits on its next claim, and its count is forgotten', { methods: ['insertWriteRequest', 'readWriteRequest', 'releaseUnpublishedClaim', 'transaction', 'getPage'] }, async (engine) => {
    try {
      const refused = refuseFirstWrite(1);
      const first = await put(engine, 'notes/retried-example', 'retried');
      const out = { first, claims: refused.claims, stored: await engine.getPage('notes/retried-example', { sourceId: 'default' }) !== null,
        stillCounted: countedCapabilityRefusalsForTests() };
      expect(out).toEqual({ first: { ok: true, state: 'committed' }, claims: 2, stored: true, stillCounted: 0 });
      return out;
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  });
});
