/**
 * #2415 — configurable dream output namespace (`dream.synthesize.output_root`).
 *
 * The synthesize + patterns phases previously hardcoded `wiki/` in the
 * subagent prompt slug templates, the patterns reflection lookup, and the
 * trusted-workspace allow-list loaded from skills/_brain-filing-rules.json.
 * This suite pins:
 *   - default 'wiki' → byte-identical prompt + verbatim filing-rule globs
 *     (zero behavior change unless the key is set);
 *   - a custom root remaps prompt slug templates and the allow-list globs;
 *   - loadOutputRoot validates against the slug grammar (bad values fall
 *     back to 'wiki');
 *   - the patterns phase gathers reflections under the configured root.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing, loadAllowedSlugPrefixes, loadOutputRoot } from '../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const { buildSynthesisPrompt } = __testing;

const transcript: DiscoveredTranscript = {
  filePath: '/tmp/t.txt',
  basename: 't',
  content: 'User: hello world',
  contentHash: 'abcdef0123456789',
  inferredDate: '2026-07-17',
} as DiscoveredTranscript;

describe('#2415: buildSynthesisPrompt output root', () => {
  test('defaults to wiki/ slug templates', () => {
    const prompt = buildSynthesisPrompt(transcript, 'chunk', 0, 1);
    expect(prompt).toContain('wiki/personal/reflections/2026-07-17-');
    expect(prompt).toContain('wiki/originals/ideas/2026-07-17-');
  });

  test('custom root replaces wiki/ in both slug templates', () => {
    const prompt = buildSynthesisPrompt(transcript, 'chunk', 0, 1, '', 'notes');
    expect(prompt).toContain('notes/personal/reflections/2026-07-17-');
    expect(prompt).toContain('notes/originals/ideas/2026-07-17-');
    expect(prompt).not.toContain('wiki/personal/reflections/');
    expect(prompt).not.toContain('wiki/originals/ideas/');
  });
});

describe('#2415: loadAllowedSlugPrefixes remap', () => {
  // Runs from the repo root, so skills/_brain-filing-rules.json resolves.
  test("default 'wiki' returns the filing-rule globs verbatim", async () => {
    const globs = await loadAllowedSlugPrefixes();
    expect(globs).toContain('wiki/personal/reflections/*');
    expect(globs).toContain('dream-cycle-summaries/*');
  });

  test('custom root remaps only wiki/-rooted globs', async () => {
    const globs = await loadAllowedSlugPrefixes('notes');
    expect(globs).toContain('notes/personal/reflections/*');
    expect(globs).toContain('notes/originals/*');
    expect(globs).toContain('notes/personal/patterns/*');
    // Non-wiki globs pass through untouched.
    expect(globs).toContain('dream-cycle-summaries/*');
    expect(globs.some(g => g.startsWith('wiki/'))).toBe(false);
  });
});

describe('#2415: loadOutputRoot validation + patterns gather scope', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('unset → wiki; trailing slash trimmed; invalid → wiki fallback', async () => {
    expect(await loadOutputRoot(engine)).toBe('wiki');
    await engine.setConfig('dream.synthesize.output_root', 'notes/');
    expect(await loadOutputRoot(engine)).toBe('notes');
    await engine.setConfig('dream.synthesize.output_root', '../escape');
    expect(await loadOutputRoot(engine)).toBe('wiki');
    await engine.setConfig('dream.synthesize.output_root', 'Bad_Root');
    expect(await loadOutputRoot(engine)).toBe('wiki');
  });

  test('CJK root passes the slug grammar (#738)', async () => {
    await engine.setConfig('dream.synthesize.output_root', '知识/笔记');
    expect(await loadOutputRoot(engine)).toBe('知识/笔记');
    await engine.setConfig('dream.synthesize.output_root', '');
  });

  test('patterns phase gathers reflections under the configured root', async () => {
    await engine.setConfig('dream.synthesize.output_root', 'notes');
    for (let i = 0; i < 3; i++) {
      await engine.putPage(`notes/personal/reflections/2026-07-17-r${i}`, {
        type: 'note',
        title: `R${i}`,
        compiled_truth: `reflection ${i}`,
        timeline: '',
        frontmatter: {},
      });
    }
    // A wiki/-rooted reflection must NOT be counted under the custom root.
    await engine.putPage('wiki/personal/reflections/2026-07-17-old', {
      type: 'note',
      title: 'Old',
      compiled_truth: 'legacy reflection',
      timeline: '',
      frontmatter: {},
    });
    const result = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.details?.reflections_considered).toBe(3);
  });
});
