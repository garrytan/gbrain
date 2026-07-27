/**
 * issue #1678 — extract_atoms backlog count + doctor check.
 *
 * Pins:
 *  - countExtractAtomsBacklog counts eligible-but-unextracted pages (scoped +
 *    brain-wide) and excludes pages that already have an atom (NOT EXISTS).
 *  - computeExtractAtomsBacklogCheck WARNs with a `--drain` hint when the pack
 *    doesn't run the phase and the backlog is real; OK at 0.
 *
 * Real in-memory PGLite (canonical block, R3+R4). GBRAIN_HOME is pointed at an
 * empty tmpdir for the doctor-check cases so packDeclaresPhase resolves the
 * bundled base pack (which does NOT declare extract_atoms) deterministically,
 * independent of the developer's real ~/.gbrain config.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import { computeExtractAtomsBacklogCheck } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'gbrain-xa-backlog-home-'));

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

const BODY = 'x'.repeat(600); // >= MIN_PAGE_CHARS_FOR_EXTRACTION (500)

async function seedArticle(slug: string) {
  return engine.putPage(slug, { type: 'article', title: slug, compiled_truth: BODY });
}

describe('countExtractAtomsBacklog (issue #1678)', () => {
  it('counts eligible pages with no atom (scoped + brain-wide)', async () => {
    await seedArticle('article-a');
    await seedArticle('article-b');
    await seedArticle('article-c');
    expect(await countExtractAtomsBacklog(engine)).toBe(3);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);
  });

  it('excludes a page that already has a matching atom (NOT EXISTS)', async () => {
    const p = await seedArticle('article-x');
    const h16 = (p.content_hash ?? '').slice(0, 16);
    expect(h16.length).toBe(16);
    await engine.putPage('atoms/a1', {
      type: 'atom',
      title: 'a1',
      compiled_truth: 'an extracted nugget',
      frontmatter: { source_hash: h16 },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  it('ignores short pages and dream-generated pages', async () => {
    await engine.putPage('article-short', { type: 'article', title: 's', compiled_truth: 'too short' });
    await engine.putPage('article-dream', {
      type: 'article', title: 'd', compiled_truth: BODY,
      frontmatter: { dream_generated: 'true' },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  it('ignores raw source-holder pages (permanent no-progress backlog otherwise)', async () => {
    await engine.putPage('wiki/raw-email-source', {
      type: 'source',
      title: 'Raw email source',
      compiled_truth: BODY,
      frontmatter: { raw: 'raw/email/example.md' },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
  });
});

describe('computeExtractAtomsBacklogCheck (issue #1678)', () => {
  it('OK with no backlog', async () => {
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect((check.details as { backlog: number }).backlog).toBe(0);
  });

  it('WARNs with a --drain hint when the pack does not run the phase and backlog > 10', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`article-${i}`);
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('--drain');
    expect((check.details as { pack_declares_phase: boolean }).pack_declares_phase).toBe(false);
    expect((check.details as { known_approximation: string }).known_approximation).toContain('page backlog only');
  });
});
