import { describe, test, expect } from 'bun:test';
import {
  assessContentSanity,
  ContentSanityBlockError,
  BUILT_IN_JUNK_PATTERNS,
  PAGE_JUNK_PATTERN_CODE,
  DEFAULT_BYTES_WARN,
  DEFAULT_BYTES_BLOCK,
  type OperatorLiteral,
} from '../src/core/content-sanity.ts';

// ─── BOUNDARIES ───────────────────────────────────────────────

describe('assessContentSanity — size boundaries', () => {
  test('empty body returns 0 bytes and no trips', () => {
    const r = assessContentSanity({ compiled_truth: '', timeline: '', title: '' });
    expect(r.bytes).toBe(0);
    expect(r.oversize).toBe(false);
    expect(r.shouldHardBlock).toBe(false);
    expect(r.shouldSkipEmbed).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test('bytes counts compiled_truth + timeline (Codex r2 #7)', () => {
    // Without timeline a check might miss huge timeline sections; the
    // assessor must sum both. Use ASCII for byteLength === length.
    const ct = 'a'.repeat(1000);
    const tl = 'b'.repeat(2000);
    const r = assessContentSanity({ compiled_truth: ct, timeline: tl, title: '' });
    expect(r.bytes).toBeGreaterThanOrEqual(3000); // + the join '\n'
    expect(r.bytes).toBeLessThan(3010);
  });

  test('bytes uses UTF-8 octets, not character count', () => {
    // CJK chars: each takes 3 UTF-8 bytes. 100 chars → 300 bytes.
    const ct = '世'.repeat(100);
    const r = assessContentSanity({ compiled_truth: ct, timeline: '', title: '' });
    expect(r.bytes).toBe(300);
  });

  test('exactly at warn threshold does NOT fire warn (strict >)', () => {
    const r = assessContentSanity({
      compiled_truth: 'a'.repeat(50_000),
      timeline: '',
      title: '',
      bytes_warn: 50_000,
      bytes_block: 500_000,
    });
    expect(r.reasons).not.toContain('oversize_warn');
    expect(r.reasons).not.toContain('oversize_block');
  });

  test('above warn but below block → oversize_warn only', () => {
    const r = assessContentSanity({
      compiled_truth: 'a'.repeat(100_000),
      timeline: '',
      title: '',
    });
    expect(r.reasons).toContain('oversize_warn');
    expect(r.reasons).not.toContain('oversize_block');
    expect(r.shouldHardBlock).toBe(false);
    expect(r.shouldSkipEmbed).toBe(false);
  });

  test('above block threshold → oversize_block + shouldSkipEmbed', () => {
    const r = assessContentSanity({
      compiled_truth: 'a'.repeat(600_000),
      timeline: '',
      title: '',
    });
    expect(r.oversize).toBe(true);
    expect(r.reasons).toContain('oversize_block');
    expect(r.reasons).not.toContain('oversize_warn'); // not double-pushed
    expect(r.shouldSkipEmbed).toBe(true);
    expect(r.shouldHardBlock).toBe(false);
  });

  test('the original 890K reproduction trips block alone (no junk)', () => {
    // 890K of clean text (no Cloudflare phrases) → soft-block only.
    const r = assessContentSanity({
      compiled_truth: 'normal prose. '.repeat(70_000), // ~890K bytes
      timeline: '',
      title: 'A Long Article',
    });
    expect(r.shouldSkipEmbed).toBe(true);
    expect(r.shouldHardBlock).toBe(false);
  });

  test('custom thresholds override defaults', () => {
    const r = assessContentSanity({
      compiled_truth: 'a'.repeat(150),
      timeline: '',
      title: '',
      bytes_warn: 100,
      bytes_block: 200,
    });
    expect(r.reasons).toContain('oversize_warn');
  });

  test('defaults are exported and reasonable', () => {
    expect(DEFAULT_BYTES_WARN).toBe(50_000);
    expect(DEFAULT_BYTES_BLOCK).toBe(500_000);
  });
});

// ─── 6 BUILT-IN PATTERNS ──────────────────────────────────────

describe('assessContentSanity — built-in junk patterns', () => {
  test('built-in pattern count is locked at 6 (D3 dropped empty_body_with_source_url)', () => {
    expect(BUILT_IN_JUNK_PATTERNS.length).toBe(6);
    const names = BUILT_IN_JUNK_PATTERNS.map((p) => p.name);
    expect(names).toContain('cloudflare_attention_required');
    expect(names).toContain('cloudflare_just_a_moment');
    expect(names).toContain('cloudflare_ray_id');
    expect(names).toContain('access_denied');
    expect(names).toContain('captcha_required');
    expect(names).toContain('error_page_title');
    // D3 regression: this rule was dropped. If it ever returns, the test
    // count above bumps to 7 deliberately.
    expect(names).not.toContain('empty_body_with_source_url');
  });

  test('built-in patterns all compile (module-load safety net)', () => {
    for (const p of BUILT_IN_JUNK_PATTERNS) {
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(() => p.pattern.test('test input')).not.toThrow();
    }
  });

  test('cloudflare_attention_required fires on real-world title', () => {
    const r = assessContentSanity({
      compiled_truth: '',
      timeline: '',
      title: 'Attention Required! | Cloudflare',
    });
    expect(r.junk_pattern_matches).toContain('cloudflare_attention_required');
    expect(r.shouldHardBlock).toBe(true);
  });

  test('cloudflare_just_a_moment requires BOTH signals (no false-positive on prose)', () => {
    // Just the words "Just a moment..." alone does NOT fire (legitimate
    // writing might include it).
    const r1 = assessContentSanity({
      compiled_truth: 'Just a moment... I want to finish this thought before moving on.',
      timeline: '',
      title: '',
    });
    expect(r1.junk_pattern_matches).not.toContain('cloudflare_just_a_moment');

    // With the cdn-cgi discriminator nearby → fires.
    const r2 = assessContentSanity({
      compiled_truth: 'Just a moment... please wait while we verify\ncdn-cgi/challenge-platform/h/blah',
      timeline: '',
      title: '',
    });
    expect(r2.junk_pattern_matches).toContain('cloudflare_just_a_moment');
  });

  test('cloudflare_ray_id fires on trailing diagnostic', () => {
    const r = assessContentSanity({
      compiled_truth: 'You have been blocked.\n\nCloudflare Ray ID: abc12345',
      timeline: '',
      title: 'Blocked',
    });
    expect(r.junk_pattern_matches).toContain('cloudflare_ray_id');
  });

  test('access_denied fires on bare 403 dumps', () => {
    const r = assessContentSanity({
      compiled_truth: 'Access denied\n\nYou do not have permission to view this resource.',
      timeline: '',
      title: '',
    });
    expect(r.junk_pattern_matches).toContain('access_denied');
  });

  test('captcha_required catches multiple verification phrasings', () => {
    for (const phrase of ['verify you are human', 'verify you are a human', 'captcha required', 'please complete the security check']) {
      const r = assessContentSanity({
        compiled_truth: `Please ${phrase} to continue.`,
        timeline: '',
        title: '',
      });
      expect(r.junk_pattern_matches).toContain('captcha_required');
    }
  });

  test('error_page_title fires only on bare titles (anchored)', () => {
    for (const title of ['404', 'Error 500', 'Page Not Found', '503']) {
      const r = assessContentSanity({ compiled_truth: '', timeline: '', title });
      expect(r.junk_pattern_matches).toContain('error_page_title');
    }
    // A thoughtful page ABOUT errors does NOT fire.
    const r2 = assessContentSanity({
      compiled_truth: '',
      timeline: '',
      title: 'Designing for 404 pages: a UX guide',
    });
    expect(r2.junk_pattern_matches).not.toContain('error_page_title');
  });

  test('multiple patterns can fire on the same content', () => {
    const r = assessContentSanity({
      compiled_truth: 'Cloudflare Ray ID: xyz789',
      timeline: '',
      title: 'Attention Required! | Cloudflare',
    });
    expect(r.junk_pattern_matches).toContain('cloudflare_attention_required');
    expect(r.junk_pattern_matches).toContain('cloudflare_ray_id');
    expect(r.shouldHardBlock).toBe(true);
  });

  test('case-insensitive matching across all patterns', () => {
    const r = assessContentSanity({
      compiled_truth: '',
      timeline: '',
      title: 'ATTENTION REQUIRED! | CLOUDFLARE',
    });
    expect(r.junk_pattern_matches).toContain('cloudflare_attention_required');
  });
});

// ─── REASON ORDERING + MESSAGES ────────────────────────────────

describe('assessContentSanity — reason ordering', () => {
  test('reason_messages embed the classifier-readable PAGE_JUNK_PATTERN prefix', () => {
    const r = assessContentSanity({
      compiled_truth: '',
      timeline: '',
      title: 'Access denied',
    });
    expect(r.shouldHardBlock).toBe(true);
    const joined = r.reason_messages.join(' ');
    expect(joined).toContain(PAGE_JUNK_PATTERN_CODE);
    expect(PAGE_JUNK_PATTERN_CODE).toBe('PAGE_JUNK_PATTERN');
  });

  test('block-level oversize message includes PAGE_OVERSIZED prefix', () => {
    const r = assessContentSanity({
      compiled_truth: 'a'.repeat(600_000),
      timeline: '',
      title: '',
    });
    const joined = r.reason_messages.join(' ');
    expect(joined).toContain('PAGE_OVERSIZED:');
  });

  test('hard-block + oversize: BOTH reasons present (operator sees both causes)', () => {
    // Pattern in first 2KB head-slice so junk_pattern fires alongside
    // oversize_block. This is the realistic 890K Cloudflare dump shape:
    // the "Attention Required" banner is at the top, then the rest of
    // the page is HTML/styles/etc making it huge.
    const r = assessContentSanity({
      compiled_truth: 'Cloudflare Ray ID: abc\n' + 'a'.repeat(600_000),
      timeline: '',
      title: '',
    });
    expect(r.reasons).toContain('oversize_block');
    expect(r.reasons).toContain('junk_pattern');
    expect(r.shouldHardBlock).toBe(true);
    // hard-block wins; soft-block doesn't ALSO fire.
    expect(r.shouldSkipEmbed).toBe(false);
  });
});

// ─── OPERATOR LITERALS ────────────────────────────────────────

describe('assessContentSanity — operator literals', () => {
  test('empty extra_literals = built-ins only', () => {
    const r = assessContentSanity({
      compiled_truth: "You're being blocked from accessing this resource",
      timeline: '',
      title: '',
      extra_literals: [],
    });
    expect(r.shouldHardBlock).toBe(false);
    expect(r.literal_substring_matches).toEqual([]);
  });

  test('operator literal matches case-insensitively', () => {
    const literals: OperatorLiteral[] = [
      { name: 'reddit_blocked', substring: "you're being blocked from accessing" },
    ];
    const r = assessContentSanity({
      compiled_truth: "YOU'RE BEING BLOCKED FROM ACCESSING this site.",
      timeline: '',
      title: '',
      extra_literals: literals,
    });
    expect(r.literal_substring_matches).toContain('reddit_blocked');
    expect(r.shouldHardBlock).toBe(true);
  });

  test('regex meta-characters in operator literal stay literal (no ReDoS surface)', () => {
    const literals: OperatorLiteral[] = [
      { name: 'meta_test', substring: '(a+)+b' }, // would be catastrophic as regex
    ];
    // Should NOT match prose
    const r1 = assessContentSanity({
      compiled_truth: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      timeline: '',
      title: '',
      extra_literals: literals,
    });
    expect(r1.literal_substring_matches).not.toContain('meta_test');
    // SHOULD match the literal string
    const r2 = assessContentSanity({
      compiled_truth: 'The pattern (a+)+b is bad regex.',
      timeline: '',
      title: '',
      extra_literals: literals,
    });
    expect(r2.literal_substring_matches).toContain('meta_test');
  });

  test('literal applies_to scope honored', () => {
    const titleOnly: OperatorLiteral = { name: 't', substring: 'wall', applies_to: 'title' };
    const bodyOnly: OperatorLiteral = { name: 'b', substring: 'wall', applies_to: 'body' };
    const r1 = assessContentSanity({
      compiled_truth: 'auth wall content',
      timeline: '',
      title: 'unrelated',
      extra_literals: [titleOnly],
    });
    expect(r1.literal_substring_matches).not.toContain('t');
    const r2 = assessContentSanity({
      compiled_truth: 'unrelated body',
      timeline: '',
      title: 'auth wall',
      extra_literals: [titleOnly],
    });
    expect(r2.literal_substring_matches).toContain('t');
    const r3 = assessContentSanity({
      compiled_truth: 'auth wall content',
      timeline: '',
      title: 'unrelated',
      extra_literals: [bodyOnly],
    });
    expect(r3.literal_substring_matches).toContain('b');
  });

  test('empty substring is no-op', () => {
    const r = assessContentSanity({
      compiled_truth: 'anything',
      timeline: '',
      title: '',
      extra_literals: [{ name: 'empty', substring: '' }],
    });
    expect(r.literal_substring_matches).toEqual([]);
  });
});

// ─── SCAN HEAD-SLICE BOUNDARY ─────────────────────────────────

describe('assessContentSanity — head-slice scope', () => {
  test('pattern in first 2KB matches', () => {
    const r = assessContentSanity({
      compiled_truth: 'Cloudflare Ray ID: aaa\n' + 'x'.repeat(10_000),
      timeline: '',
      title: '',
    });
    expect(r.junk_pattern_matches).toContain('cloudflare_ray_id');
  });

  test('pattern past the 2KB head-slice does NOT match (cost bound)', () => {
    // Cost bound: patterns evaluated against first ~2KB only.
    // Pattern buried at offset 5K should NOT trip.
    const r = assessContentSanity({
      compiled_truth: 'x'.repeat(5000) + 'Cloudflare Ray ID: deep',
      timeline: '',
      title: '',
    });
    expect(r.junk_pattern_matches).not.toContain('cloudflare_ray_id');
  });
});

// ─── ContentSanityBlockError ──────────────────────────────────

describe('ContentSanityBlockError', () => {
  test('error message contains PAGE_JUNK_PATTERN for classifier match', () => {
    const r = assessContentSanity({
      compiled_truth: 'Access denied',
      timeline: '',
      title: '',
    });
    const err = new ContentSanityBlockError(r);
    expect(err.message).toContain('PAGE_JUNK_PATTERN');
    expect(err.code).toBe('PAGE_JUNK_PATTERN');
    expect(err.name).toBe('ContentSanityBlockError');
  });

  test('error retains the full result for caller inspection', () => {
    const r = assessContentSanity({
      compiled_truth: 'Access denied',
      timeline: '',
      title: 'Attention Required! | Cloudflare',
    });
    const err = new ContentSanityBlockError(r);
    expect(err.result.junk_pattern_matches.length).toBeGreaterThan(0);
    expect(err.result).toBe(r); // same reference, not a copy
  });

  test('error is throwable + catchable as instanceof', () => {
    const r = assessContentSanity({
      compiled_truth: '',
      timeline: '',
      title: 'Access denied',
    });
    try {
      throw new ContentSanityBlockError(r);
    } catch (e) {
      expect(e).toBeInstanceOf(ContentSanityBlockError);
      expect((e as Error).message).toContain('PAGE_JUNK_PATTERN');
    }
  });
});
