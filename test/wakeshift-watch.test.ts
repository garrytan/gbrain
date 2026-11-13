/**
 * \`gbrain wakeshift watch\` on a brain host (Wakeshift plan D8), on a repo-less PGLite brain: the local CLI has no
 * conversation to wake, so watch_job's refusal prints with its fix (gbrain jobs wait <id>) and a non-zero exit, and a
 * session_key passed on the command line is never written anywhere under GBRAIN_HOME nor echoed. The thin-client
 * route is pinned in test/thin-client-routing.test.ts and the refusal matrix golden.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runWakeshift } from '../src/commands/wakeshift.ts';
import { parseWatchArgs, printWatchResult } from '../src/commands/wakeshift-watch.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-watch-'));
const SECRET = 'sk-never-persist-example';
let engine: PGLiteEngine;
let out = '';
let err = '';
const orig = { log: console.log, error: console.error, write: process.stderr.write.bind(process.stderr), exitCode: process.exitCode };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

beforeAll(async () => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  out = ''; err = '';
  _resetCliExitVerdictForTests();
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
});
afterEach(() => {
  console.log = orig.log; console.error = orig.error; process.stderr.write = orig.write;
  _resetCliExitVerdictForTests();
  process.exitCode = orig.exitCode ?? 0;
});

describe('gbrain wakeshift watch on the brain host', () => {
  test('watch job prints watch_job\'s refusal with the local wait as its fix, exits non-zero, and never stores or echoes the session key', () =>
    withEnv({ GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined }, async () => {
      await runWakeshift(engine, ['watch', 'job', '5', '--session-key', SECRET, '--harness', 'claude-code']);
      expect(err).toContain('wakeshift_needs_conversation');
      expect(err).toContain('gbrain jobs wait 5');
      expect(currentExitCode()).not.toBe(0);
      expect(out).toBe('');
      expect(err).not.toContain(SECRET);
      for (const file of walk(home)) expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    }));

  test('watch --help prints the watch usage', async () => {
    await runWakeshift(engine, ['watch', '--help']);
    expect(out).toContain('gbrain wakeshift watch job <id>');
    expect(out).toContain('--session-key');
  });

  test('parse: params pass through as given, nothing defaulted', () => {
    expect(parseWatchArgs(['job', '7'])).toEqual({ tool: 'watch_job', params: { id: 7 }, json: false });
    expect(parseWatchArgs(['cron', 'nightly-digest', '--harness', 'openclaw', '--json'])).toEqual({ tool: 'watch_cron', params: { name: 'nightly-digest', harness: 'openclaw' }, json: true });
    expect(parseWatchArgs(['write', 'req-1', '--conversation-id', 'c-1'])).toEqual({ tool: 'watch_write_request', params: { request_id: 'req-1', conversation_id: 'c-1' }, json: false });
    expect(typeof parseWatchArgs(['job', '0'])).toBe('string');
  });

  test('text output names the cron and says an already-settled write wakes now, from the ops\' real result shapes', () => {
    printWatchResult({ watching: true, watch: 4, cron: 'nightly-digest', event: 'gbrain.cron.finished', expires_in: '7d' }, undefined, false);
    printWatchResult({ watching: true, watch: 5, request_id: 'req-1', event: 'gbrain.write.settled', already_settled: true, expires_in: '7d' }, undefined, false);
    expect(out).toContain('Watching gbrain.cron.finished for nightly-digest:');
    expect(out).toContain('It has already finished, so the wake goes out now.');
  });
});
