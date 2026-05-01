/**
 * Unit tests for the synthesize phase scaffolding.
 *
 * Covers transcript-discovery branches (date filters, exclude regex,
 * minChars, multiple sources) and the compileExcludePatterns word-
 * boundary heuristic. Doesn't drive a real Anthropic call — full
 * cycle E2E lives in test/e2e/.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverTranscripts,
  readSingleTranscript,
  compileExcludePatterns,
  isDreamOutput,
  DREAM_OUTPUT_MARKER_RE,
} from '../src/core/cycle/transcript-discovery.ts';
import { judgeSignificance, renderPageToMarkdown, type JudgeClient } from '../src/core/cycle/synthesize.ts';

let tmpDir: string;

function makeTranscript(name: string, body: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-test-'));
});

describe('compileExcludePatterns', () => {
  test('auto-wraps bare words in word-boundary regex (Q-3)', () => {
    const res = compileExcludePatterns(['medical']);
    expect(res).toHaveLength(1);
    // word boundary: matches "medical" but NOT "comedical"
    expect(res[0].test('medical advice')).toBe(true);
    expect(res[0].test('comedical')).toBe(false);
  });

  test('honors raw regex when input is non-bare-word', () => {
    const res = compileExcludePatterns(['^therapy:']);
    expect(res[0].test('therapy: today was hard')).toBe(true);
    expect(res[0].test('thinking about therapy:')).toBe(false);
  });

  test('skips invalid regex with warning, does not crash', () => {
    const res = compileExcludePatterns(['valid', '(broken[']);
    expect(res).toHaveLength(1); // only the valid one compiled
  });

  test('case-insensitive matching by default', () => {
    const res = compileExcludePatterns(['Medical']);
    expect(res[0].test('medical advice')).toBe(true);
    expect(res[0].test('MEDICAL ADVICE')).toBe(true);
  });

  test('empty / undefined input returns empty array', () => {
    expect(compileExcludePatterns(undefined)).toEqual([]);
    expect(compileExcludePatterns([])).toEqual([]);
    expect(compileExcludePatterns([''])).toEqual([]);
  });
});

describe('discoverTranscripts', () => {
  test('returns empty when corpusDir does not exist', () => {
    const out = discoverTranscripts({ corpusDir: '/nonexistent/path' });
    expect(out).toEqual([]);
  });

  test('returns transcripts above minChars, sorted by filePath', () => {
    makeTranscript('2026-04-25-session.txt', 'a'.repeat(2500));
    makeTranscript('2026-04-24-other.txt', 'b'.repeat(2500));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toHaveLength(2);
    expect(out[0].basename).toBe('2026-04-24-other');
    expect(out[1].basename).toBe('2026-04-25-session');
  });

  test('skips transcripts below minChars', () => {
    makeTranscript('2026-04-25-short.txt', 'tiny');
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 2000 });
    expect(out).toEqual([]);
  });

  test('skips non-txt files', () => {
    makeTranscript('2026-04-25-foo.md', 'a'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toEqual([]);
  });

  test('exclude_patterns filters out matched transcripts (word boundary)', () => {
    makeTranscript('2026-04-25-medical.txt', 'discussing medical advice ' + 'x'.repeat(3000));
    makeTranscript('2026-04-25-comedy.txt', 'comedical writing tips ' + 'x'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      minChars: 1000,
      excludePatterns: ['medical'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-comedy');
  });

  test('--date filter restricts to one specific YYYY-MM-DD basename', () => {
    makeTranscript('2026-04-25-foo.txt', 'a'.repeat(3000));
    makeTranscript('2026-04-26-bar.txt', 'b'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      minChars: 1000,
      date: '2026-04-25',
    });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-foo');
  });

  test('--from / --to range filters basename dates', () => {
    makeTranscript('2026-04-23-a.txt', 'a'.repeat(3000));
    makeTranscript('2026-04-25-b.txt', 'b'.repeat(3000));
    makeTranscript('2026-04-27-c.txt', 'c'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      minChars: 1000,
      from: '2026-04-24',
      to: '2026-04-26',
    });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-b');
  });

  test('multiple sources (corpus + meeting transcripts) merged', () => {
    makeTranscript('2026-04-25-session.txt', 'a'.repeat(3000));
    const meetDir = mkdtempSync(join(tmpdir(), 'gbrain-meet-'));
    writeFileSync(join(meetDir, '2026-04-25-meeting.txt'), 'b'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      meetingTranscriptsDir: meetDir,
      minChars: 1000,
    });
    expect(out).toHaveLength(2);
    rmSync(meetDir, { recursive: true, force: true });
  });

  test('content_hash is stable for identical content, different for edits (A-3)', () => {
    makeTranscript('2026-04-25-a.txt', 'identical content ' + 'x'.repeat(3000));
    makeTranscript('2026-04-25-b.txt', 'identical content ' + 'x'.repeat(3000));
    const out1 = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out1[0].contentHash).toBe(out1[1].contentHash);

    // Edit one — hash changes
    makeTranscript('2026-04-25-a.txt', 'edited content ' + 'x'.repeat(3000));
    const out2 = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out2[0].contentHash).not.toBe(out2[1].contentHash);
  });
});

describe('readSingleTranscript', () => {
  test('returns transcript above minChars', () => {
    const path = makeTranscript('hello.txt', 'a'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000 });
    expect(t).not.toBeNull();
    expect(t!.basename).toBe('hello');
  });

  test('returns null when below minChars', () => {
    const path = makeTranscript('hello.txt', 'tiny');
    const t = readSingleTranscript(path, { minChars: 2000 });
    expect(t).toBeNull();
  });

  test('returns null when content matches exclude pattern', () => {
    const path = makeTranscript('hello.txt', 'medical content ' + 'x'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000, excludePatterns: ['medical'] });
    expect(t).toBeNull();
  });

  test('throws on missing file', () => {
    expect(() => readSingleTranscript('/nonexistent/foo.txt')).toThrow();
  });

  test('infers date from YYYY-MM-DD basename', () => {
    const path = makeTranscript('2026-04-25-thing.txt', 'a'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000 });
    expect(t!.inferredDate).toBe('2026-04-25');
  });

  test('inferredDate null when basename does not start with YYYY-MM-DD', () => {
    const path = makeTranscript('random-basename.txt', 'a'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000 });
    expect(t!.inferredDate).toBeNull();
  });
});

describe('self-consumption guard (v0.23.2 marker-based)', () => {
  test('REGRESSION: catches actual reverseWriteSlugs output from a real Page', () => {
    // Build a Page like the synthesize subagent would produce, run it through
    // the same renderPageToMarkdown the orchestrator uses, and assert the guard
    // fires. Codex finding #5: synthetic-string fixtures don't prove the guard
    // catches what the synthesize phase actually produces.
    const page = {
      slug: 'wiki/personal/reflections/2026-04-30-test-abc123',
      type: 'reflection' as const,
      title: 'Test reflection',
      compiled_truth: 'I learned something about [Alice](people/alice). No own-slug citation in body.',
      timeline: '',
      frontmatter: {},
    };
    const md = renderPageToMarkdown(page as any, ['dream-cycle']);
    const path = makeTranscript('2026-04-30-output.txt', md + '\n' + 'x'.repeat(3000));
    const result = readSingleTranscript(path, { minChars: 100 });
    expect(result).toBeNull();
  });

  test('does NOT fire on real conversation transcript citing a brain slug', () => {
    // The exact false-positive case codex finding #1 named: a user note that
    // legitimately mentions a reflection slug in plain text. Must NOT be skipped.
    const path = makeTranscript('convo.txt',
      'User: tell me about wiki/personal/reflections/identity-foo and how it relates to my work.\n' +
      'Agent: ' + 'x'.repeat(3000));
    const result = readSingleTranscript(path, { minChars: 100 });
    expect(result).not.toBeNull();
  });

  test('CRLF + BOM frontmatter still triggers guard', () => {
    const content = '\uFEFF---\r\ndream_generated: true\r\n---\r\n# x\r\n' + 'x'.repeat(3000);
    const path = makeTranscript('crlf.txt', content);
    const result = readSingleTranscript(path, { minChars: 100 });
    expect(result).toBeNull();
  });

  test('whitespace and case tolerance: matches dream_generated: true variants', () => {
    const variants = [
      '---\ndream_generated:true\n---\nbody' + 'x'.repeat(3000),
      '---\ndream_generated:  true\n---\nbody' + 'x'.repeat(3000),
      '---\ndream_generated: TRUE\n---\nbody' + 'x'.repeat(3000),
      '---\ntitle: foo\ndream_generated: true\n---\nbody' + 'x'.repeat(3000),
    ];
    for (const variant of variants) {
      expect(isDreamOutput(variant)).toBe(true);
    }
  });

  test('does NOT fire when dream_generated is false or absent', () => {
    expect(isDreamOutput('---\ntitle: foo\n---\nbody')).toBe(false);
    expect(isDreamOutput('---\ndream_generated: false\n---\nbody')).toBe(false);
    expect(isDreamOutput('plain text with no frontmatter')).toBe(false);
    // dream_generatedfoo: true (no word boundary on the key) must NOT match
    expect(isDreamOutput('---\ndream_generatedfoo: true\n---\nbody')).toBe(false);
  });

  test('marker buried past 2000 chars does NOT trigger guard (perf bound)', () => {
    const padding = 'x'.repeat(2100);
    const content = '---\ntitle: real\n---\n' + padding + '\ndream_generated: true\n' + 'x'.repeat(3000);
    const path = makeTranscript('buried.txt', content);
    const result = readSingleTranscript(path, { minChars: 100 });
    expect(result).not.toBeNull();
  });

  test('bypassGuard=true overrides marker (--unsafe-bypass-dream-guard plumbing)', () => {
    const md = '---\ndream_generated: true\n---\n# Page\n' + 'x'.repeat(3000);
    const path = makeTranscript('marked.txt', md);
    expect(readSingleTranscript(path, { minChars: 100 })).toBeNull();
    expect(readSingleTranscript(path, { minChars: 100, bypassGuard: true })).not.toBeNull();
  });

  test('discoverTranscripts respects bypassGuard', () => {
    const md = '---\ndream_generated: true\n---\n# Page\n' + 'x'.repeat(3000);
    makeTranscript('2026-04-30-output.txt', md);
    makeTranscript('2026-04-30-real.txt', 'real transcript ' + 'x'.repeat(3000));

    const guarded = discoverTranscripts({ corpusDir: tmpDir, minChars: 100 });
    expect(guarded).toHaveLength(1);
    expect(guarded[0].basename).toBe('2026-04-30-real');

    const bypassed = discoverTranscripts({ corpusDir: tmpDir, minChars: 100, bypassGuard: true });
    expect(bypassed).toHaveLength(2);
  });

  test('DREAM_OUTPUT_MARKER_RE is anchored at file start (not mid-content)', () => {
    // Frontmatter delimiter must be at byte 0; mid-content `---\n` does not count.
    const content = 'preamble\n---\ndream_generated: true\n---\nbody' + 'x'.repeat(3000);
    expect(DREAM_OUTPUT_MARKER_RE.test(content)).toBe(false);
  });
});

describe('judgeSignificance', () => {
  function makeTranscript(): import('../src/core/cycle/transcript-discovery.ts').DiscoveredTranscript {
    return {
      filePath: '/tmp/x.txt',
      contentHash: 'abc123',
      content: 'A short conversation about something interesting.',
      basename: 'x',
      inferredDate: null,
    };
  }

  function mockClient(captured: { model?: string }): JudgeClient {
    return {
      create: async (p: any) => {
        captured.model = p.model;
        return { content: [{ type: 'text', text: '{"worth_processing": true, "reasons": ["test"]}' }] } as any;
      },
    };
  }

  test('passes verdict_model override to client.create', async () => {
    const captured: { model?: string } = {};
    await judgeSignificance(mockClient(captured), makeTranscript(), 'claude-sonnet-4-6');
    expect(captured.model).toBe('claude-sonnet-4-6');
  });

  test('defaults to claude-haiku-4-5-20251001 when model omitted', async () => {
    const captured: { model?: string } = {};
    await judgeSignificance(mockClient(captured), makeTranscript());
    expect(captured.model).toBe('claude-haiku-4-5-20251001');
  });

  test('returns worth_processing=false when judge returns unparseable text', async () => {
    const client: JudgeClient = {
      create: async () => ({ content: [{ type: 'text', text: 'no json here' }] } as any),
    };
    const r = await judgeSignificance(client, makeTranscript());
    expect(r.worth_processing).toBe(false);
    expect(r.reasons[0]).toContain('unparseable');
  });
});
