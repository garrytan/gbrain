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

  test('skips non-txt non-md files', () => {
    // v0.30.3 (#708): .md files are now supported alongside .txt; only other
    // extensions (e.g., .pdf, .doc) should be skipped by discovery.
    makeTranscript('2026-04-25-foo.pdf', 'a'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toEqual([]);
  });

  test('discovers .md transcript files (#708)', () => {
    makeTranscript('2026-04-25-foo.md', 'a'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-foo');
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

// ─── v0.41.13: UTF-16 safety in judgeSignificance ─────────────────────
//
// Reproduces the 2026-05-24 production SYNTH_PHASE_FAIL: `🤖` (U+1F916,
// encoded as surrogate pair U+D83E U+DD16) at offset 3999 in a long
// telegram transcript made the 4000-char slice produce a lone high
// surrogate. Anthropic's JSON parser rejected the payload with "no low
// surrogate in string". Fix routes both head + tail slices through the
// canonical safeSplitIndex helper from text-safe.ts.
//
// Primary assertion: scan the captured prompt for unpaired surrogates.
// (NOT JSON.stringify, which doesn't throw on lone surrogates in V8/
// JSCore — codex C-11.)

describe('judgeSignificance — UTF-16 safety (v0.41.13)', () => {
  const HIGH = '\uD83E'; // high surrogate of 🤖
  const LOW = '\uDD16';  // low surrogate of 🤖
  const ROBOT = HIGH + LOW; // U+1F916, 🤖, two UTF-16 code units

  function isHighSurrogate(c: number): boolean { return c >= 0xD800 && c <= 0xDBFF; }
  function isLowSurrogate(c: number): boolean { return c >= 0xDC00 && c <= 0xDFFF; }

  /**
   * Build content of exactly `length` chars with `🤖` placed so that
   * the high surrogate sits at `emojiHighOffset`. The pair occupies
   * positions [emojiHighOffset, emojiHighOffset+1]. Filler is plain
   * ASCII so surrogate-scanning has no other true positives.
   */
  function buildContentWithEmojiAt(length: number, emojiHighOffset: number): string {
    if (emojiHighOffset < 0 || emojiHighOffset > length - 2) {
      throw new Error(`emojiHighOffset ${emojiHighOffset} out of range for length ${length}`);
    }
    const head = 'a'.repeat(emojiHighOffset);
    const tail = 'b'.repeat(length - emojiHighOffset - 2);
    return head + ROBOT + tail;
  }

  /** Stub client that captures the user-message string for inspection. */
  function makeCapturingClient(): { client: JudgeClient; captured: { userMessage: string | null } } {
    const captured: { userMessage: string | null } = { userMessage: null };
    const client: JudgeClient = {
      create: async (p: any) => {
        // judgeSignificance posts `Transcript ${basename}:\n\n${trimmed}` as
        // the user message. Capture for post-call scanning.
        const userMsg = p.messages[0]?.content;
        captured.userMessage = typeof userMsg === 'string' ? userMsg : null;
        return { content: [{ type: 'text', text: '{"worth_processing": false, "reasons": ["stub"]}' }] } as any;
      },
    };
    return { client, captured };
  }

  /**
   * Extract the trimmed payload from the captured prompt by stripping
   * the prompt prefix and the `\n[...truncated...]\n` separator. We
   * scan the WHOLE captured message for unpaired surrogates anyway
   * (prompt prefix is pure ASCII), so the extraction is defense-in-
   * depth, not the primary signal.
   */
  function scanForUnpairedSurrogates(s: string): { index: number; kind: 'lone-high' | 'lone-low' } | null {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (isHighSurrogate(c)) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
        if (!isLowSurrogate(next)) return { index: i, kind: 'lone-high' };
      } else if (isLowSurrogate(c)) {
        const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
        if (!isHighSurrogate(prev)) return { index: i, kind: 'lone-low' };
      }
    }
    return null;
  }

  function makeLongTranscript(content: string): import('../src/core/cycle/transcript-discovery.ts').DiscoveredTranscript {
    return {
      filePath: '/tmp/long.txt',
      contentHash: 'utf16-test',
      content,
      basename: 'long',
      inferredDate: null,
    };
  }

  // ─── Head-boundary cases (offset around 4000) ──────────────────────

  test.each([3998, 3999, 4000, 4001])(
    'emoji at head offset %i: captured prompt has zero unpaired surrogates',
    async (offset) => {
      const content = buildContentWithEmojiAt(8001, offset);
      const { client, captured } = makeCapturingClient();
      await judgeSignificance(client, makeLongTranscript(content));
      expect(captured.userMessage).not.toBeNull();
      const result = scanForUnpairedSurrogates(captured.userMessage!);
      expect(result).toBeNull();
    },
  );

  // ─── Tail-boundary cases (offset around length-4000 = 4001) ────────

  test.each([3999, 4000, 4001, 4002])(
    'emoji at tail offset %i: captured prompt has zero unpaired surrogates',
    async (offset) => {
      // 8001 - 4000 = 4001 is the tail boundary; we test around it.
      const content = buildContentWithEmojiAt(8001, offset);
      const { client, captured } = makeCapturingClient();
      await judgeSignificance(client, makeLongTranscript(content));
      expect(captured.userMessage).not.toBeNull();
      const result = scanForUnpairedSurrogates(captured.userMessage!);
      expect(result).toBeNull();
    },
  );

  // ─── Sub-8000 short-content branch: no slicing, no risk ────────────

  test('content <= 8000 chars: no slicing applied, emoji passes through unchanged', async () => {
    const content = 'a'.repeat(100) + ROBOT + 'b'.repeat(100); // 202 chars total
    const { client, captured } = makeCapturingClient();
    await judgeSignificance(client, makeLongTranscript(content));
    expect(captured.userMessage).not.toBeNull();
    expect(scanForUnpairedSurrogates(captured.userMessage!)).toBeNull();
    // Emoji's full pair must appear at least once.
    expect(captured.userMessage!).toContain(ROBOT);
  });
});
