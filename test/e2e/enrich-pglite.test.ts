/**
 * v0.41.39 (#1700) — hermetic PGLite e2e for `gbrain enrich`.
 *
 * Covers both layers: the source-aware `listEnrichCandidates` engine method,
 * and the `runEnrichCore` synthesis pipeline (via the `synthesizeFn` DI seam so
 * no API key / no mock.module → stays parallel-safe). Privacy: placeholder
 * names only (alice-example, widget-co, …).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  runEnrichCore,
  enrichFingerprint,
  CHECKPOINT_OP,
  type SynthesizeFn,
} from '../../src/commands/enrich.ts';
import { recordCompleted, loadOpCheckpoint } from '../../src/core/op-checkpoint.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { BudgetExhausted, BudgetTracker } from '../../src/core/budget/budget-tracker.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// --- helpers ---------------------------------------------------------------

const STUB = 'Stub page.';
const RICH_CONTEXT =
  'Alice Example co-founded WidgetCo in 2025 and leads its product design team. ' +
  'She previously built the finance UI at a large company, presented the new design ' +
  'system at the 2026 summit, and recently closed the seed round led by Fund A.';

async function seedStub(slug: string, title: string, type: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, {
    type: type as never,
    title,
    compiled_truth: STUB,
    timeline: '',
    frontmatter,
  });
}

/** Seed a linking page and an inbound link with rich context (drives grounding + inbound_count). */
async function seedLinkInto(toSlug: string, fromSlug: string, context: string) {
  await engine.putPage(fromSlug, {
    type: 'note' as never,
    title: fromSlug,
    compiled_truth: `Notes referencing ${toSlug}.`,
    timeline: '',
    frontmatter: {},
  });
  await engine.addLink(fromSlug, toSlug, context);
}

const goodSynth: SynthesizeFn = async () =>
  '## Overview\nAlice Example founded WidgetCo and leads design. [Source: meetings/2026-summit]\n\n## Role\nProduct design lead.';

// ---------------------------------------------------------------------------
// Engine method: listEnrichCandidates
// ---------------------------------------------------------------------------

describe('listEnrichCandidates', () => {
  test('thin-filters, scopes to types, counts inbound source-correctly, orders + limits', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedStub('people/bob-example', 'Bob Example', 'person');
    await seedStub('companies/widget-co', 'Widget Co', 'company');
    // A long page (not thin) AND a non-target type — must be excluded twice over.
    await engine.putPage('wiki/long-essay', {
      type: 'note' as never,
      title: 'Long Essay',
      compiled_truth: 'x'.repeat(900),
      timeline: '',
      frontmatter: {},
    });

    // Inbound links: bob ← 2, alice ← 1, widget ← 0.
    await seedLinkInto('people/bob-example', 'meetings/m1', 'Bob context one.');
    await seedLinkInto('people/bob-example', 'meetings/m2', 'Bob context two.');
    await seedLinkInto('people/alice-example', 'meetings/m3', 'Alice context.');

    const cands = await engine.listEnrichCandidates({
      types: ['person', 'company'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
    });
    const slugs = cands.map((c) => c.slug);
    expect(slugs).toContain('people/alice-example');
    expect(slugs).toContain('people/bob-example');
    expect(slugs).toContain('companies/widget-co');
    expect(slugs).not.toContain('wiki/long-essay');

    // Ordering by inbound DESC: bob (2) before alice (1) before widget (0).
    expect(slugs.indexOf('people/bob-example')).toBeLessThan(slugs.indexOf('people/alice-example'));
    expect(slugs.indexOf('people/alice-example')).toBeLessThan(slugs.indexOf('companies/widget-co'));

    const bob = cands.find((c) => c.slug === 'people/bob-example')!;
    expect(bob.inbound_count).toBe(2);
    expect(bob.body_len).toBe(STUB.length);
    expect(bob.type).toBe('person');
  });

  test('types filter narrows to companies only', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    await seedStub('companies/widget-co', 'Widget', 'company');
    const cands = await engine.listEnrichCandidates({
      types: ['company'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
    });
    expect(cands.map((c) => c.slug)).toEqual(['companies/widget-co']);
  });

  test('empty types → no rows, no SQL', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    const cands = await engine.listEnrichCandidates({
      types: [],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
    });
    expect(cands).toEqual([]);
  });

  test('limit caps the result set', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    await seedStub('people/bob-example', 'Bob', 'person');
    await seedLinkInto('people/bob-example', 'meetings/m1', 'ctx');
    const cands = await engine.listEnrichCandidates({
      types: ['person'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 1,
    });
    expect(cands.length).toBe(1);
    expect(cands[0].slug).toBe('people/bob-example'); // highest inbound
  });

  test('recency guard excludes recently-enriched pages', async () => {
    await seedStub('people/fresh', 'Fresh', 'person', {
      enriched_at: new Date().toISOString(),
    });
    await seedStub('people/stale', 'Stale', 'person', {
      enriched_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    });
    await seedStub('people/never', 'Never', 'person'); // no enriched_at
    const cands = await engine.listEnrichCandidates({
      types: ['person'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
      reenrichAfterMs: 30 * 86_400_000, // 30d window
    });
    const slugs = cands.map((c) => c.slug);
    expect(slugs).toContain('people/stale');   // enriched 90d ago → eligible
    expect(slugs).toContain('people/never');   // never enriched → eligible
    expect(slugs).not.toContain('people/fresh'); // enriched today → guarded out
  });

  test('source scope excludes other sources', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    // Register the second source (FK target) before seeding a page into it.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.putPage('people/remote-only', {
      type: 'person' as never, title: 'Remote', compiled_truth: STUB, timeline: '', frontmatter: {},
    }, { sourceId: 'other' });
    const cands = await engine.listEnrichCandidates({
      types: ['person'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
      sourceId: 'default',
    });
    const slugs = cands.map((c) => c.slug);
    expect(slugs).toContain('people/alice-example');
    expect(slugs).not.toContain('people/remote-only');
  });
});

