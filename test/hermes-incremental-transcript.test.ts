/**
 * Incremental Hermes acceptance against a synthetic SQLite store and real PGLite pages.
 *
 * This pins the documented --since last contract: a session appended after the
 * previous clean scan keeps its session identity and updates the existing page.
 * It does not claim late turns with timestamps at/before the cursor are found.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { loadOpCheckpoint, recordCompleted } from '../src/core/op-checkpoint.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { if (engine) await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'hermes-incremental-'));
}, 120_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plantedSecret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

describe('incremental Hermes transcript import', () => {
  test('appended newer turns after the saved session watermark update the same redacted page', async () => {
    const path = buildHermesFixture(dir);
    const first = await runTranscriptsIngest(engine, {
      paths: [path], format: 'hermes', sourceId: 'default',
      sessionSources: ['cli'], userPatternsPath: join(dir, 'no-private-patterns.txt'),
    });
    expect(first.cleanScan).toBe(true);
    expect(first.sessionsImported).toBe(1);
    expect(first.maxSessionTs).toBe('2026-08-05T08:00:10.000Z');
    const originalSlug = first.files[0].sessions[0].baseSlug;
    const before = await engine.getPage(originalSlug, { sourceId: 'default' });
    expect(before).not.toBeNull();
    expect(before!.compiled_truth).toContain('Launch checklist drafted');
    const checkpointKey = { op: 'transcripts-ingest', fingerprint: 'hermes-incremental-acceptance' };
    expect(await recordCompleted(engine, checkpointKey, [`since:${first.maxSessionTs}`])).toBe(true);
    const savedCursor = (await loadOpCheckpoint(engine, checkpointKey))
      .map(key => key.startsWith('since:') ? key.slice('since:'.length) : '')
      .filter(Boolean)
      .sort()
      .at(-1);
    expect(savedCursor).toBe(first.maxSessionTs);

    // A synthetic append to the same native session id, strictly after the
    // previous --since last cursor. SQLite's AUTOINCREMENT and pinned schema
    // are exercised; no user history or live Hermes state is involved.
    const db = new Database(path);
    try {
      db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('hermes-fixture-1', 'user', 'INCREMENTAL-APPEND-REQUEST', 1786003200);
      db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('hermes-fixture-1', 'assistant', `Synthetic key ${plantedSecret}`, 1786003210);
    } finally {
      db.close();
    }

    const second = await runTranscriptsIngest(engine, {
      paths: [path], format: 'hermes', sourceId: 'default',
      sessionSources: ['cli'], sinceIso: savedCursor,
      userPatternsPath: join(dir, 'no-private-patterns.txt'),
    });
    expect(second.cleanScan).toBe(true);
    expect(second.sessionsSeen).toBe(1);
    expect(second.sessionsFiltered).toBe(0);
    expect(second.sessionsImported).toBe(1);
    expect(second.maxSessionTs).toBe('2026-08-06T08:00:10.000Z');
    expect(second.files[0].sessions[0].baseSlug).toBe(originalSlug);
    expect(second.redactions).toBeGreaterThan(0);

    const after = await engine.getPage(originalSlug, { sourceId: 'default' });
    expect(after).not.toBeNull();
    expect(after!.compiled_truth).toContain('INCREMENTAL-APPEND-REQUEST');
    expect(after!.compiled_truth).toContain('<REDACTED:');
    expect(after!.compiled_truth).not.toContain(plantedSecret);
    const raw = await engine.getRawData(originalSlug, 'transcript:hermes', { sourceId: 'default' });
    expect(raw).toHaveLength(1);
    expect(raw[0].data).toMatchObject({ session_id: 'hermes-fixture-1', source: 'cli' });
    expect(JSON.stringify(raw[0].data)).not.toContain(plantedSecret);
  });

  test('same-timestamp late turns are intentionally outside the timestamp watermark guarantee', async () => {
    const path = buildHermesFixture(dir);
    const cursor = '2026-08-05T08:00:10.000Z';
    const db = new Database(path);
    try {
      db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('hermes-fixture-1', 'assistant', 'LATE-TURN-AT-CURSOR', 1785916810);
    } finally { db.close(); }
    const result = await runTranscriptsIngest(engine, {
      paths: [path], format: 'hermes', sourceId: 'default', sessionSources: ['cli'], sinceIso: cursor,
      dryRun: true, userPatternsPath: join(dir, 'no-private-patterns.txt'),
    });
    expect(result.sessionsSeen).toBe(1);
    expect(result.sessionsFiltered).toBe(1);
    expect(result.sessionsImported).toBe(0);
    expect(result.maxSessionTs).toBe(cursor);
  });
});
