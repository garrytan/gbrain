/**
 * Quarantine search-exclusion E2E (issue #1699, PGLite, no API keys).
 *
 * Pins the Q1=A confidence-split contract end-to-end:
 *   - quarantined (junk) page is ABSENT from search but present in get_page.
 *   - flagged (markup-heavy) page is PRESENT in search WITH content_flag set
 *     (the agent-warning channel) — flag does not hide.
 *   - clearing a quarantine (force re-import) re-surfaces the page.
 *
 * No embedding provider in tests → hybridSearch takes the keyword path,
 * which also runs stampContentFlags, so the content_flag contract holds there.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../../src/core/import-file.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { isQuarantined } from '../../src/core/quarantine.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';

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

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'q-search-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'q-search-audit-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

const KW = 'zubernaut'; // distinctive keyword present in every seeded page

describe('quarantine search exclusion (Q1=A)', () => {
  test('quarantined absent from search, flagged present with content_flag, clean present', async () => {
    await withHome(async () => {
      // Clean page — plain prose with the keyword.
      await importFromContent(
        engine,
        'notes/clean',
        `---\ntitle: Clean\ntype: note\n---\n\nA normal note about ${KW} and its properties, written in real sentences.`,
        { noEmbed: true },
      );

      // Quarantined page — Cloudflare junk containing the keyword.
      const qres = await importFromContent(
        engine,
        'notes/junk',
        `---\ntitle: Blocked\ntype: note\n---\n\nCloudflare Ray ID: deadbeef. ${KW} appears here too but this is junk.`,
        { noEmbed: true },
      );
      expect(qres.quarantined).toBe(true);

      // Flagged page — markup-heavy nav blob in the warn window, with the keyword.
      const navRow = `| [${KW}](http://a) | [b](http://b) | [c](http://c) | [d](http://d) |\n`;
      const fres = await importFromContent(
        engine,
        'notes/nav',
        `---\ntitle: Nav\ntype: note\n---\n\n${navRow.repeat(1200)}`,
        { noEmbed: true },
      );
      expect(fres.flagged).toBe(true);
      expect(fres.flag_reason).toBe('markup_heavy');

      const results = await hybridSearch(engine, KW, { limit: 20 });
      const slugs = results.map((r) => r.slug);

      // Quarantined page is hidden (zero chunks + visibility clause).
      expect(slugs).not.toContain('notes/junk');
      // Clean + flagged pages are present.
      expect(slugs).toContain('notes/clean');
      expect(slugs).toContain('notes/nav');

      // Agent-warning channel: the flagged result carries content_flag.
      const navResult = results.find((r) => r.slug === 'notes/nav');
      expect(navResult?.content_flag?.reason).toBe('markup_heavy');
      // The clean result does NOT.
      const cleanResult = results.find((r) => r.slug === 'notes/clean');
      expect(cleanResult?.content_flag).toBeUndefined();

      // get_page still returns the quarantined page (reviewable).
      const junkPage = await engine.getPage('notes/junk');
      expect(junkPage).not.toBeNull();
      expect(isQuarantined(junkPage!.frontmatter as Record<string, unknown>)).toBe(true);
    });
  });

  test('get_page op surfaces content_flag for a flagged page (agent-warning channel)', async () => {
    await withHome(async () => {
      const navRow = `| [${KW}](http://a) | [b](http://b) | [c](http://c) | [d](http://d) |\n`;
      await importFromContent(engine, 'notes/navflag', `---\ntitle: Nav\ntype: note\n---\n\n${navRow.repeat(1200)}`, { noEmbed: true });
      await importFromContent(engine, 'notes/cleanflag', `---\ntitle: C\ntype: note\n---\n\nplain prose with ${KW}.`, { noEmbed: true });

      const getPageOp = operations.find((o) => o.name === 'get_page')!;
      const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false } as unknown as OperationContext;

      const flagged = (await getPageOp.handler(ctx, { slug: 'notes/navflag' })) as { content_flag?: { reason: string } };
      expect(flagged.content_flag?.reason).toBe('markup_heavy');

      const clean = (await getPageOp.handler(ctx, { slug: 'notes/cleanflag' })) as { content_flag?: unknown };
      expect(clean.content_flag).toBeUndefined();
    });
  });

  test('clearing a quarantine (force re-import) re-surfaces the page in search', async () => {
    await withHome(async () => {
      const q = await importFromContent(
        engine,
        'notes/junk2',
        `---\ntitle: Blocked\ntype: note\n---\n\nCloudflare Ray ID: cafe. ${KW} keyword present.`,
        { noEmbed: true },
      );
      expect(q.quarantined).toBe(true);
      let slugs = (await hybridSearch(engine, KW, { limit: 20 })).map((r) => r.slug);
      expect(slugs).not.toContain('notes/junk2');

      // Operator force-clears: re-import the SAME slug with clean content
      // (simulating an edit) so the page becomes searchable again.
      const cleared = await importFromContent(
        engine,
        'notes/junk2',
        `---\ntitle: Fixed\ntype: note\n---\n\nThis page is now legitimate prose about ${KW} with real content.`,
        { noEmbed: true, forceRechunk: true },
      );
      expect(cleared.quarantined).toBeUndefined();
      const page = await engine.getPage('notes/junk2');
      expect(isQuarantined(page!.frontmatter as Record<string, unknown>)).toBe(false);

      slugs = (await hybridSearch(engine, KW, { limit: 20 })).map((r) => r.slug);
      expect(slugs).toContain('notes/junk2');
    });
  });
});
