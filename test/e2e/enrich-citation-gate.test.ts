/**
 * Fail-closed citation validation, end to end through `runEnrichCore` +
 * `put_page`. Complements the pure unit tests in
 * `test/enrich/citation-validation.test.ts` (which never touch an engine) by
 * proving the gate is actually WIRED into the write path: a hallucinated
 * `[Source: ...]` never lands on disk as if it were a verified fact, and
 * `--strict-citations` refuses to write the page at all.
 *
 * Discrimination: reverting `src/commands/enrich.ts` to pre-citation-gate
 * (no `validateEnrichCitations` call) makes 'hallucinated citation is
 * quarantined, not written as fact' and 'strictCitations refuses to write a
 * page with an invalid citation' fail — the model's unresolvable citation
 * lands directly under "## Overview" instead of being moved to
 * "## Unverified (needs review)" / the page is written despite the flag.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runEnrichCore, type SynthesizeFn } from '../../src/commands/enrich.ts';
import { UNVERIFIED_HEADING } from '../../src/core/enrich/citation-validation.ts';

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

const STUB = 'Stub page.';
const RICH_CONTEXT =
  'Alice Example co-founded WidgetCo in 2025 and leads its product design team. ' +
  'She previously built the finance UI at a large company and presented the new design ' +
  'system at the 2026 summit before closing a seed round led by Fund A.';

async function seedStub(slug: string, title: string) {
  await engine.putPage(slug, { type: 'person' as never, title, compiled_truth: STUB, timeline: '', frontmatter: {} });
}

async function seedLinkInto(toSlug: string, fromSlug: string, context: string) {
  await engine.putPage(fromSlug, {
    type: 'note' as never, title: fromSlug, compiled_truth: `Notes referencing ${toSlug}.`, timeline: '', frontmatter: {},
  });
  await engine.addLink(fromSlug, toSlug, context);
}

const hallucinatingSynth: SynthesizeFn = async () =>
  '## Overview\nAlice Example founded WidgetCo and leads design. [Source: meetings/does-not-exist]\n\n' +
  '## Role\nProduct design lead.';

const cleanSynth: SynthesizeFn = async () =>
  '## Overview\nAlice Example founded WidgetCo and leads design. [Source: meetings/2026-summit]';

describe('enrich citation gate (fail-closed)', () => {
  test('hallucinated citation is quarantined, not written as fact', async () => {
    await seedStub('people/alice-example', 'Alice Example');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: hallucinatingSynth,
    });
    expect(r.pages_enriched).toBe(1); // still written — quarantine, not refusal
    expect(r.sentences_quarantined).toBe(1);
    expect(r.citations_invalid).toBe(1);

    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page).toBeTruthy();
    // The hallucinated claim must never read as a verified fact under ## Overview.
    const overviewIdx = page!.compiled_truth.indexOf('## Overview');
    const unverifiedIdx = page!.compiled_truth.indexOf(UNVERIFIED_HEADING);
    const claimIdx = page!.compiled_truth.indexOf('meetings/does-not-exist');
    expect(unverifiedIdx).toBeGreaterThan(overviewIdx);
    expect(claimIdx).toBeGreaterThan(unverifiedIdx);
    // ## Role survives untouched (unrelated content is not collateral damage).
    expect(page!.compiled_truth).toContain('## Role');
  }, 30000);

  test('a real, resolvable citation is never quarantined', async () => {
    await seedStub('people/alice-example', 'Alice Example');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: cleanSynth,
    });
    expect(r.pages_enriched).toBe(1);
    expect(r.sentences_quarantined ?? 0).toBe(0);
    expect(r.citations_ok).toBe(1);

    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('[Source: meetings/2026-summit]');
    expect(page!.compiled_truth).not.toContain(UNVERIFIED_HEADING);
  }, 30000);

  test('--strict-citations (strictCitations opt) refuses to write a page with an invalid citation', async () => {
    await seedStub('people/alice-example', 'Alice Example');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: hallucinatingSynth,
      strictCitations: true,
    });
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_citations).toBe(1);

    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB); // untouched
  }, 30000);

  test('strict-citations skip is not banked in the checkpoint (retried next run)', async () => {
    await seedStub('people/alice-example', 'Alice Example');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    let calls = 0;
    const countingHallucinatingSynth: SynthesizeFn = async () => {
      calls++;
      return hallucinatingSynth({ system: '', user: '', model: 'test:model' });
    };
    const opts = {
      sourceId: 'default',
      types: ['person' as const],
      model: 'test:model',
      synthesizeFn: countingHallucinatingSynth,
      strictCitations: true,
    };
    await runEnrichCore(engine, opts);
    expect(calls).toBe(1);
    await runEnrichCore(engine, opts);
    expect(calls).toBe(2); // NOT suppressed like a banked SKIP verdict would be
  }, 30000);
});
