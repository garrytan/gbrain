import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from '../helpers/with-env.ts';
import {
  logContentSanityAssessment,
  readRecentContentSanityEvents,
  summarizeContentSanityEvents,
  computeContentSanityAuditFilename,
  type ContentSanityAuditEvent,
} from '../../src/core/audit/content-sanity-audit.ts';
import type { ContentSanityResult } from '../../src/core/content-sanity.ts';

function makeResult(opts: {
  bytes?: number;
  hard?: boolean;
  soft?: boolean;
  warn?: boolean;
  pattern?: string;
  literal?: string;
}): ContentSanityResult {
  const junk_pattern_matches: string[] = opts.pattern ? [opts.pattern] : [];
  const literal_substring_matches: string[] = opts.literal ? [opts.literal] : [];
  const reasons: ContentSanityResult['reasons'] = [];
  const reason_messages: string[] = [];
  if (opts.soft) {
    reasons.push('oversize_block');
    reason_messages.push('PAGE_OVERSIZED: body 600000 bytes');
  } else if (opts.warn) {
    reasons.push('oversize_warn');
    reason_messages.push('PAGE_OVERSIZE_WARN: body 100000 bytes');
  }
  if (junk_pattern_matches.length > 0) {
    reasons.push('junk_pattern');
    reason_messages.push(`PAGE_JUNK_PATTERN: matched ${junk_pattern_matches.join(', ')}`);
  }
  if (literal_substring_matches.length > 0) {
    reasons.push('literal_substring');
    reason_messages.push(`PAGE_JUNK_PATTERN: literal ${literal_substring_matches.join(', ')}`);
  }
  const shouldQuarantine = !!opts.hard || junk_pattern_matches.length > 0 || literal_substring_matches.length > 0;
  const shouldSkipEmbed = !!opts.soft && !shouldQuarantine;
  return {
    bytes: opts.bytes ?? 1000,
    oversize: !!opts.soft,
    junk_pattern_matches,
    literal_substring_matches,
    prose_chars: null,
    markup_ratio: null,
    reasons,
    reason_messages,
    shouldQuarantine,
    shouldHardBlock: shouldQuarantine,
    shouldFlag: shouldSkipEmbed,
    flag_reason: shouldSkipEmbed ? 'oversized' : null,
    shouldSkipEmbed,
  };
}

describe('computeContentSanityAuditFilename', () => {
  test('emits the ISO-week prefix shape', () => {
    const name = computeContentSanityAuditFilename(new Date('2026-05-24T07:00:00Z'));
    expect(name).toMatch(/^content-sanity-\d{4}-W\d{2}\.jsonl$/);
  });
});

