import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from '../helpers/with-env.ts';
import {
  acknowledgeContentSanityEvents,
  contentSanityAcknowledgementsPath,
  logContentSanityAssessment,
  loadContentSanityAcknowledgements,
  readRecentContentSanityEvents,
  summarizeContentSanityEvents,
  computeContentSanityAuditFilename,
  unacknowledgedContentSanityEvents,
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
  return {
    bytes: opts.bytes ?? 1000,
    oversize: !!opts.soft,
    junk_pattern_matches,
    literal_substring_matches,
    reasons,
    reason_messages,
    shouldHardBlock: !!opts.hard || junk_pattern_matches.length > 0 || literal_substring_matches.length > 0,
    shouldSkipEmbed: !!opts.soft && !opts.hard && junk_pattern_matches.length === 0 && literal_substring_matches.length === 0,
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
    expect(s.unique_source_slugs).toBe(0);
    expect(s.repeated_events).toBe(0);
    expect(s.by_type).toEqual({ hard_block: 0, soft_block: 0, warn: 0 });
    expect(s.top_patterns).toEqual([]);
    expect(s.top_repeated_source_slugs).toEqual([]);
  });

  test('counts by type', () => {
    const s = summarizeContentSanityEvents([
      event({ event_type: 'hard_block' }),
      event({ event_type: 'hard_block' }),
      event({ event_type: 'soft_block' }),
      event({ event_type: 'warn' }),
    ]);
    expect(s.by_type).toEqual({ hard_block: 2, soft_block: 1, warn: 1 });
    expect(s.total_events).toBe(4);
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

  test('counts unique source/slug pairs separately from repeated events', () => {
    const s = summarizeContentSanityEvents([
      event({ source_id: 'alpha', slug: 'log', bytes: 50_001 }),
      event({ source_id: 'alpha', slug: 'log', bytes: 100_000 }),
      event({ source_id: 'alpha', slug: 'other', bytes: 75_000 }),
      event({ source_id: 'beta', slug: 'log', bytes: 80_000 }),
      event({ source_id: 'beta', slug: 'log', bytes: 90_000 }),
    ]);
    expect(s.total_events).toBe(5);
    expect(s.unique_source_slugs).toBe(3);
    expect(s.repeated_events).toBe(2);
    expect(s.top_repeated_source_slugs[0]).toEqual({
      source_id: 'alpha',
      slug: 'log',
      count: 2,
      max_bytes: 100_000,
    });
    expect(s.top_repeated_source_slugs[1]).toEqual({
      source_id: 'beta',
      slug: 'log',
      count: 2,
      max_bytes: 90_000,
    });
  });
});

describe('content-sanity acknowledgements', () => {
  function event(over: Partial<ContentSanityAuditEvent>): ContentSanityAuditEvent {
    return {
      ts: '2026-06-01T00:00:00.000Z',
      event_type: 'warn',
      slug: 'test',
      source_id: 'default',
      bytes: 100,
      junk_pattern_matches: [],
      literal_substring_matches: [],
      reason_messages: [],
      ...over,
    };
  }

  test('acknowledges the current backlog and hides those rows from doctor readback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-ack-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const backlog = [
          event({ source_id: 'alpha', slug: 'same', ts: '2026-06-01T00:00:00.000Z' }),
          event({ source_id: 'alpha', slug: 'same', ts: '2026-06-01T01:00:00.000Z' }),
          event({ source_id: 'beta', slug: 'other', event_type: 'soft_block', ts: '2026-06-01T02:00:00.000Z' }),
        ];

        const result = acknowledgeContentSanityEvents(backlog, new Date('2026-06-01T03:00:00.000Z'));
        expect(result.count).toBe(2);
        expect(result.acknowledged_rows).toBe(3);
        expect(loadContentSanityAcknowledgements().length).toBe(2);
        expect(existsSync(contentSanityAcknowledgementsPath())).toBe(true);
        expect(unacknowledgedContentSanityEvents(backlog)).toEqual([]);

        expect(
          acknowledgeContentSanityEvents(backlog, new Date('2026-06-01T04:00:00.000Z')),
        ).toEqual({ count: 0, acknowledged_rows: 0, summary: [] });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('later recurrences on the same issue key surface as new unacknowledged events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-audit-recur-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const backlog = [
          event({ source_id: 'alpha', slug: 'same', ts: '2026-06-01T00:00:00.000Z' }),
          event({ source_id: 'alpha', slug: 'same', ts: '2026-06-01T01:00:00.000Z' }),
        ];
        acknowledgeContentSanityEvents(backlog, new Date('2026-06-01T02:00:00.000Z'));

        const recurring = [
          ...backlog,
          event({ source_id: 'alpha', slug: 'same', ts: '2026-06-01T03:00:00.000Z' }),
          event({ source_id: 'alpha', slug: 'same', event_type: 'soft_block', ts: '2026-06-01T04:00:00.000Z' }),
        ];

        const unacked = unacknowledgedContentSanityEvents(recurring);
        expect(unacked).toHaveLength(2);
        expect(unacked[0].ts).toBe('2026-06-01T03:00:00.000Z');
        expect(unacked[1].event_type).toBe('soft_block');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
