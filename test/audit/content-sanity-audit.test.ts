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
    expect(s.by_type).toEqual({ hard_block: 0, soft_block: 0, warn: 0 });
    expect(s.top_patterns).toEqual([]);
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
});
