/**
 * gbrain integrity tests — pure regex + frontmatter-extract paths.
 *
 * The three-bucket auto path runs end-to-end in a manual smoke script
 * against a real brain; the unit tests here focus on the pure detection
 * logic (bare-tweet regex, external-link extraction, frontmatter handle
 * extraction) that determines what reaches the resolver.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  findBareTweetHits,
  findExternalLinks,
  extractXHandleFromFrontmatter,
  runIntegrity,
  scanIntegrity,
} from '../src/commands/integrity.ts';

// ---------------------------------------------------------------------------
// Bare-tweet regex
// ---------------------------------------------------------------------------

describe('findBareTweetHits', () => {
  test('catches "tweeted about X" without URL', () => {
    const hits = findBareTweetHits('Garry tweeted about AI safety last week.', 'people/garrytan');
    expect(hits).toHaveLength(1);
    expect(hits[0].phrase).toMatch(/tweeted about/i);
    expect(hits[0].line).toBe(1);
  });

  test('catches "in a tweet" style phrasing', () => {
    const compiled = [
      'Some other content.',
      '',
      'He said in a recent tweet that the market was shifting.',
    ].join('\n');
    const hits = findBareTweetHits(compiled, 'people/x');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });

  test('skips line that already has a tweet URL', () => {
    const line = 'As he tweeted about YC (https://x.com/garrytan/status/123456).';
    const hits = findBareTweetHits(line, 'people/x');
    expect(hits).toEqual([]);
  });

  test('skips fenced code blocks entirely', () => {
    const compiled = [
      '```',
      'He tweeted about the fix.',
      '```',
    ].join('\n');
    const hits = findBareTweetHits(compiled, 'people/x');
    expect(hits).toEqual([]);
  });

  test('detects twitter.com URLs as already-cited too', () => {
    const line = 'She wrote (https://twitter.com/someuser/status/999) about it.';
    const hits = findBareTweetHits(line, 'people/x');
    expect(hits).toEqual([]);
  });

  test('catches "posted on X"', () => {
    const hits = findBareTweetHits('They posted on X yesterday.', 'people/x');
    expect(hits).toHaveLength(1);
  });

  test('catches possessive phrasing ("his recent tweet")', () => {
    const hits = findBareTweetHits('His recent tweet said as much.', 'people/x');
    expect(hits).toHaveLength(1);
  });

  test('does NOT trigger on already-cited "via X/handle" form', () => {
    const hits = findBareTweetHits('Mentioned via X/garrytan earlier.', 'people/x');
    expect(hits).toEqual([]);
  });

  test('only one hit per line even if multiple phrases match', () => {
    const hits = findBareTweetHits('He tweeted about it in a tweet later.', 'people/x');
    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// External-link extraction
// ---------------------------------------------------------------------------

describe('findExternalLinks', () => {
  test('extracts http+https URLs', () => {
    const compiled = 'See [the essay](https://example.com/essay) or [legacy](http://old.example/).';
    const hits = findExternalLinks(compiled, 'concepts/x');
    expect(hits.map(h => h.url)).toEqual([
      'https://example.com/essay',
      'http://old.example/',
    ]);
  });

  test('ignores wikilinks without scheme', () => {
    const compiled = 'See [Alice](../people/alice.md) for context.';
    const hits = findExternalLinks(compiled, 'concepts/x');
    expect(hits).toEqual([]);
  });

  test('ignores links inside fenced code', () => {
    const compiled = '```\n[url](https://example.com)\n```';
    const hits = findExternalLinks(compiled, 'concepts/x');
    expect(hits).toEqual([]);
  });

  test('line numbers are 1-based and accurate', () => {
    const compiled = 'line 1\n\n[link](https://example.com) on line 3';
    const hits = findExternalLinks(compiled, 'x/y');
    expect(hits[0].line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter handle extraction
// ---------------------------------------------------------------------------

describe('extractXHandleFromFrontmatter', () => {
  test('reads x_handle', () => {
    expect(extractXHandleFromFrontmatter({ x_handle: 'garrytan' })).toBe('garrytan');
  });

  test('reads twitter', () => {
    expect(extractXHandleFromFrontmatter({ twitter: 'garrytan' })).toBe('garrytan');
  });

  test('reads twitter_handle', () => {
    expect(extractXHandleFromFrontmatter({ twitter_handle: 'garrytan' })).toBe('garrytan');
  });

  test('strips leading @', () => {
    expect(extractXHandleFromFrontmatter({ x_handle: '@garrytan' })).toBe('garrytan');
  });

  test('returns null on undefined frontmatter', () => {
    expect(extractXHandleFromFrontmatter(undefined)).toBeNull();
  });

  test('returns null when no handle key is present', () => {
    expect(extractXHandleFromFrontmatter({ name: 'Garry Tan' })).toBeNull();
  });

  test('returns null on empty string', () => {
    expect(extractXHandleFromFrontmatter({ x_handle: '' })).toBeNull();
  });

  test('preference order: x_handle > twitter > twitter_handle > x', () => {
    expect(extractXHandleFromFrontmatter({
      x_handle: 'primary',
      twitter: 'secondary',
      twitter_handle: 'tertiary',
      x: 'quaternary',
    })).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// CLI dispatch — non-DB paths (help + review-on-empty)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// scanIntegrity — pure library function called from doctor + cmdCheck
// ---------------------------------------------------------------------------

describe('scanIntegrity', () => {
  let engine: BrainEngine;
  let dbDir: string;

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'scan-integrity-'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbDir });
    await engine.initSchema();
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice tweeted about AI safety last week.',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('people/bob', {
      type: 'person',
      title: 'Bob',
      compiled_truth: 'Bob wrote at [example](https://example.com/bob).',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('people/legacy', {
      type: 'person',
      title: 'Legacy',
      compiled_truth: 'Legacy tweeted about old stuff.',
      timeline: '',
      frontmatter: { validate: false },
    });
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('counts bare-tweet + external-link hits across pages', async () => {
    const res = await scanIntegrity(engine);
    expect(res.pagesScanned).toBe(2);
    expect(res.bareHits.length).toBe(1);
    expect(res.bareHits[0].slug).toBe('people/alice');
    expect(res.externalHits.length).toBe(1);
    expect(res.externalHits[0].slug).toBe('people/bob');
  });

  test('skips pages with validate:false frontmatter', async () => {
    const res = await scanIntegrity(engine);
    const slugs = res.bareHits.map(h => h.slug);
    expect(slugs).not.toContain('people/legacy');
  });

  test('honors limit', async () => {
    const res = await scanIntegrity(engine, { limit: 1 });
    expect(res.pagesScanned).toBe(1);
  });

  test('honors typeFilter prefix match', async () => {
    const res = await scanIntegrity(engine, { typeFilter: 'companies' });
    expect(res.pagesScanned).toBe(0);
  });

  test('topPages sorted by hit count', async () => {
    const res = await scanIntegrity(engine);
    expect(res.topPages).toEqual([{ slug: 'people/alice', count: 1 }]);
  });
});

describe('runIntegrity CLI dispatch', () => {
  test('--help prints help without touching engine', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await runIntegrity(['--help']);
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toMatch(/gbrain integrity/i);
  });

  test('no subcommand behaves like --help', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await runIntegrity([]);
    } finally {
      console.log = origLog;
    }
    expect(logs.join('\n')).toMatch(/integrity/i);
  });

  test('unknown subcommand prints error + exits', async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exit;
    let exitCode: number | undefined;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    console.error = (msg?: unknown) => { errs.push(String(msg)); };
    // prevent process.exit from killing the test runner
    process.exit = ((code?: number) => { exitCode = code; throw new Error('__exit__'); }) as typeof process.exit;
    try {
      await runIntegrity(['nonsense-cmd']);
    } catch (e) {
      if ((e as Error).message !== '__exit__') throw e;
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/Unknown subcommand/);
  });
});
