/**
 * Parity for the label guard's tier read (`readLabelGuardTiers`, engine-sql/label-door.ts) and the local put_page update
 * of a labelled page that reads it (trust/page-write.ts `labelGuardTier`, from page-prepare.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the read answers the page's label guard tier (`owner_set`, or null) and the `prior_tier` of every `lower_page`
 *    proposal of the page that is not accepted and newer than its last accepted one that was not a labels-only accept
 *    (`priors`); and a local put_page that updates a private page commits, while one that drops the private label of a
 *    page whose owner raised its guard is held (the label is kept).
 *  - Regression: labelGuardTier read the guard and the proposals through raw SQL, which the Rust engine refuses, so on a
 *    Rust brain a local put_page update of a page that is private by its labels or names readers failed (GBEV-98 #3).
 *  - Why existing coverage misses it: test/owner-label-guard.test.ts runs PGLite and Postgres only.
 *  - Seam: none. Real engines; the proposals are inserted and moved through the trust proposal members, as the trust
 *    decisions do.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { operations } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'default', remote: false as const, writeWaitMs: 8000,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const put = async (engine: BrainEngine, slug: string, content: string) => {
  try {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const r = await operations.find(o => o.name === 'put_page')!.handler(ctxFor(engine) as never,
      { slug, content, request_id: randomUUID(), ...(snapshot ? { expected_revision: snapshot.revision } : {}) }) as Record<string, unknown>;
    return { ok: true, state: r.state ?? null, kept: (r.privacy_labels_kept as { keys?: string[] } | undefined)?.keys ?? null };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? String(e) };
  }
};
const note = (body: string, visibility?: string) => `---\ntype: note\ntitle: Guarded\n${visibility ? `visibility: ${visibility}\n` : ''}---\n\n${body}\n`;

describe('engine parity: the label guard tiers', () => {
  parityTest('readLabelGuardTiers answers the owner-set tier and the open lower_page priors', {
    methods: ['putPage', 'writePageLabelGuard', 'insertTrustProposal', 'transitionTrustProposal', 'readLabelGuardTiers'],
  }, async (engine) => {
    const page = await engine.putPage('notes/tiers', { type: 'note', title: 'Tiers', compiled_truth: 'Tiers.', timeline: '', frontmatter: {} });
    const id = Number(page.id);
    const lower = (prior: string) => engine.insertTrustProposal({ action: 'lower_page', sourceId: 'default', target: { table: 'pages', id },
      before: { slug: 'notes/tiers', prior_tier: prior }, after: {}, proposer: 'agent_page_edit' });
    const out: Record<string, unknown> = { none: await engine.readLabelGuardTiers(id) };
    await engine.writePageLabelGuard(id, 'operator_curated');
    const a = await lower('user_curated');
    out.guardAndOnePending = await engine.readLabelGuardTiers(id);
    // An accept cuts off the priors before it; a labels-only accept does not.
    await engine.transitionTrustProposal(a.id, 'pending', 'accepted', { after: { resolution: 'labels_applied' } });
    const b = await lower('agent_written');
    out.labelsOnlyAccept = await engine.readLabelGuardTiers(id);
    await engine.transitionTrustProposal(b.id, 'pending', 'accepted', { after: {} });
    const c = await lower('operator_curated');
    await engine.transitionTrustProposal(c.id, 'pending', 'rejected', {});
    out.afterAccept = await engine.readLabelGuardTiers(id);
    await engine.writePageLabelGuard(id, null);
    out.guardRemoved = await engine.readLabelGuardTiers(id);
    out.unknownPage = await engine.readLabelGuardTiers(987_654);
    const sorted = (v: unknown) => { const r = v as { owner_set: string | null; priors: (string | null)[] }; return { owner_set: r.owner_set, priors: [...r.priors].sort() }; };
    const shaped = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, sorted(v)]));
    expect(shaped).toEqual({
      none: { owner_set: null, priors: [] },
      guardAndOnePending: { owner_set: 'operator_curated', priors: ['user_curated'] },
      labelsOnlyAccept: { owner_set: 'operator_curated', priors: ['agent_written'] },
      afterAccept: { owner_set: 'operator_curated', priors: ['operator_curated'] },
      guardRemoved: { owner_set: null, priors: ['operator_curated'] },
      unknownPage: { owner_set: null, priors: [] },
    });
    return shaped;
  });

  parityTest('a local put_page update of a private page commits, and one that drops an owner-guarded label is held', {
    methods: ['readLabelGuardTiers', 'writePageLabelGuard', 'getPage', 'readPageSnapshot'],
  }, async (engine) => {
    try {
      const out: Record<string, unknown> = {};
      out.created = await put(engine, 'notes/guarded', note('First body.', 'private'));
      out.updated = await put(engine, 'notes/guarded', note('Second body.', 'private'));
      const page = await engine.getPage('notes/guarded', { sourceId: 'default' } as never);
      await engine.writePageLabelGuard(Number(page!.id), 'operator_curated');
      out.dropped = await put(engine, 'notes/guarded', note('Third body.'));
      const after = await engine.getPage('notes/guarded', { sourceId: 'default' } as never);
      out.after = { visibility: (after!.frontmatter as Record<string, unknown>).visibility ?? null, third: String(after!.compiled_truth).includes('Third body.') };
      expect(out).toEqual({
        created: { ok: true, state: 'committed', kept: null },
        updated: { ok: true, state: 'committed', kept: null },
        dropped: { ok: true, state: 'committed', kept: ['visibility'] },
        after: { visibility: 'private', third: true },
      });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });
});
