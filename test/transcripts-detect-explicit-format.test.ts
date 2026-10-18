/**
 * transcripts-detect-explicit-format.test.ts — `--format` bypasses content
 * sniffing, not filesystem admission.
 *
 * detectAdapter() refuses symlinks (lstat, never followed) and unreadable
 * paths, but the explicit-format branch used to return before that check, so
 * `gbrain transcripts ingest --format <f> <symlink>` handed the link to the
 * adapter's parse(), which opens it with a following read.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectAdapter } from '../src/core/transcripts/detect.ts';
import type { TranscriptFormat } from '../src/core/transcripts/types.ts';

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-detect-explicit-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function codexFile(dir: string): string {
  const p = join(dir, 'rollout.jsonl');
  writeFileSync(
    p,
    JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-id', timestamp: '2026-01-01T00:00:00Z' } }) + '\n',
  );
  return p;
}

const FORMATS: TranscriptFormat[] = ['codex', 'claude-code', 'grok'];

describe('detectAdapter with an explicit format', () => {
  for (const format of FORMATS) {
    test(`${format}: refuses a symlink to a regular file`, () => {
      const d = tdir();
      const link = join(d, 'link.jsonl');
      symlinkSync(codexFile(d), link);
      expect(detectAdapter(link, { explicitFormat: format })).toEqual({ ok: false, reason: 'symlink', tried: [] });
    });

    test(`${format}: refuses a dangling symlink`, () => {
      const d = tdir();
      const link = join(d, 'dangling.jsonl');
      symlinkSync(join(d, 'absent.jsonl'), link);
      expect(detectAdapter(link, { explicitFormat: format })).toEqual({ ok: false, reason: 'symlink', tried: [] });
    });

    test(`${format}: reports a missing path as unreadable`, () => {
      const d = tdir();
      expect(detectAdapter(join(d, 'missing.jsonl'), { explicitFormat: format })).toEqual({
        ok: false,
        reason: 'unreadable',
        tried: [],
      });
    });

    test(`${format}: still selects the named adapter for a regular file`, () => {
      const r = detectAdapter(codexFile(tdir()), { explicitFormat: format });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.adapter.format).toBe(format);
    });
  }

  test('still skips content sniffing for a regular file', () => {
    const d = tdir();
    const p = join(d, 'opaque.jsonl');
    writeFileSync(p, 'not a transcript');
    const r = detectAdapter(p, { explicitFormat: 'codex' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('codex');
  });
});
