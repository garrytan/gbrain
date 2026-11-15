/**
 * GST-2768 PR 2: backfill over a large session folder stays bounded. Two thousand small synthetic OpenClaw session
 * files over 100 days, with transcripts.archive.backfill_days_per_run set to 5: each run reads every file once to learn
 * its days (holding no messages), loads again only the conversations on the 5 newest days still to do, writes them,
 * and leaves the rest as deferred; the next run starts where the last stopped and counts the finished days as
 * unchanged. Heap growth and wall time get loose bounds. Every value is synthetic. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_BACKFILL_CAP_KEY, ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { fileReader } from '../src/core/transcripts/archive-readers.ts';

const FILES = 2000;
const DAYS = 100;
const PER_DAY = FILES / DAYS;
const CAP = 5;
const root = mkdtempSync(join(tmpdir(), 'openclaw-scale-'));
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  for (let i = 0; i < FILES; i++) {
    const day = new Date(Date.UTC(2026, 7, 1) + (i % DAYS) * 86_400_000).toISOString().slice(0, 10);
    const id = 'scale-' + String(i).padStart(4, '0');
    const dir = join(root, 'agent-' + (i % 10));
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'session', version: 3, id, timestamp: day + 'T09:00:00.000Z', cwd: '/home/alice-example/agent-workspace' },
      { type: 'message', id: id + '-m0', parentId: null, timestamp: day + 'T09:00:00.000Z', message: { role: 'user', timestamp: day + 'T09:00:00.000Z', content: [{ type: 'text', text: 'question ' + i }] } },
      { type: 'message', id: id + '-m1', parentId: id + '-m0', timestamp: day + 'T09:01:00.000Z', message: { role: 'assistant', timestamp: day + 'T09:01:00.000Z', content: [{ type: 'text', text: 'answer ' + i }] } },
    ];
    writeFileSync(join(dir, id + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
});
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig(ARCHIVE_BACKFILL_CAP_KEY, String(CAP));
  await setArchiveEnabled(engine, true);
});

/** The file reader, counting how many conversations each run loads again after the scan. */
function countingReader(): { reader: ArchiveReader; loads: () => number; scanned: () => number } {
  const inner = fileReader({ format: 'openclaw', root, extension: '.jsonl' });
  let loads = 0;
  let scanned = 0;
  return {
    reader: { ...inner, async *scan(o) {
      for await (const e of inner.scan!(o)) {
        scanned++;
        expect(Object.keys(e)).not.toContain('session');
        yield { ...e, load: () => { loads++; return e.load(); } };
      }
    } },
    loads: () => loads,
    scanned: () => scanned,
  };
}

const NOW = new Date('2026-11-14T12:00:00Z');

describe('backfill over a large session folder', () => {
  test('each run writes only the capped days, loads only their conversations, and the next run resumes', async () => {
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const seen = new Set<string>();
    for (let run = 1; run <= 2; run++) {
      const c = countingReader();
      const result = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-01-01', readers: [c.reader], now: NOW });
      expect(result.errors).toEqual([]);
      expect(c.scanned()).toBe(FILES);
      expect(c.loads()).toBe(CAP * PER_DAY);
      expect(result.written).toBe(CAP * PER_DAY);
      expect(result.unchanged).toBe((run - 1) * CAP * PER_DAY);
      expect(result.deferred_days.length).toBe(DAYS - run * CAP);
      const days = [...new Set(result.days.filter(d => d.status === 'written').map(d => d.day))].sort();
      expect(days.length).toBe(CAP);
      for (const d of days) { expect(seen.has(d)).toBe(false); seen.add(d); }
      expect(days[0]! > result.deferred_days[result.deferred_days.length - 1]!).toBe(true);
    }
    expect(performance.now() - t0).toBeLessThan(60_000);
    expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(256 * 1024 * 1024);
  }, 240_000);
});
