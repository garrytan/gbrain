/**
 * #2285 — transcript metadata discovery.
 *
 * Pins the two discovery-side additions:
 *   1. `transcriptSource` — derived from the `<source>/<date>/<file>` path
 *      layout; null for ad-hoc inputs that don't match.
 *   2. Content-based date inference — the `| First message | <ISO> |` row in
 *      the transcript's `## Metadata` table wins over the filename-regex
 *      date (stable across mtime-restamping re-syncs); filename is the
 *      fallback.
 *
 * Pure filesystem; no engine, no LLM.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  discoverTranscripts,
  readSingleTranscript,
  deriveTranscriptSource,
  inferContentDate,
} from '../../src/core/cycle/transcript-discovery.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-meta-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, body: string): string {
  const full = join(tmpDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
}

const FILLER = 'User: hello world. '.repeat(200);
const METADATA_BLOCK =
  '## Metadata\n\n| Key | Value |\n| --- | --- |\n| First message | 2026-05-15T03:51:11.584Z |\n\n';

describe('deriveTranscriptSource', () => {
  test('extracts the source slug from <source>/<date>/<file> layout', () => {
    expect(deriveTranscriptSource('/corpus/claude-code/2026-06-12/abc.md')).toBe('claude-code');
    expect(deriveTranscriptSource('/corpus/voice-notes/2026-06-12/xyz.md')).toBe('voice-notes');
  });

  test('null when the parent dir is not a date dir or grandparent is not a slug', () => {
    expect(deriveTranscriptSource('/corpus/flat-file.md')).toBeNull();
    expect(deriveTranscriptSource('/corpus/claude-code/not-a-date/abc.md')).toBeNull();
    expect(deriveTranscriptSource('/corpus/Not A Slug/2026-06-12/abc.md')).toBeNull();
  });
});

describe('inferContentDate', () => {
  test('parses the | First message | row', () => {
    expect(inferContentDate(METADATA_BLOCK)).toBe('2026-05-15');
  });
  test('null when absent', () => {
    expect(inferContentDate(FILLER)).toBeNull();
  });
});

describe('discoverTranscripts — transcriptSource + date cascade', () => {
  test('populates transcriptSource per file; null for flat files', () => {
    write('claude-code/2026-06-12/aaaa.md', FILLER);
    write('2026-06-12-flat.md', FILLER);
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 100 });
    const byBase = new Map(out.map(t => [t.basename, t.transcriptSource]));
    expect(byBase.get('aaaa')).toBe('claude-code');
    expect(byBase.get('2026-06-12-flat')).toBeNull();
  });

  test('content First-message date wins over the filename date', () => {
    write('2026-01-01-named.md', METADATA_BLOCK + FILLER);
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].inferredDate).toBe('2026-05-15');
  });

  test('filename date remains the fallback when content has no metadata row', () => {
    write('2026-01-01-named.md', FILLER);
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 100 });
    expect(out[0].inferredDate).toBe('2026-01-01');
  });

  test('date filter matches on the content date for UUID-named transcripts', () => {
    write('claude-code/2026-05-15/uuid-basename.md', METADATA_BLOCK + FILLER);
    const hit = discoverTranscripts({ corpusDir: tmpDir, minChars: 100, date: '2026-05-15' });
    expect(hit).toHaveLength(1);
    const miss = discoverTranscripts({ corpusDir: tmpDir, minChars: 100, date: '2026-05-16' });
    expect(miss).toHaveLength(0);
  });
});

describe('readSingleTranscript — same metadata surface', () => {
  test('carries transcriptSource and prefers the content date', () => {
    const p = write('claude-code/2026-05-15/2026-01-01-single.md', METADATA_BLOCK + FILLER);
    const t = readSingleTranscript(p, { minChars: 100 });
    expect(t).not.toBeNull();
    expect(t!.transcriptSource).toBe('claude-code');
    expect(t!.inferredDate).toBe('2026-05-15');
  });
});
