/**
 * llm-preamble is anchored to the top of the page body, a read-only page
 * is skipped (not fatal) by `lint --fix` and the cycle's lint phase, and the
 * cycle's lint honors `dream.lint.exclude`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { fixContent, lintContent, runLintCore } from '../src/commands/lint.ts';
import { runPhaseLint } from '../src/core/cycle.ts';

const FM = '---\ntitle: Notes\ntype: note\ncreated: 2026-04-11\n---\n\n';
const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0;

function preambleIssues(content: string) {
  return lintContent(content, 'p.md').filter(i => i.rule === 'llm-preamble');
}

describe('llm-preamble is anchored to the start of the page body', () => {
  test('a mid-document line that starts like a preamble is not flagged', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join('\n');
    for (const line of [
      "Absolutely. Here's the clean version I'd propose.",
      'Sure! Here are the three options we discussed.',
      'Certainly. Here is what changed.',
    ]) {
      const content = `${FM}# Notes\n\n${filler}\n${line}\n${filler}\n`;
      expect(preambleIssues(content)).toHaveLength(0);
    }
  });

  test('fixContent leaves a mid-document preamble-like line byte-identical', () => {
    const content = `${FM}# Notes\n\nIntro.\n\nAbsolutely. Here's the clean version.\n\nMore.\n`;
    expect(fixContent(content)).toBe(content);
  });

  test('a preamble right after frontmatter is flagged at its line and stripped once', () => {
    const content = `${FM}Of course. Here is the page for Jane.\n\n# Jane\n\nSure! Here are her notes.\n`;
    const issues = preambleIssues(content);
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(7);
    const fixed = fixContent(content);
    expect(fixed).not.toContain('Of course');
    expect(fixed).toContain('Sure! Here are her notes.');
    expect(fixed.startsWith(FM)).toBe(true);
  });

  test('a preamble above the frontmatter is still flagged and stripped', () => {
    const content = `Certainly. Here is the brain page.\n\n${FM}# Page\n\nBody.\n`;
    expect(preambleIssues(content)).toHaveLength(1);
    expect(fixContent(content).startsWith('---\n')).toBe(true);
  });

  test('stacked leading preambles are all stripped', () => {
    const fixed = fixContent('Sure! Here is the page.\nCertainly. Here is the brain page.\n\n# Title\n\nContent.');
    expect(fixed).toBe('# Title\n\nContent.\n');
  });
});

describe('runLintCore --fix skips a page it cannot write', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      try { chmodSync(join(r, 'readonly.md'), 0o644); } catch { /* absent */ }
      rmSync(r, { recursive: true, force: true });
    }
  });

  function brainWithReadOnlyPage(): string {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-lint-ro-'));
    roots.push(root);
    writeFileSync(join(root, 'readonly.md'), `${FM}Of course. Here is the brain page.\n\n# RO\n\nBody.\n`);
    chmodSync(join(root, 'readonly.md'), 0o444);
    writeFileSync(join(root, 'writable.md'), `${FM}Of course. Here is the brain page.\n\n# RW\n\nBody.\n`);
    return root;
  }

  test.skipIf(!posixNonRoot)('lint core records the read-only page and still fixes the rest', async () => {
    const root = brainWithReadOnlyPage();
    const result = await runLintCore({ target: root, fix: true, contentSanity: {}, typePack: null });
    expect(result.unwritable).toEqual(['readonly.md']);
    expect(result.total_fixed).toBe(1);
    expect(readFileSync(join(root, 'writable.md'), 'utf8')).not.toContain('Of course');
    expect(readFileSync(join(root, 'readonly.md'), 'utf8')).toContain('Of course');
  });

  test.skipIf(!posixNonRoot)('cycle lint phase warns (not fail) and lists the read-only page', async () => {
    const root = brainWithReadOnlyPage();
    const result = await runPhaseLint(root, false, null);
    expect(result.status).toBe('warn');
    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ fixed: 1, unwritable_count: 1, unwritable: ['readonly.md'] });
  });
});

describe('cycle lint honors dream.lint.exclude', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('pages under an excluded directory are neither scanned nor rewritten', async () => {
    await resetPgliteState(engine);
    const root = mkdtempSync(join(tmpdir(), 'gbrain-lint-dream-excl-'));
    try {
      mkdirSync(join(root, 'raw'));
      const rawPage = join(root, 'raw', 'capture.md');
      const rawBody = `Sure! Here is the transcript.\n\n${FM}# Capture\n\nBody.\n`;
      writeFileSync(rawPage, rawBody);
      writeFileSync(join(root, 'page.md'), `${FM}# Page\n\nBody.\n`);
      await engine.setConfig('dream.lint.exclude', 'raw, node_modules');

      const result = await runPhaseLint(root, false, engine);

      expect(result.status).toBe('ok');
      expect(result.details).toMatchObject({ pages_scanned: 1, fixed: 0, exclude: ['raw', 'node_modules'] });
      expect(readFileSync(rawPage, 'utf8')).toBe(rawBody);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
