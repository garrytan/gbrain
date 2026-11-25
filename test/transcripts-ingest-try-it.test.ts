/**
 * GBRA-789: after an import, `gbrain transcripts ingest` names a command that
 * opens the page it wrote. It used to print `try it: gbrain query "<slug tail>"`,
 * a keyword search for a slug string that answers nothing useful.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscripts } from '../src/commands/transcripts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-transcripts-try-it-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });

describe('transcripts ingest: the try-it hint', () => {
  test('names gbrain get with the slug of the page it wrote, never a query for a slug string', async () => {
    writeFileSync(join(dir, 'rollout-pricing.jsonl'), [
      line('2026-10-01T10:00:00.000Z', 'session_meta', { id: 'r-pricing', session_id: 'root-session', timestamp: '2026-10-01T10:00:00.000Z', cwd: '/repo', cli_version: '0.159.3' }),
      line('2026-10-01T10:00:01.000Z', 'event_msg', { type: 'user_message', message: 'What did we decide about acme-example pricing?' }),
      line('2026-10-01T10:00:02.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The starter plan stays free for three seats.' }] }),
    ].join('\n') + '\n');
    const out: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
    try {
      await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () =>
        runTranscripts(engine, ['ingest', dir, '--format', 'codex', '--source', 'default']));
    } finally {
      log.mockRestore();
    }
    const hint = out.find(l => l.startsWith('try it:'));
    expect(hint).toBeDefined();
    expect(hint).not.toContain('gbrain query');
    const slug = /^try it: gbrain get (\S+) --source-id default$/.exec(hint!)?.[1];
    expect(slug).toBeDefined();
    expect(await engine.getPage(slug!, { sourceId: 'default' })).not.toBeNull();
  }, 120_000);
});
