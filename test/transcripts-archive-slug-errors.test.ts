/**
 * Conversation archive slugs, run errors and legacy marks. Every day slug passes the write gate's admission for a new
 * page (no hyphen run, no segment-final hyphen, a portable file name) for any session key, cron job name or part
 * number, and different conversations never share a slug. A day that fails is listed in the run's errors with its day
 * and code (the CLI exits 1 exactly when that list is not empty) and archives on the next run. Days adopt-legacy
 * recorded are skipped even when the brain turned shared in between. PGLite, synthetic values only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { archiveDayBaseSlug, conversationLabel } from '../src/core/transcripts/archive-day.ts';
import { ARCHIVE_TIMEZONE_KEY, adoptLegacyArchive, runTranscriptArchive, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { suffixedSlugAdmission } from '../src/core/persistence/suffixed-slug.ts';
import { slugPortabilityProblem } from '../src/core/portable-slug.ts';
import { hyphenFoldedSlug } from '../src/core/sync.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOSTILE = [
  'aaa-bbb-ccc-ddd-eee-fff-ggg', 'x-'.repeat(20), '-leading', 'trailing-', '--', '-', '', '   ', 'a--b---c', 'Ünïcödé-名前-', '🙂-🙂-',
  'dots.and.dots.', 'under_score_', 'slash/inside/', 'aux', 'con', 'nul.txt', 'x'.repeat(300), 'a-'.repeat(12) + 'tail', 'abcdefghijklmnopqrstuvw-xyz',
];

function* hostileCases(): Generator<{ key: string; cron?: string; chatType?: 'direct' | 'group' | 'room'; verified: boolean }> {
  let n = 0;
  for (const cron of HOSTILE) {
    for (const chatType of ['direct', 'group', 'room', undefined] as const) {
      for (const verified of [true, false]) {
        n++;
        yield { key: 'agent:main:cron:' + cron + ':' + n, cron, ...(chatType ? { chatType } : {}), verified };
        yield { key: cron + '-' + n, ...(chatType ? { chatType } : {}), verified };
      }
    }
  }
}

describe('archive day slugs pass the write gate', () => {
  const ctx = { remote: false } as OperationContext;
  test('for every hostile key, cron name, channel and part number', () => {
    const seen = new Map<string, string>();
    for (const c of hostileCases()) {
      for (const harness of ['openclaw', 'claude-code', 'codex'] as const) {
        const channel = c.verified || c.cron ? { verified: c.verified, ...(c.chatType ? { chatType: c.chatType } : {}), ...(c.cron !== undefined ? { cronJob: c.cron } : {}) } : undefined;
        const base = archiveDayBaseSlug(harness, '2026-11-02', conversationLabel(harness, c.key, channel), c.key);
        for (const slug of [base, base + '-p2', base + '-p17']) {
          expect([slug, hyphenFoldedSlug(slug)]).toEqual([slug, null]);
          expect([slug, slugPortabilityProblem(slug)]).toEqual([slug, null]);
          expect(suffixedSlugAdmission(ctx, slug, false)).toBeNull();
        }
        const prior = seen.get(base);
        expect([base, prior ?? harness + c.key]).toEqual([base, harness + c.key]);
        seen.set(base, harness + c.key);
      }
    }
    expect(seen.size).toBeGreaterThan(300);
  });
});

describe('run errors and retries (pglite)', () => {
  let engine: PGLiteEngine;
  const dirs: string[] = [];
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    await engine.setConfig('brain.audience', 'personal');
    await setArchiveEnabled(engine, true);
  });

  const conv = () => conversation('codex', 'rollout-retry', [['user', '2026-11-02T10:00:00.000Z', 'hello'], ['assistant', '2026-11-02T10:01:00.000Z', 'hi']]);
  const opts = { mode: 'backfill' as const, from: '2026-11-01', to: '2026-11-03', now: new Date('2026-11-10T00:00:00Z') };

  test('a day that fails is listed in errors with its day and code, and archives on the next run', async () => {
    let fail = true;
    const reader: ArchiveReader = {
      harness: 'codex', name: 'codex',
      async *scan() {
        const c = conv();
        yield { harness: 'codex', conversationKey: c.conversationKey, sessionId: c.conversationKey, days: ['2026-11-02'], newest: '2026-11-02T10:01:00.000Z',
          load: async () => { if (fail) throw new Error('synthetic read failure'); return c; } };
      },
    };
    const first = await runTranscriptArchive(engine, { ...opts, readers: [reader] });
    expect(first.days.map(d => [d.day, d.status, d.code])).toEqual([['2026-11-02', 'error', 'archive_reader_failed']]);
    expect(first.errors).toEqual([expect.objectContaining({ harness: 'codex', day: '2026-11-02', code: 'archive_reader_failed', message: 'synthetic read failure' })]);
    fail = false;
    const second = await runTranscriptArchive(engine, { ...opts, readers: [reader] });
    expect(second.errors).toEqual([]);
    expect(second.days.map(d => [d.day, d.status])).toEqual([['2026-11-02', 'written']]);
  }, 60_000);

  test('a shared brain with no owner lists the hold in errors', async () => {
    await engine.setConfig('brain.audience', 'shared');
    const result = await runTranscriptArchive(engine, { ...opts, readers: [staticReader('codex', [conv()])] });
    expect(result.held).toBe(1);
    expect(result.errors.map(e => e.code)).toEqual(['archive_owner_unset']);
  }, 60_000);

  test('days adopt-legacy recorded are skipped after the brain turned shared and the archive moved to its owner-only source', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'archive-legacy-'));
    const checkout = mkdtempSync(join(tmpdir(), 'archive-checkout-'));
    dirs.push(legacy, checkout);
    mkdirSync(join(legacy, 'codex'), { recursive: true });
    writeFileSync(join(legacy, 'codex', '2026-11-02.md'), '# old archive day\n');
    const adopted = await adoptLegacyArchive(engine, { dir: legacy, apply: true });
    expect(adopted.source_id).toBe('conversations');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('conversations', 'Conversation archive checkout', $1)", [checkout]);
    await engine.setConfig('brain.audience', 'shared');
    await addMember(engine, 'alice-example');
    await setOwner(engine, 'alice-example');
    const result = await runTranscriptArchive(engine, { ...opts, readers: [staticReader('codex', [conv()])] });
    expect(result.source_id).toBe('conversations-owner');
    expect(result.skipped_legacy).toBe(1);
    expect(result.written).toBe(0);
  }, 60_000);

  test('days adopt-legacy recorded on a shared brain are still skipped after the brain turned personal again', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'archive-legacy-'));
    const checkout = mkdtempSync(join(tmpdir(), 'archive-checkout-'));
    dirs.push(legacy, checkout);
    mkdirSync(join(legacy, 'codex'), { recursive: true });
    writeFileSync(join(legacy, 'codex', '2026-11-02.md'), '# old archive day\n');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('conversations', 'Conversation archive checkout', $1)", [checkout]);
    await engine.setConfig('brain.audience', 'shared');
    await addMember(engine, 'alice-example');
    await setOwner(engine, 'alice-example');
    const adopted = await adoptLegacyArchive(engine, { dir: legacy, apply: true });
    expect(adopted.source_id).toBe('conversations-owner');
    await engine.setConfig('brain.audience', 'personal');
    const result = await runTranscriptArchive(engine, { ...opts, readers: [staticReader('codex', [conv()])] });
    expect(result.source_id).toBe('conversations');
    expect(result.skipped_legacy).toBe(1);
    expect(result.written).toBe(0);
  }, 60_000);
});
