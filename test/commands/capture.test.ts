/**
 * gbrain capture CLI verb tests.
 *
 * Pure helper coverage (parseArgs, defaultSlug, buildContent) + an
 * integration smoke that the local-install path lands a page when the
 * engine is connected. Thin-client routing isn't exercised here (that's
 * an e2e concern; the local path uses the same put_page operation and
 * gets the same write-through plumbing).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import matter from 'gray-matter';
import { runCapture, __testing } from '../../src/commands/capture.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-capture-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

describe('capture — defaultSlug helper', () => {
  test('builds inbox/YYYY-MM-DD-<hash8> shape', () => {
    const slug = __testing.defaultSlug('hello world', new Date('2026-05-20T12:00:00Z'));
    expect(slug).toMatch(/^inbox\/2026-05-20-[a-f0-9]{8}$/);
  });

  test('deterministic for same content', () => {
    const date = new Date('2026-05-20T00:00:00Z');
    expect(__testing.defaultSlug('thought A', date)).toBe(__testing.defaultSlug('thought A', date));
  });

  test('different content -> different slug', () => {
    const date = new Date('2026-05-20T00:00:00Z');
    expect(__testing.defaultSlug('thought A', date)).not.toBe(__testing.defaultSlug('thought B', date));
  });

  test('UTC math (no tz drift)', () => {
    const slug = __testing.defaultSlug('x', new Date('2026-01-05T23:59:59Z'));
    expect(slug).toMatch(/^inbox\/2026-01-05-/);
  });
});

describe('capture — parseArgs', () => {
  test('inline content goes into opts.content', () => {
    const r = __testing.parseArgs(['hello world']);
    expect('help' in r).toBe(false);
    if (!('help' in r)) expect(r.content).toBe('hello world');
  });

  test('multi-token inline content is joined with spaces', () => {
    const r = __testing.parseArgs(['some', 'tokens', 'here']);
    if (!('help' in r)) expect(r.content).toBe('some tokens here');
  });

  test('flags are extracted out of positional', () => {
    const r = __testing.parseArgs(['--slug', 'inbox/x', 'the', 'thought']);
    if (!('help' in r)) {
      expect(r.slug).toBe('inbox/x');
      expect(r.content).toBe('the thought');
    }
  });

  test('--file is captured', () => {
    const r = __testing.parseArgs(['--file', '/tmp/note.md']);
    if (!('help' in r)) expect(r.filePath).toBe('/tmp/note.md');
  });

  test('--stdin flag', () => {
    const r = __testing.parseArgs(['--stdin']);
    if (!('help' in r)) expect(r.stdin).toBe(true);
  });

  test('--quiet, --json, --help', () => {
    const r1 = __testing.parseArgs(['--quiet']);
    if (!('help' in r1)) expect(r1.quiet).toBe(true);
    const r2 = __testing.parseArgs(['--json']);
    if (!('help' in r2)) expect(r2.json).toBe(true);
    const r3 = __testing.parseArgs(['--help']);
    expect('help' in r3).toBe(true);
  });
});

describe('capture — buildContent', () => {
  test('wraps plain prose in frontmatter + heading', () => {
    const result = __testing.buildContent('a simple thought', {});
    expect(result).toContain('---');
    expect(result).toContain('type: note');
    expect(result).toContain('captured_via: capture-cli');
    expect(result).toContain('# a simple thought');
  });

  test('honors --type override', () => {
    const result = __testing.buildContent('body', { type: 'idea' });
    expect(result).toContain('type: idea');
  });

  test('does not double-wrap content that already has frontmatter', () => {
    const result = __testing.buildContent('---\ntitle: pre-wrapped\n---\n\nbody', {});
    // The result has our captured-via frontmatter PLUS the body that
    // included its own frontmatter (raw). Importantly we don't prepend a
    // second `# ...` heading.
    const headingCount = (result.match(/^# /gm) ?? []).length;
    expect(headingCount).toBe(0);
  });

  test('uses first non-empty line as the title', () => {
    // v0.39.3.0: BUG-1 fix moved buildContent to mergeCaptureFrontmatter
    // which uses gray-matter's `matter.stringify()`. The emitter follows
    // YAML defaults — simple strings emit unquoted (`title: Real first
    // line`), strings with special chars get single-quoted (the prior
    // hand-rolled `title: "..."` JSON-style quoting is gone). Parse the
    // YAML and assert on the value, not the literal quoting style.
    const result = __testing.buildContent('\n  \nReal first line\nmore', {});
    const parsed = matter(result);
    expect(parsed.data.title).toBe('Real first line');
  });

  test('caps title at 80 chars', () => {
    const longLine = 'x'.repeat(200);
    const result = __testing.buildContent(longLine, {});
    const parsed = matter(result);
    expect(typeof parsed.data.title).toBe('string');
    expect((parsed.data.title as string).length).toBeLessThanOrEqual(80);
  });

  test('honors --source via captured_via', () => {
    const result = __testing.buildContent('body', { source: 'voice-whisper' });
    expect(result).toContain('captured_via: voice-whisper');
  });
});

describe('capture — local install integration', () => {
  test('inline content lands as a page + a file on disk', async () => {
    // Capture writes to stdout/stderr; redirect those to nullsinks so the
    // test runner doesn't show the receipt block.
    const logCaptured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logCaptured.push(args.map(String).join(' '));
    try {
      await runCapture(engine, ['--slug', 'inbox/test-capture-1', '--quiet', 'A captured thought']);
    } finally {
      console.log = origLog;
    }

    // --quiet should have printed just the slug.
    expect(logCaptured.length).toBeGreaterThan(0);
    expect(logCaptured[0]).toBe('inbox/test-capture-1');

    // Page exists in the DB.
    const page = await engine.getPage('inbox/test-capture-1');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('A captured thought');

    // File written to disk via write-through.
    const onDisk = path.join(brainDir, 'inbox/test-capture-1.md');
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  test('default slug is inbox/YYYY-MM-DD-<hash8> when --slug not provided', async () => {
    const logCaptured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logCaptured.push(args.map(String).join(' '));
    try {
      await runCapture(engine, ['--quiet', 'auto-slugged']);
    } finally {
      console.log = origLog;
    }
    const printedSlug = logCaptured[0];
    expect(printedSlug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  });

  test('--file reads content from disk', async () => {
    const file = path.join(tmpRoot, 'note.md');
    fs.writeFileSync(file, '# from a file\n\nbody content here');
    const logCaptured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logCaptured.push(args.map(String).join(' '));
    try {
      await runCapture(engine, ['--file', file, '--slug', 'inbox/from-file', '--quiet']);
    } finally {
      console.log = origLog;
    }
    const page = await engine.getPage('inbox/from-file');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('body content here');
  });

  test('--json emits structured output', async () => {
    const logCaptured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logCaptured.push(args.map(String).join(' '));
    try {
      await runCapture(engine, ['--json', '--slug', 'inbox/json-out', 'jsonny']);
    } finally {
      console.log = origLog;
    }
    expect(logCaptured.length).toBeGreaterThan(0);
    const json = JSON.parse(logCaptured.join('\n'));
    expect(json.slug).toBe('inbox/json-out');
    expect(json.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(json.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('capture — help', () => {
  test('--help prints usage and returns without engine roundtrip', async () => {
    const logCaptured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logCaptured.push(args.map(String).join(' '));
    try {
      await runCapture(null, ['--help']);
    } finally {
      console.log = origLog;
    }
    expect(logCaptured.join('\n')).toContain('Usage: gbrain capture');
  });
});
