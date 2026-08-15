/**
 * gbrain quarantine CLI (issue #1699) — list / clear / scan.
 * PGLite + captured console; no API keys.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../src/core/import-file.ts';
import { runQuarantine } from '../src/commands/quarantine.ts';
import { isQuarantined, getContentFlag } from '../src/core/quarantine.ts';

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
  const home = mkdtempSync(join(tmpdir(), 'q-cli-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'q-cli-audit-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

/** Run a command capturing stdout. */
async function capture(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

describe('gbrain quarantine list', () => {
  test('lists quarantined by default; --include-flagged adds content_flag pages', async () => {
    await withHome(async () => {
      await importFromContent(engine, 'notes/junk', `---\ntitle: B\ntype: note\n---\n\nCloudflare Ray ID: x. body.`, { noEmbed: true });
      const navRow = '| [a](http://a) | [b](http://b) | [c](http://c) | [d](http://d) |\n';
      await importFromContent(engine, 'notes/nav', `---\ntitle: N\ntype: note\n---\n\n${navRow.repeat(1200)}`, { noEmbed: true });

      const out1 = await capture(() => runQuarantine(engine, ['list', '--json']));
      const j1 = JSON.parse(out1);
      expect(j1.rows.map((r: { slug: string }) => r.slug)).toEqual(['notes/junk']);

      const out2 = await capture(() => runQuarantine(engine, ['list', '--include-flagged', '--json']));
      const j2 = JSON.parse(out2);
      const slugs = j2.rows.map((r: { slug: string }) => r.slug).sort();
      expect(slugs).toEqual(['notes/junk', 'notes/nav']);
      const navRowOut = j2.rows.find((r: { slug: string }) => r.slug === 'notes/nav');
      expect(navRowOut.marker).toBe('content_flag');
    });
  });
});

describe('gbrain quarantine clear', () => {
  test('clear (no --force) on still-junk content re-quarantines (--json, no exit)', async () => {
    await withHome(async () => {
      await importFromContent(engine, 'notes/jstill', `---\ntitle: B\ntype: note\n---\n\nCloudflare Ray ID: w. still junk.`, { noEmbed: true });
      // --json path returns instead of process.exit, so it's test-safe.
      const out = await capture(() => runQuarantine(engine, ['clear', 'notes/jstill', '--json']));
      const j = JSON.parse(out);
      expect(j.re_quarantined).toBe(true);
      expect(j.cleared).toBe(false);
      const page = await engine.getPage('notes/jstill');
      expect(isQuarantined(page!.frontmatter as Record<string, unknown>)).toBe(true);
    });
  });

  test('clear on an unmarked page is a no-op', async () => {
    await withHome(async () => {
      await importFromContent(engine, 'notes/cleanp', `---\ntitle: C\ntype: note\n---\n\nplain clean prose.`, { noEmbed: true });
      const out = await capture(() => runQuarantine(engine, ['clear', 'notes/cleanp']));
      expect(out).toContain('no quarantine or content_flag marker');
    });
  });

  test('clear --force re-imports clean content and un-quarantines', async () => {
    await withHome(async () => {
      // Seed a quarantined page, then "fix" the source on disk-equivalent by
      // re-importing clean content via the CLI with --force.
      await importFromContent(engine, 'notes/j', `---\ntitle: B\ntype: note\n---\n\nCloudflare Ray ID: y. body.`, { noEmbed: true });
      let page = await engine.getPage('notes/j');
      expect(isQuarantined(page!.frontmatter as Record<string, unknown>)).toBe(true);

      // --force bypasses the gate so the existing (still-junky) stored body
      // clears. (In production the operator edits the source first; --force is
      // the escape hatch.)
      await capture(() => runQuarantine(engine, ['clear', 'notes/j', '--force', '--no-embed']));
      page = await engine.getPage('notes/j');
      expect(isQuarantined(page!.frontmatter as Record<string, unknown>)).toBe(false);
    });
  });
});

describe('engine.getContentFlagsByPageIds', () => {
  test('returns markers for flagged pages, skips clean, empty-input short-circuits', async () => {
    await withHome(async () => {
      const navRow = '| [a](http://a) | [b](http://b) | [c](http://c) | [d](http://d) |\n';
      await importFromContent(engine, 'notes/flagged', `---\ntitle: N\ntype: note\n---\n\n${navRow.repeat(1200)}`, { noEmbed: true });
      await importFromContent(engine, 'notes/clean', `---\ntitle: C\ntype: note\n---\n\nplain prose here.`, { noEmbed: true });

      // Empty input → empty map, no query.
      expect((await engine.getContentFlagsByPageIds([])).size).toBe(0);

      const flagged = await engine.getPage('notes/flagged');
      const clean = await engine.getPage('notes/clean');
      const map = await engine.getContentFlagsByPageIds([flagged!.id, clean!.id]);
      expect(map.get(flagged!.id)?.reason).toBe('markup_heavy');
      expect(map.has(clean!.id)).toBe(false);
    });
  });
});

describe('gbrain quarantine scan', () => {
  test('dry-run reports would-quarantine for pre-gate junk; --apply marks it', async () => {
    await withHome(async () => {
      // Seed junk that predates the gate by writing directly via putPage
      // (bypasses importFromContent's gate).
      await engine.putPage('notes/pre', {
        type: 'note',
        title: 'Pre-gate',
        compiled_truth: 'Cloudflare Ray ID: zzz. This junk predates the gate.',
        timeline: '',
      });

      const dry = await capture(() => runQuarantine(engine, ['scan', '--json']));
      const jd = JSON.parse(dry);
      expect(jd.applied).toBe(false);
      expect(jd.quarantined).toBe(1);
      // Dry-run must NOT mutate.
      let page = await engine.getPage('notes/pre');
      expect(isQuarantined(page!.frontmatter as Record<string, unknown>)).toBe(false);

      const applied = await capture(() => runQuarantine(engine, ['scan', '--apply', '--no-embed', '--json']));
      const ja = JSON.parse(applied);
      expect(ja.applied).toBe(true);
      expect(ja.quarantined).toBe(1);
      page = await engine.getPage('notes/pre');
      expect(isQuarantined(page!.frontmatter as Record<string, unknown>)).toBe(true);
    });
  });

  test('--limit caps the number scanned', async () => {
    await withHome(async () => {
      for (const n of [1, 2, 3]) {
        await engine.putPage(`notes/pre${n}`, {
          type: 'note',
          title: `Pre ${n}`,
          compiled_truth: `Cloudflare Ray ID: z${n}. predates the gate.`,
          timeline: '',
        });
      }
      const out = await capture(() => runQuarantine(engine, ['scan', '--limit', '2', '--json']));
      const j = JSON.parse(out);
      expect(j.scanned).toBe(2);
    });
  });
});
