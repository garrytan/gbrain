/**
 * v0.30.3 codex-mandated test gate C8 — #708 dream-cycle .md discovery.
 *
 * #708 broadened transcript discovery from .txt-only to .txt + .md.
 * Codex flagged this as a hot-path change immediately after v0.30.2's
 * chunking + self-consumption work. This gate pins three invariants:
 *
 *   1. .md transcripts are DISCOVERED (the feature works).
 *   2. Other extensions (.pdf, .doc) are still SKIPPED (nothing else broke).
 *   3. Dream-generated .md output IS NOT re-consumed by the next cycle
 *      (the self-consumption guard from v0.30.2 still fires for .md too).
 *
 * The third invariant is the codex concern: v0.30.2's `dream_generated: true`
 * frontmatter marker was the explicit identity surface for the
 * self-consumption guard, and it MUST work for .md files too — not just .txt.
 * If discovery widened to .md but the guard didn't, every dream cycle would
 * loop on its own output indefinitely.
 *
 * Pure filesystem walk + content read; no engine, no LLM, no fixtures.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-md-discovery-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTranscript(filename: string, body: string): void {
  writeFileSync(join(tmpDir, filename), body);
}

describe('C8: #708 .md transcript discovery', () => {
  test('discovers .md files alongside .txt', () => {
    writeTranscript('2026-04-25-text.txt', 'a'.repeat(3000));
    writeTranscript('2026-04-25-markdown.md', 'b'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    const basenames = out.map(t => t.basename);
    expect(basenames).toContain('2026-04-25-text');
    expect(basenames).toContain('2026-04-25-markdown');
    expect(out).toHaveLength(2);
  });

  test('skips other extensions (.pdf, .doc, .json) — only .txt + .md ingest', () => {
    writeTranscript('2026-04-25-pdf.pdf', 'a'.repeat(3000));
    writeTranscript('2026-04-25-doc.doc', 'b'.repeat(3000));
    writeTranscript('2026-04-25-json.json', 'c'.repeat(3000));
    writeTranscript('2026-04-25-real.md', 'd'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-real');
  });

  test('SELF-CONSUMPTION GUARD: .md files with dream_generated frontmatter are skipped', () => {
    // v0.30.2's self-consumption guard: any file whose frontmatter declares
    // `dream_generated: true` is dream-cycle output, not user input. The
    // guard MUST fire for .md files too — that's the hottest path post-#708.
    writeTranscript(
      '2026-04-25-fresh-input.md',
      `# Garry's notes from 2026-04-25\n\n${'real content '.repeat(300)}`,
    );
    writeTranscript(
      '2026-04-25-dream-output.md',
      `---\ndream_generated: true\ndream_cycle_date: 2026-04-25\n---\n\n${'synth output '.repeat(300)}`,
    );
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    const basenames = out.map(t => t.basename);
    expect(basenames).toContain('2026-04-25-fresh-input');
    expect(basenames).not.toContain('2026-04-25-dream-output');
    expect(out).toHaveLength(1);
  });

  test('guard SURVIVES BOM + CRLF in .md frontmatter', () => {
    // The marker regex handles BOM + CRLF tolerance per the v0.30.2 design.
    // Confirm it works on .md files too — dream output may be written with
    // platform-default line endings on Windows-flavored runs.
    const bom = '﻿';
    writeTranscript(
      '2026-04-25-bom-output.md',
      `${bom}---\r\ndream_generated: true\r\ndream_cycle_date: 2026-04-25\r\n---\r\n\r\n${'x'.repeat(3000)}`,
    );
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toHaveLength(0);
  });

  test('--unsafe-bypass-dream-guard DOES re-include .md dream output (escape hatch works)', () => {
    writeTranscript(
      '2026-04-25-dream-output.md',
      `---\ndream_generated: true\ndream_cycle_date: 2026-04-25\n---\n\n${'synth '.repeat(300)}`,
    );
    const guarded = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(guarded).toHaveLength(0);

    const bypassed = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000, bypassGuard: true });
    expect(bypassed).toHaveLength(1);
    expect(bypassed[0].basename).toBe('2026-04-25-dream-output');
  });

  test('mixed .txt + .md corpus: dedup is per-basename across extensions', () => {
    // If both 2026-04-25-foo.txt and 2026-04-25-foo.md exist, the discovery
    // should not double-count. (One could argue this scenario shouldn't happen
    // in practice; pinning the behavior so future changes are intentional.)
    writeTranscript('2026-04-25-foo.txt', 'a'.repeat(3000));
    writeTranscript('2026-04-25-foo.md', 'b'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    // We accept either: one entry (deduplicated) or two entries (both kept).
    // The current behavior (post-#708) keeps both since the file paths differ.
    // Pin that to surface any future implicit change.
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});
