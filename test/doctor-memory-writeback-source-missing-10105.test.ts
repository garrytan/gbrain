/**
 * #10105: a captured session file whose named source was removed is skipped by a
 * sweep (corpus_source_missing), so doctor must not count it as an extractable
 * backlog or advise a sweep for it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-src-missing-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function aged(dir: string, name: string, ageDays: number): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '[user]\nan old turn\n');
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(p, t, t);
}

describe('#10105 doctor memory_writeback and files naming a removed source', () => {
  test('they are counted apart from the extractable backlog and the sweep is not advised for them', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      await engine.setConfig('memory.auto_writeback', 'salient');
      mkdirSync(join(tmp, '.gbrain'), { recursive: true });
      writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
      const spool = join(tmp, '.gbrain', 'transcripts', 'corpus', 'sourced');
      aged(spool, 'sess-gone.src-removed-source.txt', 40);
      const check = await buildMemoryWritebackCheck(engine);
      const message = check.message ?? '';
      expect(check.details?.corpus_backlog).toMatchObject({ pending: 0, past_retention: 0, source_missing: 1 });
      expect(message).toContain('corpus_source_missing');
      expect(message).not.toContain('gbrain sweep --once');
    });
  });
});
