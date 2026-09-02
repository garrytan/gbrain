/**
 * #4222 — generic-token entity junk guards.
 *
 * Three seams share one reject list (src/core/entity-name-quality.ts):
 *   1. enrichEntity refuses to MINT a page for a single generic token or a
 *      bare @handle (existing pages stay trusted — update path unaffected).
 *   2. buildGazetteer drops single-generic-token PERSON titles so an
 *      already-minted junk page stops accreting mention edges.
 *   3. The junk_entity_hubs doctor check surfaces near-empty pages with
 *      huge edge counts (warn + list, never auto-delete).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  GENERIC_ENTITY_TOKENS,
  isGenericEntityToken,
  isJunkEntityName,
} from '../src/core/entity-name-quality.ts';
import { enrichEntity } from '../src/core/enrichment-service.ts';
import { buildGazetteer } from '../src/core/by-mention.ts';
import {
  checkJunkEntityHubs,
  JUNK_HUB_EDGE_THRESHOLD,
  JUNK_HUB_MAX_CHUNKS,
} from '../src/commands/doctor/checks/graph-embedding.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as unknown as { db: { exec(q: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
}

// ── 1. Shared reject list ───────────────────────────────────────────────

describe('entity-name-quality (#4222)', () => {
  test('the observed junk-hub tokens are all on the list', () => {
    for (const t of ['will', 'something', 'info', 'chief', 'unknown', 'readme', 'founders']) {
      expect(GENERIC_ENTITY_TOKENS.has(t)).toBe(true);
      expect(isGenericEntityToken(t)).toBe(true);
    }
  });

  test('matching is case-insensitive', () => {
    expect(isGenericEntityToken('Will')).toBe(true);
    expect(isGenericEntityToken('CHIEF')).toBe(true);
  });

  test('isJunkEntityName: single generic token or bare @handle', () => {
    expect(isJunkEntityName('Will')).toBe(true);
    expect(isJunkEntityName('info')).toBe(true);
    expect(isJunkEntityName('@alice_dev')).toBe(true);
    expect(isJunkEntityName('@AcmeCorp')).toBe(true);
    expect(isJunkEntityName('  ')).toBe(true);
  });

  test('isJunkEntityName: multi-word names and real names always pass', () => {
    expect(isJunkEntityName('Will Smith')).toBe(false);
    expect(isJunkEntityName('Alice Chen')).toBe(false);
    expect(isJunkEntityName('Acme')).toBe(false); // single but NOT generic
    expect(isJunkEntityName('Info Systems Inc')).toBe(false);
  });
});

// ── 2. enrichEntity mint gate ───────────────────────────────────────────

describe('enrichEntity mint gate (#4222)', () => {
  beforeEach(truncateAll);

  test('single generic token is skipped — no page minted', async () => {
    const result = await enrichEntity(engine, {
      entityName: 'Will',
      entityType: 'person',
      context: 'Will follow up next week',
      sourceSlug: 'meetings/standup',
    }, { trusted: true });

    expect(result.action).toBe('skipped');
    expect(await engine.getPage('people/will')).toBeNull();
  });

  test('bare @handle is skipped — no page minted', async () => {
    const result = await enrichEntity(engine, {
      entityName: '@alice_dev',
      entityType: 'person',
      context: 'mentioned by @alice_dev',
      sourceSlug: 'meetings/standup',
    }, { trusted: true });

    expect(result.action).toBe('skipped');
    expect(await engine.getPage('people/alice-dev')).toBeNull();
  });

  test('an EXISTING page with a generic title stays trusted (update path)', async () => {
    await engine.putPage('people/will', {
      type: 'person', title: 'Will', compiled_truth: 'A real person the user created.', timeline: '',
    });

    const result = await enrichEntity(engine, {
      entityName: 'Will',
      entityType: 'person',
      context: 'update for existing page',
      sourceSlug: 'meetings/standup',
    }, { trusted: true });

    expect(result.action).toBe('updated');
  });

  test('multi-word names still mint', async () => {
    const result = await enrichEntity(engine, {
      entityName: 'Will Smith',
      entityType: 'person',
      context: 'met Will Smith',
      sourceSlug: 'meetings/standup',
    }, { trusted: true });

    expect(result.action).toBe('created');
    expect(await engine.getPage('people/will-smith')).not.toBeNull();
  });
});

// ── 3. buildGazetteer drop ──────────────────────────────────────────────

describe('buildGazetteer generic person-title drop (#4222)', () => {
  beforeEach(truncateAll);

  test('single-generic-token person title is dropped; multi-token and non-person kept', async () => {
    await engine.putPage('people/will', {
      type: 'person', title: 'Will', compiled_truth: 'junk hub magnet', timeline: '',
    });
    await engine.putPage('people/will-smith', {
      type: 'person', title: 'Will Smith', compiled_truth: 'a real person', timeline: '',
    });
    // Non-person types are NOT dropped (scope pin: the gate is person-only).
    await engine.putPage('companies/info', {
      type: 'company', title: 'Info', compiled_truth: 'a company', timeline: '',
    });

    const gazetteer = await buildGazetteer(engine);

    const willBucket = gazetteer.get('will') ?? [];
    expect(willBucket.some(e => e.slug === 'people/will')).toBe(false);
    expect(willBucket.some(e => e.slug === 'people/will-smith')).toBe(true);
    const infoBucket = gazetteer.get('info') ?? [];
    expect(infoBucket.some(e => e.slug === 'companies/info')).toBe(true);
  });
});

// ── 4. junk_entity_hubs doctor check ────────────────────────────────────

describe('junk_entity_hubs doctor check (#4222)', () => {
  beforeEach(truncateAll);

  test('shipped thresholds are the documented ones', () => {
    expect(JUNK_HUB_EDGE_THRESHOLD).toBe(1000);
    expect(JUNK_HUB_MAX_CHUNKS).toBe(2);
  });

  test('warns and lists near-empty pages with edge counts over threshold', async () => {
    await engine.putPage('people/will', {
      type: 'person', title: 'Will', compiled_truth: 'stub', timeline: '',
    });
    const batch: LinkBatchInput[] = [];
    for (let i = 0; i < 4; i++) {
      const slug = `notes/n-${i}`;
      await engine.putPage(slug, { type: 'note', title: `Note ${i}`, compiled_truth: 'body', timeline: '' });
      batch.push({ from_slug: slug, to_slug: 'people/will', link_source: 'mentions' });
    }
    await engine.addLinksBatch(batch);

    // Threshold overridden for test-scale corpus; production uses defaults.
    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 3, maxChunks: 2 });

    expect(check.name).toBe('junk_entity_hubs');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('people/will');
    const hubs = (check.details as { hubs: Array<{ slug: string; edges: number }> }).hubs;
    expect(hubs.some(h => h.slug === 'people/will' && h.edges >= 4)).toBe(true);
    // The note pages have few edges — not listed.
    expect(hubs.some(h => h.slug.startsWith('notes/'))).toBe(false);
  });

  test('content-rich pages are exempt even with many edges', async () => {
    await engine.putPage('people/notable', {
      type: 'person', title: 'Notable Person', compiled_truth: 'real content', timeline: '',
    });
    await engine.upsertChunks('people/notable', [0, 1, 2].map(i => ({
      chunk_index: i, chunk_text: `chunk ${i}`, chunk_source: 'compiled_truth' as const, token_count: 2,
    })));
    const batch: LinkBatchInput[] = [];
    for (let i = 0; i < 4; i++) {
      const slug = `notes/m-${i}`;
      await engine.putPage(slug, { type: 'note', title: `M ${i}`, compiled_truth: 'body', timeline: '' });
      batch.push({ from_slug: slug, to_slug: 'people/notable', link_source: 'mentions' });
    }
    await engine.addLinksBatch(batch);

    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 3, maxChunks: 2 });
    expect(check.status).toBe('ok');
  });

  test('ok on an empty brain', async () => {
    const check = await checkJunkEntityHubs(engine);
    expect(check.status).toBe('ok');
  });

  test('junk_hub_exempt: true opts an intentional thin hub page out', async () => {
    await engine.putPage('topic/misc', {
      type: 'concept',
      title: 'misc — topic hub (auto-created for graph wiring). Groups its member pages.',
      compiled_truth: 'stub',
      timeline: '',
      frontmatter: { junk_hub_exempt: true, junk_hub_exempt_reason: 'intentional topic-organization scaffolding' },
    });
    const batch: LinkBatchInput[] = [];
    for (let i = 0; i < 4; i++) {
      const slug = `notes/e-${i}`;
      await engine.putPage(slug, { type: 'note', title: `Note ${i}`, compiled_truth: 'body', timeline: '' });
      batch.push({ from_slug: slug, to_slug: 'topic/misc', link_source: 'mentions' });
    }
    await engine.addLinksBatch(batch);

    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 3, maxChunks: 2 });

    // Same shape as the junk-hub case above (few chunks, edges over threshold) —
    // opted out, so it must not appear at all, and with nothing else in the
    // corpus the check reports ok.
    expect(check.status).toBe('ok');
    if (check.details) {
      const hubs = (check.details as { hubs: Array<{ slug: string }> }).hubs;
      expect(hubs.some(h => h.slug === 'topic/misc')).toBe(false);
    }
  });

  test('a page with the same shape but no exempt marker is still caught (regression control)', async () => {
    await engine.putPage('topic/unmarked', {
      type: 'concept', title: 'unmarked hub', compiled_truth: 'stub', timeline: '',
    });
    const batch: LinkBatchInput[] = [];
    for (let i = 0; i < 4; i++) {
      const slug = `notes/u-${i}`;
      await engine.putPage(slug, { type: 'note', title: `Note ${i}`, compiled_truth: 'body', timeline: '' });
      batch.push({ from_slug: slug, to_slug: 'topic/unmarked', link_source: 'mentions' });
    }
    await engine.addLinksBatch(batch);

    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 3, maxChunks: 2 });

    expect(check.status).toBe('warn');
    const hubs = (check.details as { hubs: Array<{ slug: string }> }).hubs;
    expect(hubs.some(h => h.slug === 'topic/unmarked')).toBe(true);
  });

  test.each([
    ['boolean false', false],
    ['string "false"', 'false'],
    ['unrelated string', 'nope'],
  ])('junk_hub_exempt: %s does NOT opt the page out', async (_label, value) => {
    const slug = `topic/not-exempt-${String(value).replace(/[^a-z0-9]/gi, '')}`;
    await engine.putPage(slug, {
      type: 'concept', title: 'not actually exempt', compiled_truth: 'stub', timeline: '',
      frontmatter: { junk_hub_exempt: value },
    });
    const batch: LinkBatchInput[] = [];
    for (let i = 0; i < 4; i++) {
      const noteSlug = `notes/${slug.replace('topic/', '')}-${i}`;
      await engine.putPage(noteSlug, { type: 'note', title: `Note ${i}`, compiled_truth: 'body', timeline: '' });
      batch.push({ from_slug: noteSlug, to_slug: slug, link_source: 'mentions' });
    }
    await engine.addLinksBatch(batch);

    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 3, maxChunks: 2 });

    expect(check.status).toBe('warn');
    const hubs = (check.details as { hubs: Array<{ slug: string }> }).hubs;
    expect(hubs.some(h => h.slug === slug)).toBe(true);
  });

  test('junk_hub_exempt: "true" (string, not boolean) DOES opt the page out', async () => {
    await engine.putPage('topic/string-true-marked', {
      type: 'concept', title: 'string-true marked hub', compiled_truth: 'stub', timeline: '',
      frontmatter: { junk_hub_exempt: 'true' },
    });
    const batch: LinkBatchInput[] = [];
    for (let i = 0; i < 4; i++) {
      const noteSlug = `notes/st-${i}`;
      await engine.putPage(noteSlug, { type: 'note', title: `Note ${i}`, compiled_truth: 'body', timeline: '' });
      batch.push({ from_slug: noteSlug, to_slug: 'topic/string-true-marked', link_source: 'mentions' });
    }
    await engine.addLinksBatch(batch);

    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 3, maxChunks: 2 });

    expect(check.status).toBe('ok');
    if (check.details) {
      const hubs = (check.details as { hubs: Array<{ slug: string }> }).hubs;
      expect(hubs.some(h => h.slug === 'topic/string-true-marked')).toBe(false);
    }
  });
});