// ---------------------------------------------------------------------------
// runEnrichCore: synthesis pipeline (stubbed synthesizeFn)
// ---------------------------------------------------------------------------

describe('runEnrichCore', () => {
  test('thin page with scattered context → grown + cited + provenance stamped', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: goodSynth,
    });
    expect(r.pages_enriched).toBe(1);
    expect(r.pages_skipped_insufficient).toBe(0);

    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page).toBeTruthy();
    expect(page!.compiled_truth).toContain('## Overview');
    expect(page!.compiled_truth).toContain('[Source: meetings/2026-summit]');
    expect(page!.frontmatter.enriched_by).toBe('cli:enrich');
    expect(typeof page!.frontmatter.enriched_at).toBe('string');
  }, 30000);

  test('no context → skipped_insufficient, no write, no LLM call', async () => {
    await seedStub('people/zxqwv-unique', 'Zxqwv Unique-Token', 'person');
    let called = false;
    const synth: SynthesizeFn = async () => { called = true; return 'should not run'; };

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: synth,
    });
    expect(called).toBe(false);
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_insufficient).toBe(1);

    const page = await engine.getPage('people/zxqwv-unique', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('model returns SKIP → skipped, no write', async () => {
    await seedStub('people/erin-example', 'Erin Example', 'person');
    await seedLinkInto('people/erin-example', 'meetings/sync', RICH_CONTEXT);
    const skipSynth: SynthesizeFn = async () => 'SKIP';

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: skipSynth,
    });
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_insufficient).toBe(1);
    const page = await engine.getPage('people/erin-example', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('#2504: a failing page surfaces first_failure (pool.failures no longer write-only)', async () => {
    await seedStub('people/fiona-example', 'Fiona Example', 'person');
    await seedLinkInto('people/fiona-example', 'meetings/kickoff', RICH_CONTEXT);
    const failingSynth: SynthesizeFn = async () => {
      throw new Error('no pricing entry for model "example:example-chat" (kind=chat)');
    };

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: failingSynth,
    });
    // Pre-fix: pages_failed:1 with zero reason anywhere. Post-fix the result
    // carries slug + message so the operator sees WHY instead of guessing.
    expect(r.pages_failed).toBe(1);
    expect(r.first_failure).toContain('people/fiona-example');
    expect(r.first_failure).toContain('no pricing entry');
  }, 30000);

  test('resume: pre-seeded checkpoint skips an already-completed page', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedStub('people/bob-example', 'Bob Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/a', RICH_CONTEXT);
    await seedLinkInto('people/bob-example', 'meetings/b', RICH_CONTEXT);

    const fp = enrichFingerprint({
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
    });
    await recordCompleted(engine, { op: 'enrich', fingerprint: fp }, ['default|people/alice-example']);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      synthesizeFn: goodSynth,
    });
    // alice was checkpointed → skipped; only bob enriched.
    expect(r.pages_enriched).toBe(1);
    const alice = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(alice!.compiled_truth.trim()).toBe(STUB); // untouched
    const bob = await engine.getPage('people/bob-example', { sourceId: 'default' });
    expect(bob!.compiled_truth).toContain('## Overview');
  }, 30000);

  test('budget exhausted mid-run → partial, budget_exhausted flag', async () => {
    await seedStub('people/p1', 'P1 Example', 'person');
    await seedStub('people/p2', 'P2 Example', 'person');
    await seedStub('people/p3', 'P3 Example', 'person');
    await seedLinkInto('people/p1', 'meetings/m1', RICH_CONTEXT);
    await seedLinkInto('people/p2', 'meetings/m2', RICH_CONTEXT);
    await seedLinkInto('people/p3', 'meetings/m3', RICH_CONTEXT);

    let n = 0;
    const budgetSynth: SynthesizeFn = async () => {
      n++;
      if (n >= 2) {
        throw new BudgetExhausted('cap hit', { reason: 'cost', spent: 10, cap: 5 });
      }
      return goodSynth({ system: '', user: '', model: 'test:model' });
    };

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      workers: 1, // deterministic abort point
      synthesizeFn: budgetSynth,
    });
    expect(r.budget_exhausted).toBe(true);
    expect(r.pages_enriched).toBe(1); // only the first synthesized before the cap
    // cost abort → reason surfaces so the CLI prints the raise-the-cap advice.
    expect(r.budget_exhausted_reason).toBe('cost');
  }, 30000);

  test('no_pricing abort surfaces reason + model (#4032)', async () => {
    await seedStub('people/p1', 'P1 Example', 'person');
    await seedLinkInto('people/p1', 'meetings/m1', RICH_CONTEXT);

    // TX2 shape: an unpriced model hard-fails reserve() on the FIRST call of a
    // capped run. Pre-fix the CLI collapsed this into "Budget cap reached" —
    // the reason/model never reached the result.
    const noPricingSynth: SynthesizeFn = async () => {
      throw new BudgetExhausted('no pricing for model', {
        reason: 'no_pricing',
        spent: 0,
        cap: 5,
        modelId: 'azure-openai:text-embedding-3-large',
      });
    };
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      workers: 1,
      synthesizeFn: noPricingSynth,
    });
    expect(r.budget_exhausted).toBe(true);
    expect(r.budget_exhausted_reason).toBe('no_pricing');
    expect(r.budget_exhausted_model).toBe('azure-openai:text-embedding-3-large');
  }, 30000);

  test('budget abort flushes checkpoint so resume skips completed (P2#1)', async () => {
    await seedStub('people/p1', 'P1 Example', 'person');
    await seedStub('people/p2', 'P2 Example', 'person');
    await seedLinkInto('people/p1', 'meetings/m1', RICH_CONTEXT);
    await seedLinkInto('people/p2', 'meetings/m2', RICH_CONTEXT);

    let n = 0;
    const budgetSynth: SynthesizeFn = async () => {
      n++;
      if (n >= 2) throw new BudgetExhausted('cap hit', { reason: 'cost', spent: 10, cap: 5 });
      return goodSynth({ system: '', user: '', model: 'test:model' });
    };

    const fpOpts = {
      sourceId: 'default',
      types: ['person'] as const,
      order: 'inbound-links' as const,
      thinThreshold: 400,
      model: 'test:model',
    };
    const r = await runEnrichCore(engine, { ...fpOpts, types: ['person'], workers: 1, synthesizeFn: budgetSynth });
    expect(r.budget_exhausted).toBe(true);
    expect(r.pages_enriched).toBe(1);

    // Fix D: the page completed before the abort (< the 25-item periodic flush)
    // was flushed to the checkpoint in the BudgetExhausted catch, so a resume
    // would skip it instead of re-charging. Pre-fix this set was empty.
    const fp = enrichFingerprint({ ...fpOpts, types: ['person'] });
    const done = await loadOpCheckpoint(engine, { op: CHECKPOINT_OP, fingerprint: fp });
    expect(done).toContain('default|people/p1');
  }, 30000);

  test('final-call budget overage is flagged post-hoc (P1#3)', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/x', RICH_CONTEXT);

    // Simulate the gateway swallowing a final-call BudgetExhausted: an external
    // tracker whose cumulative spend already exceeds its cap, with no throw
    // reaching runEnrichCore. record() updates cumulative THEN throws (TX1), so
    // catching the throw leaves totalSpent > cap.
    const tracker = new BudgetTracker({ maxCostUsd: 0.01, label: 'test' });
    try {
      tracker.record({ modelId: 'anthropic:claude-sonnet-4-6', inputTokens: 100_000_000, outputTokens: 0, kind: 'chat' });
    } catch { /* TX1 cost throw expected */ }
    expect(tracker.totalSpent).toBeGreaterThan(0.01); // precondition: pricing resolved

    // body() returns normally (SKIP → no further spend), but the tracker is over
    // cap → Fix C's post-hoc guard sets budget_exhausted. Pre-fix it was unset.
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: async () => 'SKIP',
      budgetTracker: tracker,
    });
    expect(r.budget_exhausted).toBe(true);
  }, 30000);

  test('per-page lock busy → pages_skipped_lock, no write', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/x', RICH_CONTEXT);

    // Pre-acquire the per-page lock so the enricher's withRefreshingLock fails.
    const handle = await tryAcquireDbLock(engine, 'enrich:default:people/alice-example', 5);
    expect(handle).toBeTruthy();
    try {
      const r = await runEnrichCore(engine, {
        sourceId: 'default',
        types: ['person'],
        model: 'test:model',
        synthesizeFn: goodSynth,
      });
      expect(r.pages_skipped_lock).toBe(1);
      expect(r.pages_enriched).toBe(0);
    } finally {
      await handle!.release();
    }
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('empty candidate set → no-op result', async () => {
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: goodSynth,
    });
    expect(r.candidates_considered).toBe(0);
    expect(r.pages_enriched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #3629 — checkpoint persistence: SKIP pages must not re-bill every run.
// ---------------------------------------------------------------------------

describe('checkpoint persistence (#3629)', () => {
  test('SKIP page is billed once: repeat runs make zero further synth calls', async () => {
    await seedStub('people/skip-example', 'Skip Example', 'person');
    await seedLinkInto('people/skip-example', 'meetings/skip-m', RICH_CONTEXT);

    let synthCalls = 0;
    const skipSynth: SynthesizeFn = async () => { synthCalls++; return 'SKIP'; };
    const opts = {
      sourceId: 'default',
      types: ['person' as const],
      model: 'test:model',
      synthesizeFn: skipSynth,
    };

    const r1 = await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(1);
    expect(r1.pages_model_skip).toBe(1);
    // The page stays thin (SKIP writes nothing) — it re-enters the candidate
    // list, and pre-fix the clean-run checkpoint clear re-billed it forever.
    const r2 = await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(1); // no re-bill on tick 2
    const r3 = await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(1); // no re-bill on tick 3
    expect(r2.pages_enriched).toBe(0);
    expect(r3.pages_enriched).toBe(0);
    // Checkpoint row persists across clean runs (decays via the 7d purge TTL).
    const fp = enrichFingerprint({
      sourceId: 'default', types: ['person'], order: 'inbound-links',
      thinThreshold: 400, model: 'test:model',
    });
    const done = await loadOpCheckpoint(engine, { op: CHECKPOINT_OP, fingerprint: fp });
    expect(done).toContain('default|people/skip-example');
  }, 60000);

  test('wedge: limit=1 with the top candidate checkpointed reaches the 2nd candidate on tick 2', async () => {
    // alice outranks bob on inbound links (2 vs 1).
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedStub('people/bob-example', 'Bob Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/w1', RICH_CONTEXT);
    await seedLinkInto('people/alice-example', 'meetings/w2', RICH_CONTEXT);
    await seedLinkInto('people/bob-example', 'meetings/w3', RICH_CONTEXT);

    // Tick 1: alice (rank 1) consumes the single slot and SKIPs → checkpointed.
    const r1 = await runEnrichCore(engine, {
      sourceId: 'default', types: ['person'], limit: 1, model: 'test:model',
      synthesizeFn: async () => 'SKIP',
    });
    expect(r1.pages_model_skip).toBe(1);

    // Tick 2 (same limit): pre-fix the fetch window held only checkpointed
    // alice → pending=[] forever and bob never got a turn. Post-fix the
    // over-fetch reaches bob.
    const r2 = await runEnrichCore(engine, {
      sourceId: 'default', types: ['person'], limit: 1, model: 'test:model',
      synthesizeFn: goodSynth,
    });
    expect(r2.pages_enriched).toBe(1);
    const bob = await engine.getPage('people/bob-example', { sourceId: 'default' });
    expect(bob!.compiled_truth).toContain('## Overview');
    const alice = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(alice!.compiled_truth.trim()).toBe(STUB); // untouched (checkpointed)
  }, 60000);

  test('--force clears the checkpoint and retries a SKIP page', async () => {
    await seedStub('people/force-example', 'Force Example', 'person');
    await seedLinkInto('people/force-example', 'meetings/force-m', RICH_CONTEXT);

    let synthCalls = 0;
    const skipSynth: SynthesizeFn = async () => { synthCalls++; return 'SKIP'; };
    const base = {
      sourceId: 'default',
      types: ['person' as const],
      model: 'test:model',
      synthesizeFn: skipSynth,
    };
    await runEnrichCore(engine, base);
    expect(synthCalls).toBe(1);
    await runEnrichCore(engine, base);
    expect(synthCalls).toBe(1); // checkpoint holds
    await runEnrichCore(engine, { ...base, force: true });
    expect(synthCalls).toBe(2); // --force re-bills deliberately
  }, 60000);
});

describe('checkpoint residuals (#3629 follow-up)', () => {
  test('blank model output stays retryable: NOT banked in the checkpoint', async () => {
    await seedStub('people/blank-example', 'Blank Example', 'person');
    await seedLinkInto('people/blank-example', 'meetings/blank-m', RICH_CONTEXT);

    let synthCalls = 0;
    const blankSynth: SynthesizeFn = async () => { synthCalls++; return ''; };
    const opts = {
      sourceId: 'default',
      types: ['person' as const],
      model: 'test:model',
      synthesizeFn: blankSynth,
    };

    const r1 = await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(1);
    expect(r1.pages_empty_output).toBe(1);

    // A blank response is a synthesis-failure shape (#2085), not a grounding
    // verdict — the next run must re-attempt it instead of suppressing the
    // page for the checkpoint TTL.
    const r2 = await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(2);
    expect(r2.pages_empty_output).toBe(1);
  }, 60000);

  test('relaxing --min-context re-evaluates a page banked under the stricter gate', async () => {
    await seedStub('people/thin-ctx', 'Thin Ctx', 'person');
    await seedLinkInto('people/thin-ctx', 'meetings/thin-m', RICH_CONTEXT);

    let synthCalls = 0;
    const synth: SynthesizeFn = async () => { synthCalls++; return 'SKIP'; };
    const base = {
      sourceId: 'default',
      types: ['person' as const],
      model: 'test:model',
      synthesizeFn: synth,
    };

    // Strict gate: pre-LLM rejection banks the page under THIS fingerprint.
    const strict = await runEnrichCore(engine, { ...base, minContextChars: 100000 });
    expect(synthCalls).toBe(0);
    expect(strict.pages_skipped_pre_llm ?? 0).toBe(1);

    // Relaxed gate is a different run: the banked pre-LLM skip must not
    // suppress the page under the new knob value.
    await runEnrichCore(engine, { ...base, minContextChars: 10 });
    expect(synthCalls).toBe(1);
  }, 60000);

  test('--dry-run --force does not destroy the real checkpoint', async () => {
    await seedStub('people/dryforce', 'Dry Force', 'person');
    await seedLinkInto('people/dryforce', 'meetings/df-m', RICH_CONTEXT);

    let synthCalls = 0;
    const skipSynth: SynthesizeFn = async () => { synthCalls++; return 'SKIP'; };
    const opts = {
      sourceId: 'default',
      types: ['person' as const],
      model: 'test:model',
      synthesizeFn: skipSynth,
    };

    await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(1);

    // A dry-run preview with --force must stay read-only.
    await runEnrichCore(engine, { ...opts, dryRun: true, force: true });

    const r3 = await runEnrichCore(engine, opts);
    expect(synthCalls).toBe(1); // still banked — the dry-run didn't clear it
    expect(r3.pages_enriched).toBe(0);
  }, 60000);
});