describe('logContentSanityAssessment (E2E via tempdir)', () => {
  test('writes hard-block event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-hard-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const result = makeResult({ hard: true, pattern: 'cloudflare_attention_required', bytes: 287 });
        logContentSanityAssessment('media/articles/foo', 'straylight-brain', result);
        const events = readRecentContentSanityEvents(7);
        expect(events.length).toBe(1);
        expect(events[0].event_type).toBe('hard_block');
        expect(events[0].slug).toBe('media/articles/foo');
        expect(events[0].source_id).toBe('straylight-brain');
        expect(events[0].junk_pattern_matches).toContain('cloudflare_attention_required');
        expect(events[0].bytes).toBe(287);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes soft-block event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-soft-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const result = makeResult({ soft: true, bytes: 890_000 });
        logContentSanityAssessment('media/big-transcript', 'default', result);
        const events = readRecentContentSanityEvents(7);
        expect(events.length).toBe(1);
        expect(events[0].event_type).toBe('soft_block');
        expect(events[0].bytes).toBe(890_000);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes warn event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-warn-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const result = makeResult({ warn: true, bytes: 100_000 });
        logContentSanityAssessment('notes/long', 'default', result);
        const events = readRecentContentSanityEvents(7);
        expect(events.length).toBe(1);
        expect(events[0].event_type).toBe('warn');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips no-op rows (no reasons + no bypass)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-noop-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const result = makeResult({}); // no reasons fire
        logContentSanityAssessment('normal-page', 'default', result);
        const events = readRecentContentSanityEvents(7);
        expect(events.length).toBe(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bypass active overrides hard/soft → records as warn with bypass_active flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-bypass-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const result = makeResult({ hard: true, pattern: 'access_denied' });
        logContentSanityAssessment('bypassed', 'default', result, { bypass: true });
        const events = readRecentContentSanityEvents(7);
        expect(events.length).toBe(1);
        expect(events[0].event_type).toBe('warn');
        expect(events[0].bypass_active).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multiple events accumulate in one file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-multi-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        logContentSanityAssessment('a', 'src', makeResult({ hard: true, pattern: 'access_denied' }));
        logContentSanityAssessment('b', 'src', makeResult({ soft: true, bytes: 600000 }));
        logContentSanityAssessment('c', 'src', makeResult({ warn: true, bytes: 70000 }));
        const events = readRecentContentSanityEvents(7);
        expect(events.length).toBe(3);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summarizeContentSanityEvents', () => {
  function event(over: Partial<ContentSanityAuditEvent>): ContentSanityAuditEvent {
    return {
      ts: new Date().toISOString(),
      event_type: 'hard_block',
      slug: 'test',
      source_id: 'default',
      bytes: 100,
      junk_pattern_matches: [],
      literal_substring_matches: [],
      reason_messages: [],
      ...over,
    };
  }
  test('empty input returns zero summary', () => {
    const s = summarizeContentSanityEvents([]);
    expect(s.total_events).toBe(0);
    expect(s.by_type).toEqual({ hard_block: 0, quarantine: 0, reject: 0, flag: 0, soft_block: 0, warn: 0 });
    expect(s.top_patterns).toEqual([]);
  });

  test('counts by type (v0.42 quarantine/reject/flag)', () => {
    const s = summarizeContentSanityEvents([
      event({ event_type: 'quarantine' }),
      event({ event_type: 'quarantine' }),
      event({ event_type: 'reject' }),
      event({ event_type: 'flag' }),
      event({ event_type: 'soft_block' }),
      event({ event_type: 'warn' }),
    ]);
    expect(s.by_type).toEqual({ hard_block: 0, quarantine: 2, reject: 1, flag: 1, soft_block: 1, warn: 1 });
    expect(s.total_events).toBe(6);
  });

  test('counts by source', () => {
    const s = summarizeContentSanityEvents([
      event({ source_id: 'straylight-brain' }),
      event({ source_id: 'straylight-brain' }),
      event({ source_id: 'default' }),
    ]);
    expect(s.by_source['straylight-brain']).toBe(2);
    expect(s.by_source['default']).toBe(1);
  });

  test('top_patterns sorted desc by count', () => {
    const s = summarizeContentSanityEvents([
      event({ junk_pattern_matches: ['cloudflare_attention_required'] }),
      event({ junk_pattern_matches: ['cloudflare_attention_required'] }),
      event({ junk_pattern_matches: ['cloudflare_attention_required'] }),
      event({ junk_pattern_matches: ['access_denied'] }),
    ]);
    expect(s.top_patterns[0]).toEqual({ name: 'cloudflare_attention_required', count: 3 });
    expect(s.top_patterns[1]).toEqual({ name: 'access_denied', count: 1 });
  });

  test('literal substring hits count alongside pattern hits', () => {
    const s = summarizeContentSanityEvents([
      event({ literal_substring_matches: ['reddit_blocked', 'linkedin_wall'] }),
      event({ literal_substring_matches: ['reddit_blocked'] }),
    ]);
    expect(s.top_patterns).toContainEqual({ name: 'reddit_blocked', count: 2 });
    expect(s.top_patterns).toContainEqual({ name: 'linkedin_wall', count: 1 });
  });
});

describe('summarizeContentSanityEvents — chronic vs new signatures (#1893)', () => {
  function event(over: Partial<ContentSanityAuditEvent>): ContentSanityAuditEvent {
    return {
      ts: '2026-07-17T10:00:00.000Z',
      event_type: 'warn',
      slug: 'test',
      source_id: 'default',
      bytes: 100_000,
      junk_pattern_matches: [],
      literal_substring_matches: [],
      reason_messages: ['PAGE_OVERSIZE_WARN: body 100000 bytes exceeds 50000 byte warn threshold'],
      ...over,
    };
  }
  const onDay = (day: string, over: Partial<ContentSanityAuditEvent> = {}) =>
    event({ ts: `${day}T10:00:00.000Z`, ...over });

  test('same page+reason across >=3 distinct days is chronic', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-14', { slug: 'transcript-a' }),
      onDay('2026-07-15', { slug: 'transcript-a' }),
      onDay('2026-07-16', { slug: 'transcript-a' }),
    ]);
    expect(s.distinct_pages).toBe(1);
    expect(s.chronic_pages).toBe(1);
    expect(s.new_pages).toBe(0);
    expect(s.new_warn_pages).toBe(0);
    expect(s.top_chronic).toEqual([
      { slug: 'transcript-a', source_id: 'default', events: 3, days: 3 },
    ]);
  });

  test('2 distinct days stays new; same-day retries never go chronic', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-15', { slug: 'two-days' }),
      onDay('2026-07-16', { slug: 'two-days' }),
      // 5 retries in one day — high raw event count, still new
      ...Array.from({ length: 5 }, (_, i) =>
        event({ slug: 'same-day', ts: `2026-07-16T0${i}:00:00.000Z` })),
    ]);
    expect(s.chronic_pages).toBe(0);
    expect(s.new_pages).toBe(2);
    expect(s.new_warn_pages).toBe(2);
    expect(s.top_chronic).toEqual([]);
  });

  test('malformed ts never counts toward chronicity (fail-safe: new)', () => {
    const s = summarizeContentSanityEvents([
      event({ slug: 'bad-ts', ts: 'not-a-date' }),
      event({ slug: 'bad-ts', ts: '' }),
      event({ slug: 'bad-ts', ts: undefined as unknown as string }),
      onDay('2026-07-16', { slug: 'bad-ts' }),
      onDay('2026-07-17', { slug: 'bad-ts' }),
    ]);
    expect(s.chronic_pages).toBe(0);
    expect(s.new_warn_pages).toBe(1);
  });

  test('event_type is part of the signature: chronic warn escalating to first soft_block counts as new soft page', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-14', { slug: 'escalating' }),
      onDay('2026-07-15', { slug: 'escalating' }),
      onDay('2026-07-16', { slug: 'escalating' }),
      onDay('2026-07-17', { slug: 'escalating', event_type: 'soft_block' }),
    ]);
    expect(s.chronic_pages).toBe(1); // the chronic warn signature
    expect(s.new_soft_pages).toBe(1); // the fresh escalation still surfaces
  });

  test('reason_key uses sorted-unique pattern names so array order cannot split a signature', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-14', { slug: 'p', event_type: 'quarantine', junk_pattern_matches: ['a', 'b'] }),
      onDay('2026-07-15', { slug: 'p', event_type: 'quarantine', junk_pattern_matches: ['b', 'a'] }),
      onDay('2026-07-16', { slug: 'p', event_type: 'quarantine', junk_pattern_matches: ['b', 'a', 'a'] }),
    ]);
    expect(s.chronic_pages).toBe(1);
  });

  test('a literal containing a comma cannot collide with a multi-name set (signature stays distinct)', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-14', { slug: 'p', event_type: 'quarantine', literal_substring_matches: ['a,b'] }),
      onDay('2026-07-15', { slug: 'p', event_type: 'quarantine', literal_substring_matches: ['a', 'b'] }),
      onDay('2026-07-16', { slug: 'p', event_type: 'quarantine', literal_substring_matches: ['a,b'] }),
    ]);
    // two distinct signatures: neither reaches 3 distinct days
    expect(s.chronic_pages).toBe(0);
  });

  test('offset timestamps normalize to UTC days (no fabricated chronicity)', () => {
    const s = summarizeContentSanityEvents([
      // all three are the same UTC day (2026-07-16) despite different offsets
      event({ slug: 'tz', ts: '2026-07-16T01:00:00.000Z' }),
      event({ slug: 'tz', ts: '2026-07-15T23:00:00-05:00' }),
      event({ slug: 'tz', ts: '2026-07-17T03:00:00+09:00' }),
    ]);
    expect(s.chronic_pages).toBe(0);
    // invalid calendar dates never count toward chronicity
    const s2 = summarizeContentSanityEvents([
      event({ slug: 'bad', ts: '2026-13-99T10:00:00.000Z' }),
      event({ slug: 'bad', ts: '2026-14-99T10:00:00.000Z' }),
      event({ slug: 'bad', ts: '2026-15-99T10:00:00.000Z' }),
    ]);
    expect(s2.chronic_pages).toBe(0);
  });

  test('pages on different sources are distinct', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-16', { slug: 'same-slug', source_id: 'src-a' }),
      onDay('2026-07-16', { slug: 'same-slug', source_id: 'src-b' }),
    ]);
    expect(s.distinct_pages).toBe(2);
    expect(s.new_warn_pages).toBe(2);
  });

  test('bypass events are counted for message visibility', () => {
    const s = summarizeContentSanityEvents([
      onDay('2026-07-16', { slug: 'x', bypass_active: true }),
      onDay('2026-07-16', { slug: 'y' }),
    ]);
    expect(s.bypass_events).toBe(1);
  });

  test('top_chronic sorted by event count desc, capped at 3', () => {
    const chronicFor = (slug: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        onDay(`2026-07-${String(10 + (i % 5)).padStart(2, '0')}`, { slug }));
    const s = summarizeContentSanityEvents([
      ...chronicFor('third', 3),
      ...chronicFor('first', 5),
      ...chronicFor('second', 4),
      ...chronicFor('fourth-dropped', 3),
    ]);
    expect(s.top_chronic.length).toBe(3);
    expect(s.top_chronic[0].slug).toBe('first');
    expect(s.top_chronic[1].slug).toBe('second');
  });
});
