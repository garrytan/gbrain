/**
 * feat(enrich): --slugs targeting + --evidence-scope federated grounding.
 *
 * The observed gap: --thin only selects pages with compiled_truth+timeline
 * < thinThreshold, and retrieveEvidence hard-scoped facts/backlinks/hybrid
 * search to the candidate's OWN source — so a curated person page living in
 * a small `workspace` source got zero evidence even when the same entity is
 * thoroughly covered in OTHER federated sources (mail/calendar/meetings).
 * This proves both fixes end to end through `runEnrichCore`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  runEnrichCore,
  resolveEvidenceSourceIds,
  type SynthesizeFn,
} from '../../src/commands/enrich.ts';

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

async function addSourceRow(id: string, federated: boolean | undefined) {
  const config = federated === undefined ? '{}' : JSON.stringify({ federated });
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
    [id, id, config],
  );
}

const RICH_CONTEXT =
  'Alice Example co-founded WidgetCo in 2025 and leads its product design team across two offices.';

// ---------------------------------------------------------------------------
// resolveEvidenceSourceIds — scope resolution.
// ---------------------------------------------------------------------------

describe('resolveEvidenceSourceIds', () => {
  test("'own' (or omitted) → undefined, scalar sourceId unchanged", async () => {
    await addSourceRow('mail', true);
    expect(await resolveEvidenceSourceIds(engine, 'default', 'own')).toBeUndefined();
    expect(await resolveEvidenceSourceIds(engine, 'default', undefined)).toBeUndefined();
  });

  test("'federated' → own source + every OTHER source with config.federated=true", async () => {
    await addSourceRow('mail', true);
    await addSourceRow('granola', true);
    await addSourceRow('scratch', false); // explicitly isolated — excluded
    await addSourceRow('unset-src', undefined); // unset — excluded (strict === true check)
    const ids = await resolveEvidenceSourceIds(engine, 'default', 'federated');
    expect(ids).toBeTruthy();
    expect(new Set(ids)).toEqual(new Set(['default', 'mail', 'granola']));
  });

  test("'federated' falls back to undefined (own only) when no other source is federated", async () => {
    await addSourceRow('scratch', false);
    const ids = await resolveEvidenceSourceIds(engine, 'default', 'federated');
    expect(ids).toBeUndefined();
  });

  test("'all' → every known source regardless of the federated flag", async () => {
    await addSourceRow('mail', true);
    await addSourceRow('scratch', false);
    const ids = await resolveEvidenceSourceIds(engine, 'default', 'all');
    expect(ids).toBeTruthy();
    expect(new Set(ids)).toEqual(new Set(['default', 'mail', 'scratch']));
  });
});

// ---------------------------------------------------------------------------
// --evidence-scope: federated grounding actually reaches the prompt.
// ---------------------------------------------------------------------------

describe('runEnrichCore --evidence-scope', () => {
  test("'own' (default): a curated page in a small source sees zero evidence from other sources → skipped insufficient", async () => {
    await addSourceRow('mail', true);
    await engine.putPage('people/alice-example', {
      type: 'person' as never, title: 'Alice Example', compiled_truth: 'Stub page.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    // Rich coverage lives ONLY in the federated 'mail' source.
    await engine.putPage('mail/thread-1', {
      type: 'note' as never, title: 'thread-1', compiled_truth: `Re Alice: ${RICH_CONTEXT}`, timeline: '', frontmatter: {},
    }, { sourceId: 'mail' });
    await engine.addLink('mail/thread-1', 'people/alice-example', RICH_CONTEXT, undefined, undefined, undefined, undefined, { fromSourceId: 'mail', toSourceId: 'default' });

    let called = false;
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: async () => { called = true; return 'SKIP'; },
    });
    expect(called).toBe(false); // pre-LLM grounding gate never even fires the model
    expect(r.pages_skipped_pre_llm).toBe(1);
  }, 30000);

  test("'federated': the same page now sees the mail-source evidence and gets enriched", async () => {
    await addSourceRow('mail', true);
    await engine.putPage('people/alice-example', {
      type: 'person' as never, title: 'Alice Example', compiled_truth: 'Stub page.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('mail/thread-1', {
      type: 'note' as never, title: 'thread-1', compiled_truth: `Re Alice: ${RICH_CONTEXT}`, timeline: '', frontmatter: {},
    }, { sourceId: 'mail' });
    await engine.addLink('mail/thread-1', 'people/alice-example', RICH_CONTEXT, undefined, undefined, undefined, undefined, { fromSourceId: 'mail', toSourceId: 'default' });

    let capturedUser = '';
    const synth: SynthesizeFn = async ({ user }) => {
      capturedUser = user;
      return '## Overview\nAlice founded WidgetCo. [Source: mail/thread-1]';
    };
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      evidenceScope: 'federated',
      minContextChars: 50,
      synthesizeFn: synth,
    });
    expect(r.pages_skipped_pre_llm ?? 0).toBe(0);
    expect(r.pages_enriched).toBe(1);
    expect(capturedUser).toContain('Alice Example co-founded WidgetCo'); // mail-source evidence reached the prompt

    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('## Overview');
  }, 30000);

  test('a checkpointed pre-LLM skip under own is re-evaluated when --evidence-scope widens (different fingerprint)', async () => {
    await addSourceRow('mail', true);
    await engine.putPage('people/alice-example', {
      type: 'person' as never, title: 'Alice Example', compiled_truth: 'Stub page.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('mail/thread-1', {
      type: 'note' as never, title: 'thread-1', compiled_truth: `Re Alice: ${RICH_CONTEXT}`, timeline: '', frontmatter: {},
    }, { sourceId: 'mail' });
    await engine.addLink('mail/thread-1', 'people/alice-example', RICH_CONTEXT, undefined, undefined, undefined, undefined, { fromSourceId: 'mail', toSourceId: 'default' });

    const base = { sourceId: 'default', types: ['person' as const], model: 'test:model' };
    const r1 = await runEnrichCore(engine, { ...base, synthesizeFn: async () => 'SKIP' });
    expect(r1.pages_skipped_pre_llm).toBe(1);

    let called = false;
    const r2 = await runEnrichCore(engine, {
      ...base, evidenceScope: 'federated', minContextChars: 50, synthesizeFn: async () => { called = true; return '## Overview\nfoo. [Source: mail/thread-1]'; },
    });
    expect(called).toBe(true); // NOT suppressed by the 'own'-fingerprint checkpoint
    expect(r2.pages_enriched).toBe(1);
  }, 30000);
});

// ---------------------------------------------------------------------------
// --slugs: explicit targeting bypasses the thin threshold.
// ---------------------------------------------------------------------------

describe('runEnrichCore opts.slugs', () => {
  test('a NON-thin page is invisible to the normal thin scan but reachable via slugs', async () => {
    const longBody = 'x'.repeat(900);
    await engine.putPage('people/rich-example', {
      type: 'person' as never, title: 'Rich Example', compiled_truth: longBody, timeline: '', frontmatter: {},
    }, { sourceId: 'default' });

    const normal = await engine.listEnrichCandidates({
      types: ['person'], sourceId: 'default', thinThreshold: 400, order: 'inbound-links', limit: 10,
    });
    expect(normal.map((c) => c.slug)).not.toContain('people/rich-example');

    let sawIt = false;
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      slugs: ['people/rich-example'],
      minContextChars: 0, // the long body itself is enough "context" via facts/backlinks not needed
      synthesizeFn: async () => { sawIt = true; return '## Overview\nRich Example runs things. [Source: people/rich-example]'; },
    });
    expect(sawIt).toBe(true);
    expect(r.candidates_considered).toBe(1);
    expect(r.pages_enriched).toBe(1);
  }, 30000);

  test('a slug that does not resolve to a page is counted disappeared, not a crash', async () => {
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      slugs: ['people/nobody-here'],
      synthesizeFn: async () => 'SKIP',
    });
    expect(r.candidates_considered).toBe(1);
    expect(r.pages_skipped_disappeared).toBe(1);
  }, 30000);

  test('duplicate slugs are deduped', async () => {
    await engine.putPage('people/dup-example', {
      type: 'person' as never, title: 'Dup', compiled_truth: 'Stub.', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      slugs: ['people/dup-example', 'people/dup-example'],
      synthesizeFn: async () => 'SKIP',
    });
    expect(r.candidates_considered).toBe(1);
  }, 30000);
});
