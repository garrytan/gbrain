/**
 * cathedral-6 D1b: `recall` honors federated grants. The fact arms route
 * through sourceScopeOpts — a remote caller whose token carries
 * allowedSources sees world facts across every granted source (the spec's
 * cross-agent continuity), while an ungranted source stays invisible and
 * private facts stay local-only. Single-source callers keep the exact
 * pre-v1 single-query path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { clampRecallLimit } from '../src/core/ops/facts.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctx(over: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    ...over,
  } as unknown as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  for (const id of ['aurora-workspace', 'proj-widget', 'nova-notes']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id],
    );
  }
  const remember = operationsByName['remember'];
  // B (writes proj-widget): a world fact — the cross-agent continuity payload.
  await remember.handler(
    ctx({ remote: true, sourceId: 'proj-widget' }),
    { fact: 'The payments provider decision is Stripe-shaped (test marker QQF1)', provenance: 'recall-federated test', visibility: 'world' },
  );
  // A private fact in proj-widget: must never cross to remote readers.
  await remember.handler(
    ctx({ remote: false, sourceId: 'proj-widget' }),
    { fact: 'Private hunch marker QQF2', provenance: 'recall-federated test', visibility: 'private' },
  );
  // A fact in an UNGRANTED source: must not leak through the federated arm.
  await remember.handler(
    ctx({ remote: true, sourceId: 'nova-notes' }),
    { fact: 'Ungranted-source marker QQF3', provenance: 'recall-federated test', visibility: 'world' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall federated grants (D1b)', () => {
  const recall = () => operationsByName['recall'];

  it('a federated remote caller recalls world facts from a GRANTED foreign source', async () => {
    const res: any = await recall().handler(
      ctx({
        remote: true,
        sourceId: 'aurora-workspace',
        auth: { allowedSources: ['aurora-workspace', 'proj-widget'] },
      }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(true);
    expect(facts.some((f: string) => f.includes('QQF3'))).toBe(false); // ungranted source
    expect(facts.some((f: string) => f.includes('QQF2'))).toBe(false); // private stays hidden
  });

  it('without the federated grant the foreign source stays invisible (scalar path)', async () => {
    const res: any = await recall().handler(
      ctx({ remote: true, sourceId: 'aurora-workspace' }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(false);
  });

  it('an empty allowedSources array is a deny-not-widen: scalar source only', async () => {
    const res: any = await recall().handler(
      ctx({ remote: true, sourceId: 'proj-widget', auth: { allowedSources: [] } }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(true);  // own scalar source
    expect(facts.some((f: string) => f.includes('QQF3'))).toBe(false); // never widened
  });

  it('the since arm fans out across the federated grant too (not just the no-filter arm)', async () => {
    const res: any = await recall().handler(
      ctx({
        remote: true,
        sourceId: 'aurora-workspace',
        auth: { allowedSources: ['aurora-workspace', 'proj-widget'] },
      }),
      { since: '2000-01-01' },
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(true);  // granted foreign source
    expect(facts.some((f: string) => f.includes('QQF3'))).toBe(false); // ungranted source
    expect(facts.some((f: string) => f.includes('QQF2'))).toBe(false); // private stays hidden
  });

  it('local trusted caller still reads private facts (visibility unchanged)', async () => {
    const res: any = await recall().handler(
      ctx({ remote: false, sourceId: 'proj-widget' }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF2'))).toBe(true);
  });

  it('a private superseded fact is invisible to a remote supersessions=true call', async () => {
    const remember = operationsByName['remember'];
    await remember.handler(
      ctx({ remote: false, sourceId: 'proj-widget' }),
      { fact: 'Private superseded marker QQF4', provenance: 'recall-federated test', visibility: 'private' },
    );
    await remember.handler(
      ctx({ remote: true, sourceId: 'proj-widget' }),
      { fact: 'World superseded marker QQF5', provenance: 'recall-federated test', visibility: 'world' },
    );
    // Put both into the supersession audit-log shape (expired_at +
    // superseded_by both set). Self-reference keeps the FK satisfied.
    await engine.executeRaw(
      `UPDATE facts SET expired_at = now(), superseded_by = id
       WHERE fact LIKE '%QQF4%' OR fact LIKE '%QQF5%'`,
    );

    // Remote federated caller: the audit arm filters visibility at the
    // ENGINE level (before each source's LIMIT) — the private row must
    // never surface.
    const remoteRes: any = await recall().handler(
      ctx({
        remote: true,
        sourceId: 'aurora-workspace',
        auth: { allowedSources: ['aurora-workspace', 'proj-widget'] },
      }),
      { supersessions: true },
    );
    const remoteFacts = (remoteRes.facts ?? []).map((f: any) => String(f.fact));
    expect(remoteFacts.some((f: string) => f.includes('QQF5'))).toBe(true);  // world audit row visible
    expect(remoteFacts.some((f: string) => f.includes('QQF4'))).toBe(false); // private stays hidden

    // Local trusted caller still sees the private audit row.
    const localRes: any = await recall().handler(
      ctx({ remote: false, sourceId: 'proj-widget' }),
      { supersessions: true },
    );
    const localFacts = (localRes.facts ?? []).map((f: any) => String(f.fact));
    expect(localFacts.some((f: string) => f.includes('QQF4'))).toBe(true);
  });

  it('with limit=1 and the newest supersession private, a remote call still returns the older world row', async () => {
    // Pre-fix ordering bug: the post-merge visibility filter let the private
    // newest row consume the single limit slot at the engine, then filtered
    // it away → empty response instead of the older world-visible row.
    // Own source so the earlier supersession test's rows can't take the slot.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('sup-limit', 'sup-limit') ON CONFLICT (id) DO NOTHING`,
    );
    const remember = operationsByName['remember'];
    await remember.handler(
      ctx({ remote: false, sourceId: 'sup-limit' }),
      { fact: 'Private newest superseded marker QQF6', provenance: 'recall-federated test', visibility: 'private' },
    );
    await remember.handler(
      ctx({ remote: true, sourceId: 'sup-limit' }),
      { fact: 'World older superseded marker QQF7', provenance: 'recall-federated test', visibility: 'world' },
    );
    // Audit-log shape with DISTINCT expired_at: the private row is NEWEST.
    await engine.executeRaw(
      `UPDATE facts SET expired_at = now(), superseded_by = id WHERE fact LIKE '%QQF6%'`,
    );
    await engine.executeRaw(
      `UPDATE facts SET expired_at = now() - interval '1 hour', superseded_by = id WHERE fact LIKE '%QQF7%'`,
    );

    const res: any = await recall().handler(
      ctx({ remote: true, sourceId: 'sup-limit' }),
      { supersessions: true, limit: 1 },
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.length).toBe(1);
    expect(facts[0]).toContain('QQF7');
    expect(facts.some((f: string) => f.includes('QQF6'))).toBe(false);
  });

  it('include_pending sums pending-consolidation counts across the federated grant', async () => {
    const remember = operationsByName['remember'];
    await remember.handler(
      ctx({ remote: true, sourceId: 'aurora-workspace' }),
      { fact: 'Pending marker QQF8', provenance: 'recall-federated test', visibility: 'world' },
    );
    const a = await engine.countUnconsolidatedFacts('aurora-workspace');
    const b = await engine.countUnconsolidatedFacts('proj-widget');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);

    const res: any = await recall().handler(
      ctx({
        remote: true,
        sourceId: 'aurora-workspace',
        auth: { allowedSources: ['aurora-workspace', 'proj-widget'] },
      }),
      { include_pending: true },
    );
    // Sum over the SAME factSources set the fact arms fan out across — not
    // just the scalar sourceId (which would report `a` alone).
    expect(res.pending_consolidation_count).toBe(a + b);
  });
});

describe('clampRecallLimit (per-arm cap, applied once before the fan-out)', () => {
  it('caps valid integers at 100 and passes small ones through', () => {
    expect(clampRecallLimit(150)).toBe(100);
    expect(clampRecallLimit(100)).toBe(100);
    expect(clampRecallLimit(7)).toBe(7);
    expect(clampRecallLimit(1)).toBe(1);
  });

  it('invalid input (undefined / NaN / non-positive / non-integer) → default 50', () => {
    expect(clampRecallLimit(undefined)).toBe(50);
    expect(clampRecallLimit(NaN)).toBe(50);
    expect(clampRecallLimit(-1)).toBe(50);
    expect(clampRecallLimit(0)).toBe(50);
    expect(clampRecallLimit(3.7)).toBe(50);
    expect(clampRecallLimit('25' as unknown)).toBe(50);
    expect(clampRecallLimit(Infinity)).toBe(50);
  });
});
