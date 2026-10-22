/**
 * #7246: serve's log was never rotated, and about 98% of it was the same
 * no-action warnings printed again on every managed pass. When serve's
 * stdout or stderr is a regular file (the launchd / systemd / nohup installs
 * `gbrain mcp expose` writes, or any `>>` redirect), serve now rotates that
 * file at a size bound with a capped number of copies, and collapses a line
 * repeated inside the dedupe window into its first occurrence plus one
 * "repeated N more time(s)" line.
 *
 * Authoring gate: protects the on-disk log bound and the first-occurrence
 * guarantee; fails if rotation stops at the bound, keeps more copies than the
 * cap, drops a first occurrence or miscounts repeats; nothing covered the
 * serve log before.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LineDeduper, ServeLogFile, resolveServeLogPolicy } from '../src/core/serve-log.ts';

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'serve-log-7246-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('LineDeduper (#7246)', () => {
  test('keeps the first occurrence, counts repeats inside the window, then summarizes once', () => {
    let now = 0;
    const dedupe = new LineDeduper(60_000, () => now);
    const warning = '[import] WARNING: a.md shares content_hash with b (abcd1234) but not its frontmatter.id. Indexing both.';
    expect(dedupe.accept(warning)).toEqual([warning]);
    now = 1_000;
    expect(dedupe.accept(warning)).toEqual([]);
    expect(dedupe.accept(warning)).toEqual([]);
    expect(dedupe.accept('a different line')).toEqual(['a different line']);
    now = 61_000;
    const after = dedupe.accept(warning);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(`[gbrain serve-log] repeated 2 more time(s) in the last 60s: ${warning}`);
    expect(after[1]).toBe(warning);
  });

  test('a leading timestamp does not make a repeat distinct, and exit flushes pending counts', () => {
    let now = 0;
    const dedupe = new LineDeduper(60_000, () => now);
    expect(dedupe.accept('2026-10-21T10:00:00.000Z content-sanity warn: x.md (9 bytes)')).toHaveLength(1);
    now = 5;
    expect(dedupe.accept('2026-10-21T10:00:05.123Z content-sanity warn: x.md (9 bytes)')).toEqual([]);
    expect(dedupe.flush(true)).toEqual(['[gbrain serve-log] repeated 1 more time(s) in the last 60s: 2026-10-21T10:00:00.000Z content-sanity warn: x.md (9 bytes)']);
    expect(dedupe.flush(true)).toEqual([]);
  });

  test('a zero window keeps every line', () => {
    const dedupe = new LineDeduper(0, () => 0);
    expect(dedupe.accept('same')).toEqual(['same']);
    expect(dedupe.accept('same')).toEqual(['same']);
  });
});

describe('ServeLogFile rotation (#7246)', () => {
  test('rotates at the size bound and keeps at most max_files copies', () => {
    const path = join(scratch(), 'serve.log');
    const fd = openSync(path, 'a');
    try {
      const log = new ServeLogFile(fd, path, { maxBytes: 1_000, maxFiles: 2, dedupeWindowMs: 0 });
      const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(90)}`);
      for (const line of lines) log.write(`${line}\n`);
      expect(statSync(path).size).toBeLessThanOrEqual(1_000);
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(existsSync(`${path}.2`)).toBe(true);
      expect(existsSync(`${path}.3`)).toBe(false);
      const kept = [readFileSync(`${path}.2`, 'utf8'), readFileSync(`${path}.1`, 'utf8'), readFileSync(path, 'utf8')].join('').split('\n').filter(Boolean);
      expect(kept).toEqual(lines.slice(lines.length - kept.length));
      for (const file of [path, `${path}.1`, `${path}.2`]) expect(statSync(file).size).toBeLessThanOrEqual(1_000);
    } finally {
      closeSync(fd);
    }
  });
});

describe('resolveServeLogPolicy (#7246)', () => {
  test('defaults, overrides, and an invalid value falls back with a warning', () => {
    expect(resolveServeLogPolicy({}, () => {})).toEqual({ maxBytes: 10 * 1024 * 1024, maxFiles: 5, dedupeWindowMs: 600_000 });
    const warnings: string[] = [];
    const policy = resolveServeLogPolicy({ GBRAIN_SERVE_LOG_MAX_BYTES: '0', GBRAIN_SERVE_LOG_MAX_FILES: 'three', GBRAIN_SERVE_LOG_DEDUPE_SECONDS: '30' }, line => warnings.push(line));
    expect(policy).toEqual({ maxBytes: 0, maxFiles: 5, dedupeWindowMs: 30_000 });
    expect(warnings).toEqual(['[gbrain serve] ignoring invalid GBRAIN_SERVE_LOG_MAX_FILES="three" — using default 5']);
  });
});

describe('installServeLogSink on redirected streams (#7246)', () => {
  test('a serve process appending to log files dedupes stderr warnings and rotates stdout', async () => {
    const dir = scratch();
    const script = join(dir, 'child.ts');
    await Bun.write(script, [
      `import { installServeLogSink } from ${JSON.stringify(resolve('src/core/serve-log.ts'))};`,
      "installServeLogSink({ http: true });",
      "for (let i = 0; i < 100; i++) console.warn('[gbrain] markdown fence cap hit (100 fences/page); skipping additional fences.');",
      "console.error('a different warning');",
      "for (let i = 0; i < 40; i++) console.log(`request ${i} ${'y'.repeat(80)}`);",
    ].join('\n'));
    const child = Bun.spawn(['sh', '-c', 'exec "$BUN" "$SCRIPT" >> "$DIR/serve.log" 2>> "$DIR/serve.err"'], {
      env: { PATH: process.env.PATH, BUN: process.execPath, SCRIPT: script, DIR: dir, GBRAIN_SERVE_LOG_MAX_BYTES: '1024', GBRAIN_SERVE_LOG_MAX_FILES: '2' },
    });
    expect(await child.exited).toBe(0);
    const err = readFileSync(join(dir, 'serve.err'), 'utf8').split('\n').filter(Boolean);
    expect(err).toEqual([
      '[gbrain] markdown fence cap hit (100 fences/page); skipping additional fences.',
      'a different warning',
      '[gbrain serve-log] repeated 99 more time(s) in the last 600s: [gbrain] markdown fence cap hit (100 fences/page); skipping additional fences.',
    ]);
    expect(statSync(join(dir, 'serve.log')).size).toBeLessThanOrEqual(1024);
    expect(existsSync(join(dir, 'serve.log.1'))).toBe(true);
    expect(existsSync(join(dir, 'serve.log.3'))).toBe(false);
    expect(readFileSync(join(dir, 'serve.log'), 'utf8').trimEnd().split('\n').pop()).toStartWith('request 39 ');
  }, 30_000);
});
