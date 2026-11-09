import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ContentSanityAuditEvent } from '../src/core/audit/content-sanity-audit.ts';
import { resolvedOversizeAuditIndexes } from '../src/commands/doctor/checks/content-quality.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

test('only newer canonical revisions within the original size threshold resolve historical warnings', async () => {
  await engine.putPage('notes/fixed', { type: 'note', title: 'Fixed', compiled_truth: 'Short report.' });
  await engine.putPage('notes/still-large', { type: 'note', title: 'Still large', compiled_truth: 'x'.repeat(1200) });
  await engine.executeRaw("UPDATE pages SET updated_at='2026-02-02T00:00:00Z'");
  const warning: ContentSanityAuditEvent = {
    ts: '2026-02-01T00:00:00Z',
    event_type: 'warn',
    slug: 'notes/fixed',
    source_id: 'default',
    bytes: 1500,
    junk_pattern_matches: [],
    literal_substring_matches: [],
    reason_messages: ['PAGE_OVERSIZE_WARN: body 1500 bytes exceeds 1000 byte warn threshold'],
  };
  const events: ContentSanityAuditEvent[] = [
    warning,
    { ...warning, source_id: 'other-source' },
    { ...warning, slug: 'notes/still-large' },
    { ...warning, ts: '2026-02-03T00:00:00Z' },
    { ...warning, bypass_active: true },
    { ...warning, event_type: 'soft_block' },
  ];
  expect(await resolvedOversizeAuditIndexes(engine, events)).toEqual(new Set([0]));
  expect(events).toHaveLength(6);
}, 15_000);
