/**
 * cat11-multimodal.ts tests — Day 6 of BrainBench v1 Complete.
 *
 * Covers:
 *   - charSimilarity math: identical / empty / partial
 *   - wordRecall: multiset semantics, empty canonical
 *   - wer (word error rate): perfect / half-off / empty ref
 *   - htmlToText: strips script/style/tags, decodes common entities
 *   - runHtmlModality with a real fixture (tmpdir, hand-rolled HTML)
 *   - runAudioModality skips gracefully without API keys + manifest
 *   - runPdfModality skips gracefully without manifest
 *   - runAudioModality uses injected transcriber stub
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  charSimilarity,
  wordRecall,
  wer,
  htmlToText,
  runHtmlModality,
  runAudioModality,
  runPdfModality,
  runCat11,
} from '../../eval/runner/cat11-multimodal.ts';

function tmpFixturesRoot(): string {
  const dir = join(tmpdir(), `cat11-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Pure math helpers ────────────────────────────────────────────────

describe('charSimilarity', () => {
  test('identical strings → 1', () => {
    expect(charSimilarity('hello world', 'hello world')).toBe(1);
  });

  test('empty vs non-empty → 0', () => {
    expect(charSimilarity('', 'hello')).toBe(0);
    expect(charSimilarity('hello', '')).toBe(0);
  });

  test('both empty → 1', () => {
    expect(charSimilarity('', '')).toBe(1);
  });

  test('one-char substitution', () => {
    // 'cat' vs 'bat' = 1 edit over max 3 chars = 1 - 1/3 = 0.667
    expect(charSimilarity('cat', 'bat')).toBeCloseTo(2 / 3, 6);
  });
});

describe('wordRecall', () => {
  test('all canonical words present → 1', () => {
    expect(wordRecall('the quick brown fox', 'the lazy fox jumped over the quick brown dog')).toBe(1);
  });

  test('none present → 0', () => {
    expect(wordRecall('one two three', 'alpha beta gamma')).toBe(0);
  });

  test('empty canonical → 1 (trivially satisfied)', () => {
    expect(wordRecall('', 'anything')).toBe(1);
  });

  test('multiset semantics: three "the" vs one "the" → 1/3', () => {
    expect(wordRecall('the the the', 'the cat')).toBeCloseTo(1 / 3, 6);
  });

  test('case-insensitive + strips punctuation', () => {
    expect(wordRecall('Hello, world!', 'hello world')).toBe(1);
  });
});

describe('wer', () => {
  test('perfect transcription → 0', () => {
    expect(wer('hello world', 'hello world')).toBe(0);
  });

  test('one word wrong → 0.5 on 2-word reference', () => {
    expect(wer('hello world', 'hello there')).toBe(0.5);
  });

  test('empty reference vs empty hypothesis → 0', () => {
    expect(wer('', '')).toBe(0);
  });

  test('empty reference + non-empty hypothesis → 1', () => {
    expect(wer('', 'anything')).toBe(1);
  });

  test('completely wrong → 1', () => {
    expect(wer('one two three', 'alpha beta gamma')).toBe(1);
  });
});

describe('htmlToText', () => {
  test('strips tags', () => {
    expect(htmlToText('<p>hello <b>world</b></p>')).toBe('hello world');
  });

  test('drops script + style contents entirely', () => {
    const html = '<html><head><style>body{}</style><script>alert(1)</script></head><body>visible</body></html>';
    const out = htmlToText(html);
    expect(out).toContain('visible');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('body{}');
  });

  test('decodes common entities', () => {
    expect(htmlToText('&lt;tag&gt; &amp; &quot;quote&quot;')).toContain('<tag> & "quote"');
  });

  test('collapses whitespace', () => {
    expect(htmlToText('<p>a\n\nb  \t  c</p>')).toBe('a b c');
  });
});

// ─── runHtmlModality (real filesystem + real manifest) ────────────────

describe('runHtmlModality', () => {
  let root: string;
  beforeEach(() => {
    root = tmpFixturesRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('skips gracefully when manifest missing', async () => {
    const result = await runHtmlModality(root);
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain('manifest');
  });

  test('scores real HTML fixture against canonical', async () => {
    writeFileSync(join(root, 'page.html'), '<html><body><p>hello world</p></body></html>');
    writeFileSync(join(root, 'page.txt'), 'hello world');
    writeFileSync(
      join(root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC-BY-SA',
        items: [
          {
            name: 'page',
            path: 'page.html',
            canonical_path: 'page.txt',
            sha256: 'unused-in-test',
          },
        ],
      }),
    );
    const result = await runHtmlModality(root);
    expect(result.skipped).toBe(false);
    expect(result.items).toBe(1);
    expect(result.items_attempted).toBe(1);
    expect(result.mean_metric).toBe(1); // canonical "hello world" recovered exactly
    expect(result.per_item[0].name).toBe('page');
  });

  test('missing fixture file produces an error entry (not a crash)', async () => {
    writeFileSync(
      join(root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC-BY-SA',
        items: [{ name: 'ghost', path: 'ghost.html', canonical_path: 'ghost.txt', sha256: 'x' }],
      }),
    );
    const result = await runHtmlModality(root);
    expect(result.skipped).toBe(false);
    expect(result.per_item[0].error).toContain('missing');
    expect(result.items_attempted).toBe(0);
  });
});

// ─── runAudioModality ─────────────────────────────────────────────────

describe('runAudioModality', () => {
  let root: string;
  const originalGroq = process.env.GROQ_API_KEY;
  const originalOpenAI = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    root = tmpFixturesRoot();
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalGroq !== undefined) process.env.GROQ_API_KEY = originalGroq;
    if (originalOpenAI !== undefined) process.env.OPENAI_API_KEY = originalOpenAI;
  });

  test('skips gracefully when manifest missing', async () => {
    const result = await runAudioModality(root);
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain('manifest');
  });

  test('skips gracefully when manifest present but no API key + no stub', async () => {
    writeFileSync(
      join(root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC0',
        items: [{ name: 'clip', path: 'clip.mp3', canonical_path: 'clip.txt', sha256: 'x' }],
      }),
    );
    const result = await runAudioModality(root);
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain('GROQ_API_KEY');
  });

  test('uses injected transcriber stub and computes WER', async () => {
    writeFileSync(join(root, 'clip.mp3'), 'fake audio bytes');
    writeFileSync(join(root, 'clip.txt'), 'hello world this is a test');
    writeFileSync(
      join(root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC0',
        items: [{ name: 'clip', path: 'clip.mp3', canonical_path: 'clip.txt', sha256: 'x' }],
      }),
    );
    const stubTranscribe = async () => ({ text: 'hello world this is a test', provider: 'stub' });
    const result = await runAudioModality(root, { transcribe: stubTranscribe });
    expect(result.skipped).toBe(false);
    expect(result.mean_metric).toBe(0); // perfect transcription → WER 0
  });

  test('stub that returns wrong transcription produces non-zero WER', async () => {
    writeFileSync(join(root, 'clip.mp3'), 'bytes');
    writeFileSync(join(root, 'clip.txt'), 'one two three four');
    writeFileSync(
      join(root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC0',
        items: [{ name: 'clip', path: 'clip.mp3', canonical_path: 'clip.txt', sha256: 'x' }],
      }),
    );
    const stub = async () => ({ text: 'one two three five', provider: 'stub' });
    const result = await runAudioModality(root, { transcribe: stub });
    expect(result.skipped).toBe(false);
    expect(result.mean_metric).toBe(0.25); // 1 word wrong / 4 words = 0.25
  });
});

// ─── runPdfModality ───────────────────────────────────────────────────

describe('runPdfModality', () => {
  let root: string;
  beforeEach(() => { root = tmpFixturesRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('skips gracefully when manifest missing', async () => {
    const result = await runPdfModality(root);
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toContain('manifest');
  });

  test('missing PDF file produces error entry (not crash)', async () => {
    writeFileSync(
      join(root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC-BY',
        items: [{ name: 'paper', path: 'ghost.pdf', canonical_path: 'ghost.txt', sha256: 'x' }],
      }),
    );
    const result = await runPdfModality(root);
    expect(result.skipped).toBe(false);
    expect(result.per_item[0].error).toContain('missing');
  });
});

// ─── runCat11 full dispatch ───────────────────────────────────────────

describe('runCat11', () => {
  let root: string;
  beforeEach(() => { root = tmpFixturesRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('returns skipped verdict when no modality has fixtures', async () => {
    const report = await runCat11({ fixturesRoot: root });
    expect(report.verdict).toBe('skipped');
    expect(report.results.pdf.skipped).toBe(true);
    expect(report.results.html.skipped).toBe(true);
    expect(report.results.audio.skipped).toBe(true);
  });

  test('returns baseline_only when at least one modality ran', async () => {
    // Set up an HTML fixture so at least one modality runs
    mkdirSync(join(root, 'html'), { recursive: true });
    writeFileSync(join(root, 'html/p.html'), '<body>hello</body>');
    writeFileSync(join(root, 'html/p.txt'), 'hello');
    writeFileSync(
      join(root, 'html/fixtures.json'),
      JSON.stringify({
        version: 1,
        license: 'CC-BY-SA',
        items: [{ name: 'p', path: 'p.html', canonical_path: 'p.txt', sha256: 'x' }],
      }),
    );
    const report = await runCat11({ fixturesRoot: root });
    expect(report.verdict).toBe('baseline_only');
    expect(report.results.html.skipped).toBe(false);
  });
});
