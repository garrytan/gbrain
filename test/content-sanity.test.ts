import { describe, test, expect } from 'bun:test';
import {
  assessContentSanity,
  assessProse,
  ContentSanityBlockError,
  BUILT_IN_JUNK_PATTERNS,
  PAGE_JUNK_PATTERN_CODE,
  DEFAULT_BYTES_WARN,
  DEFAULT_BYTES_BLOCK,
  DEFAULT_MAX_MARKUP_RATIO,
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
  test('built-in pattern count is locked at 10 (v0.42 added 3 interstitial patterns)', () => {
    expect(BUILT_IN_JUNK_PATTERNS.length).toBe(10);
    const names = BUILT_IN_JUNK_PATTERNS.map((p) => p.name);
    expect(names).toContain('cloudflare_attention_required');
    expect(names).toContain('cloudflare_just_a_moment');
    expect(names).toContain('cloudflare_ray_id');
    expect(names).toContain('access_denied');
    expect(names).toContain('captcha_required');
    expect(names).toContain('error_page_title');
    // v0.41.13: distinct name from error_page_title (audit-name distinctness).
    expect(names).toContain('cloudflare_challenge_title');
    // D3 regression: this rule was dropped. If it ever returns, the test
    // count above bumps deliberately.
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

  // ─── v0.41.13: expanded error_page_title + cloudflare_challenge_title ─
  //
  // Supersedes PR #1561. Scraper titles like "Forbidden", "Access Denied",
  // "Service Unavailable", "Robot Check" were slipping through the
  // bare-numeric-codes-only regex; the expanded matcher catches them
  // without false-positiving on longer-form essays about those topics.

  describe('error_page_title — v0.41.13 expanded matches', () => {
    // Phrases that MUST match (exact-title scraper junk).
    test.each([
      'Forbidden',
      'Access Denied',
      'Service Unavailable',
      'Robot Check',
      'Verify You Are Human',
      // Existing matches still work
      '403',
      '404',
      'Error 500',
      'Page Not Found',
      // Anchored with optional trailing whitespace
      'Forbidden ',
      'access denied  ',
      // Case-insensitive
      'forbidden',
      'ROBOT CHECK',
    ])('matches scraper title %j', (title) => {
      const r = assessContentSanity({ compiled_truth: '', timeline: '', title });
      expect(r.junk_pattern_matches).toContain('error_page_title');
      expect(r.shouldHardBlock).toBe(true);
    });

    // Over-match regression guard: these must NOT trip (the gate
    // motivating the PR #1561 review-and-reshape).
    test.each([
      'How to Handle Access Denied Errors',
      'Error Boundary in React',
      'Service Unavailable Pattern',
      'Forbidden Knowledge',
      'Forbidden City', // legitimate place name
      'Designing the Perfect Robot Check', // long-form essay
      'Verify You Are Human (a poem)',
    ])('does NOT match legitimate prose title %j (over-match regression)', (title) => {
      const r = assessContentSanity({ compiled_truth: '', timeline: '', title });
      expect(r.junk_pattern_matches).not.toContain('error_page_title');
    });

    // Bare-`error` matcher was DELIBERATELY dropped from PR #1561's
    // expansion. A page titled just "Error" (e.g. a programming
    // taxonomy node) must NOT be hard-blocked.
    test('bare title "Error" does NOT match (PR #1561 bare-`error` matcher dropped)', () => {
      const r = assessContentSanity({ compiled_truth: '', timeline: '', title: 'Error' });
      expect(r.junk_pattern_matches).not.toContain('error_page_title');
      expect(r.shouldHardBlock).toBe(false);
    });
  });

  describe('cloudflare_challenge_title — v0.41.13 distinct-name pattern', () => {
    test.each([
      'Just a moment...',
      'Just a moment',         // zero dots
      'Just a moment.',        // one dot
      'Just a moment..',       // two dots
      'just a moment...',      // case-insensitive
      'JUST A MOMENT...',
    ])('matches Cloudflare title %j', (title) => {
      const r = assessContentSanity({ compiled_truth: '', timeline: '', title });
      expect(r.junk_pattern_matches).toContain('cloudflare_challenge_title');
      expect(r.shouldHardBlock).toBe(true);
    });

    test('regex is strict-anchored — trailing whitespace does NOT match (no \\s*$ in the new pattern)', () => {
      // Distinct from error_page_title which allows trailing whitespace
      // (\s*$). The Cloudflare title is observed in the wild as exactly
      // "Just a moment...", so we keep strict anchoring to avoid
      // accidentally trapping titles with trailing content.
      const r = assessContentSanity({ compiled_truth: '', timeline: '', title: 'Just a moment...   ' });
      expect(r.junk_pattern_matches).not.toContain('cloudflare_challenge_title');
    });

    test('does NOT match longer prose with "Just a moment..." prefix', () => {
      const r = assessContentSanity({
        compiled_truth: '',
        timeline: '',
        title: 'Just a moment, please — checking with the team',
      });
      expect(r.junk_pattern_matches).not.toContain('cloudflare_challenge_title');
    });

    test('records as cloudflare_challenge_title, NOT error_page_title (audit-name distinctness)', () => {
      const r = assessContentSanity({
        compiled_truth: '',
        timeline: '',
        title: 'Just a moment...',
      });
      expect(r.junk_pattern_matches).toContain('cloudflare_challenge_title');
      expect(r.junk_pattern_matches).not.toContain('error_page_title');
    });

    test('body-scoped cloudflare_just_a_moment is independent (BOTH may fire on same content)', () => {
      // Body needs both phrase + cdn-cgi/challenge-platform URL; title needs
      // exactly "Just a moment[...]". A real Cloudflare interstitial would
      // trip both (different scopes, different names — operator sees both
      // in the audit log).
      const r = assessContentSanity({
        compiled_truth: 'Just a moment... please wait\ncdn-cgi/challenge-platform/h/blah',
        timeline: '',
        title: 'Just a moment...',
      });
      expect(r.junk_pattern_matches).toContain('cloudflare_challenge_title');
      expect(r.junk_pattern_matches).toContain('cloudflare_just_a_moment');
    });
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

// ─── v0.42 (#1699) interstitial patterns ──────────────────────

describe('assessContentSanity — v0.42 interstitial patterns', () => {
  test.each([
    ['Checking your browser before accessing example.com', 'cloudflare_checking_browser'],
    ['cf-browser-verification token here', 'cf_browser_verification'],
    ['Please enable JavaScript and cookies to continue', 'enable_javascript_cookies'],
  ])('body %j → quarantine signal (%s)', (body, pattern) => {
    const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'x' });
    expect(r.junk_pattern_matches).toContain(pattern);
    expect(r.shouldQuarantine).toBe(true);
  });
});

// ─── v0.42 prose / markup heuristic ───────────────────────────

describe('assessProse', () => {
  test('pure prose → low markup ratio', () => {
    const r = assessProse('This is a normal paragraph of writing with several real sentences in it.');
    expect(r.markup_ratio).toBeLessThan(0.3);
    expect(r.prose_chars).toBeGreaterThan(0);
  });
  test('nav/table blob → high markup ratio', () => {
    const nav = '| [a](http://x) | [b](http://y) | [c](http://z) |\n'.repeat(50);
    const r = assessProse(nav);
    expect(r.markup_ratio).toBeGreaterThan(DEFAULT_MAX_MARKUP_RATIO);
  });
  test('code excluded from denominator — code-heavy doc is NOT high markup', () => {
    const codeDoc = 'Here is the function:\n\n```ts\n' + 'const x = compute(a, b, c);\n'.repeat(200) + '```\n\nThat is how it works.';
    const r = assessProse(codeDoc);
    expect(r.markup_ratio).toBeLessThan(DEFAULT_MAX_MARKUP_RATIO);
  });
  test('empty body → zero ratio (no divide-by-zero)', () => {
    const r = assessProse('');
    expect(r.markup_ratio).toBe(0);
    expect(r.total_chars).toBe(0);
  });
});

// ─── v0.42 confidence split + warn-tier gate ──────────────────

describe('assessContentSanity — confidence split (Q1=A)', () => {
  const navLine = '| [a](http://x) | [b](http://y) | [c](http://z) | [d](http://w) |\n';

  test('markup-heavy in warn window → shouldFlag(markup_heavy), NOT shouldQuarantine', () => {
    const body = navLine.repeat(1200); // ~60K, > 50K warn, < 500K block
    const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'nav' });
    expect(r.shouldFlag).toBe(true);
    expect(r.flag_reason).toBe('markup_heavy');
    expect(r.shouldQuarantine).toBe(false);
    expect(r.reasons).toContain('high_markup');
  });

  test('shouldQuarantine is NEVER set by high_markup alone (regression)', () => {
    const body = navLine.repeat(1200);
    const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'nav' });
    // No junk pattern / literal → quarantine must stay false even though markup tripped.
    expect(r.shouldQuarantine).toBe(false);
    expect(r.shouldHardBlock).toBe(false); // alias parity
  });

  test('A1/A2 FP guard: small page below bytes_warn never enters prose pass, never flags', () => {
    // A tiny markup-heavy stub (well under 50K) must NOT be flagged.
    const body = navLine.repeat(5); // ~300 bytes
    const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'stub' });
    expect(r.prose_chars).toBeNull();    // prose pass did not run
    expect(r.markup_ratio).toBeNull();
    expect(r.shouldFlag).toBe(false);
    expect(r.shouldQuarantine).toBe(false);
  });

  test('page_kind=code is exempt from the prose pass', () => {
    const body = navLine.repeat(1200);
    const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'c', page_kind: 'code' });
    expect(r.markup_ratio).toBeNull();
    expect(r.shouldFlag).toBe(false);
  });

  test('prose_check_enabled=false suppresses markup flagging', () => {
    const body = navLine.repeat(1200);
    const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'n', prose_check_enabled: false });
    expect(r.markup_ratio).toBeNull();
    expect(r.shouldFlag).toBe(false);
  });

  test('oversize → shouldSkipEmbed + shouldFlag(oversized), pure-prose 890K stays NOT-quarantined', () => {
    const r = assessContentSanity({ compiled_truth: 'normal prose. '.repeat(70_000), timeline: '', title: 'book' });
    expect(r.oversize).toBe(true);
    expect(r.shouldSkipEmbed).toBe(true);
    expect(r.shouldFlag).toBe(true);
    expect(r.flag_reason).toBe('oversized');
    expect(r.shouldQuarantine).toBe(false);
    // Over block threshold → prose pass skipped (no markup_ratio).
    expect(r.markup_ratio).toBeNull();
  });

  test('junk + oversize → quarantine wins (no flag, no embed_skip)', () => {
    const r = assessContentSanity({
      compiled_truth: 'Cloudflare Ray ID: x\n' + 'a'.repeat(600_000),
      timeline: '',
      title: 't',
    });
    expect(r.shouldQuarantine).toBe(true);
    expect(r.shouldSkipEmbed).toBe(false);
    expect(r.shouldFlag).toBe(false);
  });
});

// issue #1939 — assessContentSanity is a pure exported fn; lint.ts and
// import-file both pass `parsed.title`, which a malformed YAML date/number title
// could make non-string. It must coerce defensively and never throw.
describe('issue #1939 — non-string title defensive coercion', () => {
  const base = { compiled_truth: 'some prose body here', timeline: '' };

  test('Date title does not throw', () => {
    expect(() =>
      assessContentSanity({ ...base, title: new Date('2024-06-01') as unknown as string }),
    ).not.toThrow();
  });

  test('number title does not throw', () => {
    expect(() =>
      assessContentSanity({ ...base, title: 1458 as unknown as string }),
    ).not.toThrow();
  });

  test('null/undefined title does not throw and yields a normal result', () => {
    const r = assessContentSanity({ ...base, title: undefined as unknown as string });
    expect(r).toBeDefined();
    expect(typeof r.shouldQuarantine).toBe('boolean');
  });
});
