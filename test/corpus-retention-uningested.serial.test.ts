/**
 * E-N1 (D16): corpus retention never silently deletes turns nothing has
 * extracted. Before the fix the session-end GC removed every corpus `.txt`
 * older than `corpus_retention_days` (default 30) with or without an
 * `.ingested` sidecar, so an HTTP-served brain with no corpus drain lost its
 * banked turns after 30 days. Now an un-ingested file stays until 3x
 * retention and doctor `memory_writeback` warns while it waits.
 *
 * Imports only modules that exist on the pre-fix tree, so it fails there.
 * SERIAL: mutates GBRAIN_HOME.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/commands/hook.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-corpus-ret-'));
  savedHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  mkdirSync(join(tmp, 'ws'), { recursive: true });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const corpus = () => join(tmp, '.gbrain', 'transcripts', 'corpus');

function aged(name: string, ageDays: number, ingested: boolean): string {
  mkdirSync(corpus(), { recursive: true });
  const p = join(corpus(), name);
  writeFileSync(p, '[user]\nan old turn\n');
  if (ingested) writeFileSync(p + '.ingested', '{}\n');
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(p, t, t);
  return p;
}

async function sessionEnd(): Promise<void> {
  const projects = join(tmp, 'claude', 'projects', 'p1');
  mkdirSync(projects, { recursive: true });
  const transcript = join(projects, 's.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'a new question' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] } }),
  ].join('\n') + '\n');
  expect(await runHook(['session-end'], {
    stdin: JSON.stringify({ session_id: 'sess-new', transcript_path: transcript, cwd: join(tmp, 'ws') }),
    transcriptRoot: join(tmp, 'claude', 'projects'),
  })).toBe(0);
}

describe('E-N1: session-end GC keeps un-ingested corpus files up to 3x retention', () => {
  test('an old extracted file is removed; an old un-extracted file survives; one past 3x retention is removed', async () => {
    const extracted = aged('old-done.txt', 40, true);
    const waiting = aged('old-waiting.txt', 40, false);
    const ceiling = aged('ancient-waiting.txt', 95, false);
    const fresh = aged('fresh-waiting.txt', 2, false);
    await sessionEnd();
    expect(existsSync(join(corpus(), 'sess-new.txt'))).toBe(true);
    expect(existsSync(extracted)).toBe(false);
    expect(existsSync(waiting)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(ceiling)).toBe(false);
  });
});

describe('E-N1: doctor memory_writeback names the un-extracted backlog before it is deleted', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('files past retention without a sidecar warn with counts, age, the deletion day and the extract command', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
    aged('old-waiting.txt', 40, false);
    aged('fresh-waiting.txt', 2, false);
    aged('old-done.txt', 40, true);
    const check = await buildMemoryWritebackCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 of 2 captured session file(s) are older than the 30-day corpus retention');
    expect(check.message).toContain('deleted at 90d');
    expect(check.message).toContain('gbrain sweep --once');
    expect(check.details?.corpus_backlog).toMatchObject({ pending: 2, past_retention: 1, oldest_pending_days: 40, deleted_after_days: 90 });
  });

  test('a backlog inside retention is reported in details and stays ok', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
    aged('fresh-waiting.txt', 2, false);
    const check = await buildMemoryWritebackCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.details?.corpus_backlog).toMatchObject({ pending: 1, past_retention: 0 });
  });
});
