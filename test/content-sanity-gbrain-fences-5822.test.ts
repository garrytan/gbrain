/**
 * #5822: foresights's own facts/takes fences do not count as markup.
 *
 * Protects: a page whose body is mostly the facts (or takes) fence foresights
 * wrote is not flagged `markup_heavy` on import, while the same table shape
 * written as ordinary page markup still is.
 * Fails when: the prose pass measures fence rows as table markup, so the
 * fence share becomes the page's markup ratio.
 * Seams: none; in-memory PGLite for the import path, isolated GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessContentSanity, assessProse } from '../src/core/content-sanity.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, renderTakesFence } from '../src/core/takes-fence.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { getContentFlag } from '../src/core/quarantine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const PROSE = '# Example Co\n\n' + 'Example Co makes kitchen tools and sells them online and through two retail partners. '.repeat(30);
const facts = renderFactsTable(Array.from({ length: 300 }, (_, i) => ({
  rowNum: i + 1, claim: `Example Co reported quarterly figure ${i + 1} in a public update about its product line`,
  kind: 'fact' as const, confidence: 0.9, visibility: 'world' as const, notability: 'medium' as const,
  source: `email/example-thread-${i + 1}`, context: 'status update about operations', active: true,
})));
const takes = renderTakesFence(Array.from({ length: 500 }, (_, i) => ({
  rowNum: i + 1, claim: `Example Co will expand retail partner ${i + 1} within the year`, kind: 'bet',
  holder: 'world', weight: 0.6, source: `notes/example-${i + 1}`, active: true,
})));
const FACTS_BODY = `${PROSE}\n\n## Facts\n\n${facts}\n`;
const TAKES_BODY = `${PROSE}\n\n## Takes\n\n${takes}\n`;

describe('prose pass', () => {
  test('the fences this test builds carry the shared marker pairs', () => {
    expect(facts).toContain(FACTS_FENCE_BEGIN);
    expect(facts).toContain(FACTS_FENCE_END);
    expect(takes).toContain(TAKES_FENCE_BEGIN);
    expect(takes).toContain(TAKES_FENCE_END);
  });

  test('a facts-fence-heavy page is not markup_heavy', () => {
    expect(Buffer.byteLength(FACTS_BODY)).toBeGreaterThan(50_000);
    expect(assessProse(FACTS_BODY).markup_ratio).toBeLessThan(0.1);
    expect(assessContentSanity({ compiled_truth: FACTS_BODY, timeline: '', title: 'Example Co' }).flag_reason).toBeNull();
  });

  test('a takes-fence-heavy page is not markup_heavy', () => {
    expect(Buffer.byteLength(TAKES_BODY)).toBeGreaterThan(50_000);
    expect(assessContentSanity({ compiled_truth: TAKES_BODY, timeline: '', title: 'Example Co' }).flag_reason).toBeNull();
  });

  test('the same table outside a foresights fence is still markup_heavy, and bytes still count the fence', () => {
    const unfenced = FACTS_BODY.replace(FACTS_FENCE_BEGIN, '').replace(FACTS_FENCE_END, '');
    expect(assessContentSanity({ compiled_truth: unfenced, timeline: '', title: 'Example Co' }).flag_reason).toBe('markup_heavy');
    expect(assessContentSanity({ compiled_truth: FACTS_BODY, timeline: '', title: 'Example Co' }).bytes).toBe(Buffer.byteLength(FACTS_BODY));
  });
});

describe('import', () => {
  let engine: PGLiteEngine;
  let home: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'cs-5822-home-'));
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('importing a facts-fence-heavy company page sets no content_flag', async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home }, async () => {
      const result = await importFromContent(engine, 'companies/example-co', `---\ntype: company\ntitle: Example Co\n---\n${FACTS_BODY}`, { noEmbed: true });
      expect(result.status).toBe('imported');
      expect(result.flagged).toBeUndefined();
      const page = await engine.getPage('companies/example-co');
      expect(getContentFlag(page!.frontmatter as Record<string, unknown>)).toBeNull();
    });
  });
});
