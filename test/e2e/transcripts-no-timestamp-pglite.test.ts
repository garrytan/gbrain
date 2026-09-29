/**
 * Write-path audit C-19: a session with no timestamps at all cannot be
 * rendered (provenance is never fabricated). It is a reported skip, not a
 * session error, so it no longer freezes the `--since last` checkpoint and
 * forces a full rescan on every later run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';

let engine: PGLiteEngine;
let tmp: string;

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
  tmp = mkdtempSync(join(tmpdir(), 'gb-transcripts-no-ts-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('transcripts ingest: sessions without timestamps (C-19)', () => {
  test('are reported as skipped and keep the scan clean', async () => {
    const path = join(tmp, 'conversations.json');
    writeFileSync(path, JSON.stringify([
      { uuid: 'dated-1', name: 'Dated', created_at: '2026-08-01T10:00:00Z',
        chat_messages: [
          { uuid: 'm1', sender: 'human', created_at: '2026-08-01T10:00:00Z', text: 'hello there' },
          { uuid: 'm2', sender: 'assistant', created_at: '2026-08-01T10:00:30Z', text: 'hi back' },
        ] },
      { uuid: 'undated-1', name: 'Undated',
        chat_messages: [
          { uuid: 'm3', sender: 'human', text: 'no clock here' },
          { uuid: 'm4', sender: 'assistant', text: 'none here either' },
        ] },
    ]));

    const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'claude-export' });

    expect(r.sessionsImported).toBe(1);
    expect(r.sessionsErrored).toBe(0);
    expect(r.sessionsSkippedNoTimestamp).toBe(1);
    expect(r.cleanScan).toBe(true);
    const undated = r.files[0].sessions.find(s => s.sessionId === 'undated-1');
    expect(undated?.skipped).toBe('no_timestamp');
    expect(undated?.error).toBeUndefined();
  });
});
