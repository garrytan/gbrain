/**
 * Friction core: writer + reader + renderer + redactor.
 *
 * These tests are pure local-fs (no DB, no subprocess). They run under
 * GBRAIN_HOME=<tmp> for hermeticity — see test/gbrain-home-isolation.test.ts
 * for the regression gate proving every consumer honors that env.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  logFriction, readFriction, listRuns, renderReport, renderSummary,
  redactEntry, frictionFile, frictionDir, activeRunId,
  type FrictionEntry,
} from '../src/core/friction.ts';

const ORIG_HOME = process.env.GBRAIN_HOME;
const ORIG_RUN_ID = process.env.GBRAIN_FRICTION_RUN_ID;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-test-'));
  process.env.GBRAIN_HOME = tmp;
  delete process.env.GBRAIN_FRICTION_RUN_ID;
});

afterEach(() => {
  process.env.GBRAIN_HOME = ORIG_HOME;
  if (ORIG_RUN_ID !== undefined) process.env.GBRAIN_FRICTION_RUN_ID = ORIG_RUN_ID;
  rmSync(tmp, { recursive: true, force: true });
});

describe('writer', () => {
  test('logFriction appends one JSONL line and roundtrips through reader', () => {
    logFriction({ runId: 'run-a', phase: 'install', message: 'first', severity: 'error' });
    const { entries, malformed } = readFriction('run-a');
    expect(malformed).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('first');
    expect(entries[0].severity).toBe('error');
    expect(entries[0].kind).toBe('friction');
    expect(entries[0].schema_version).toBe('1');
    expect(entries[0].run_id).toBe('run-a');
  });

  test('multiple entries append in order', () => {
    logFriction({ runId: 'run-b', phase: 'p1', message: 'one', severity: 'nit' });
    logFriction({ runId: 'run-b', phase: 'p2', message: 'two', severity: 'blocker' });
    const { entries } = readFriction('run-b');
    expect(entries.map(e => e.message)).toEqual(['one', 'two']);
  });

  test('long messages are truncated', () => {
    const long = 'x'.repeat(5000);
    logFriction({ runId: 'run-c', phase: 'p', message: long });
    const { entries } = readFriction('run-c');
    expect(entries[0].message.length).toBeLessThan(5000);
    expect(entries[0].message.endsWith('[truncated]')).toBe(true);
  });

  test('kind: delight is recorded distinctly', () => {
    logFriction({ runId: 'run-d', phase: 'verify', message: 'this just worked', kind: 'delight' });
    const { entries } = readFriction('run-d');
    expect(entries[0].kind).toBe('delight');
  });

  test('phase-marker entry roundtrips', () => {
    logFriction({ runId: 'run-e', phase: 'extract', message: 'phase started', kind: 'phase-marker', marker: 'start' });
    const { entries } = readFriction('run-e');
    expect(entries[0].kind).toBe('phase-marker');
    expect(entries[0].marker).toBe('start');
  });

  test('error envelope fields flatten in (D20)', () => {
    logFriction({
      runId: 'run-f',
      phase: 'install',
      message: 'spawn failed',
      severity: 'blocker',
      errorClass: 'AgentSpawnError',
      errorCode: 'spawn_enoent',
      docsUrl: 'https://example.test/docs',
    });
    const { entries } = readFriction('run-f');
    expect(entries[0].class).toBe('AgentSpawnError');
    expect(entries[0].code).toBe('spawn_enoent');
    expect(entries[0].docs_url).toBe('https://example.test/docs');
  });

  test('rejects invalid run-id', () => {
    expect(() => logFriction({ runId: 'has space', phase: 'p', message: 'm' })).toThrow(/invalid run-id/);
    expect(() => logFriction({ runId: '../escape', phase: 'p', message: 'm' })).toThrow(/invalid run-id/);
  });
});

describe('activeRunId', () => {
  test('falls back to standalone when env unset (D19)', () => {
    delete process.env.GBRAIN_FRICTION_RUN_ID;
    expect(activeRunId()).toBe('standalone');
  });

  test('reads GBRAIN_FRICTION_RUN_ID', () => {
    process.env.GBRAIN_FRICTION_RUN_ID = 'my-run';
    try {
      expect(activeRunId()).toBe('my-run');
    } finally {
      delete process.env.GBRAIN_FRICTION_RUN_ID;
    }
  });
});

describe('reader', () => {
  test('skips malformed lines and counts them', () => {
    logFriction({ runId: 'run-g', phase: 'p', message: 'good' });
    appendFileSync(frictionFile('run-g'), 'this is not json\n', 'utf-8');
    appendFileSync(frictionFile('run-g'), '{"ts":"only","kind":"friction"}\n', 'utf-8');
    logFriction({ runId: 'run-g', phase: 'p', message: 'good2' });
    const { entries, malformed } = readFriction('run-g');
    expect(entries).toHaveLength(2);
    expect(malformed).toBe(2);
  });

  test('throws on missing run-id', () => {
    expect(() => readFriction('does-not-exist')).toThrow(/not found/);
  });
});

describe('listRuns', () => {
  test('lists runs sorted most-recent-first', () => {
    logFriction({ runId: 'old-run', phase: 'p', message: 'a' });
    // Sleep one millisecond worth via busy-wait so mtime differs reliably
    const t0 = Date.now();
    while (Date.now() - t0 < 10) { /* spin */ }
    logFriction({ runId: 'new-run', phase: 'p', message: 'b' });
    const runs = listRuns();
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe('new-run');
    expect(runs[1].runId).toBe('old-run');
  });

  test('reports per-run counts and interrupted flag', () => {
    logFriction({ runId: 'run-h', phase: 'p', message: 'a', severity: 'error' });
    logFriction({ runId: 'run-h', phase: 'p', message: 'b', severity: 'error' });
    logFriction({ runId: 'run-h', phase: 'p', message: 'c', kind: 'delight' });
    logFriction({ runId: 'run-h', phase: 'p', message: 'killed', kind: 'interrupted' });
    const runs = listRuns();
    const r = runs.find(x => x.runId === 'run-h')!;
    expect(r.counts.friction).toBe(2);
    expect(r.counts.delight).toBe(1);
    expect(r.counts.interrupted).toBe(true);
    expect(r.counts.bySeverity.error).toBe(2);
  });
});

describe('renderer', () => {
  test('markdown groups by severity then phase', () => {
    logFriction({ runId: 'run-r', phase: 'install', message: 'a', severity: 'blocker' });
    logFriction({ runId: 'run-r', phase: 'install', message: 'b', severity: 'error' });
    logFriction({ runId: 'run-r', phase: 'verify', message: 'c', severity: 'error' });
    logFriction({ runId: 'run-r', phase: 'verify', message: 'positive', kind: 'delight' });
    const md = renderReport('run-r', { format: 'md', redact: false });
    expect(md).toContain('# Friction report');
    expect(md).toContain('## blocker');
    expect(md).toContain('## error');
    expect(md).toContain('### `install`');
    expect(md).toContain('### `verify`');
    // Blocker section comes before error section
    expect(md.indexOf('## blocker')).toBeLessThan(md.indexOf('## error'));
  });

  test('json output is valid and includes entries', () => {
    logFriction({ runId: 'run-j', phase: 'p', message: 'one' });
    const out = renderReport('run-j', { format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.run_id).toBe('run-j');
    expect(parsed.entries).toHaveLength(1);
  });

  test('redact strips homedir and cwd from message + cwd field', () => {
    const home = process.env.HOME ?? '';
    const fakeCwd = process.cwd();
    logFriction({
      runId: 'run-red',
      phase: 'p',
      message: `error at ${home}/.gbrain/foo and ${fakeCwd}/bar.ts`,
    });
    const md = renderReport('run-red', { format: 'md', redact: true });
    expect(md).not.toContain(home + '/.gbrain');
    expect(md).toContain('<HOME>');
    expect(md).toContain('<CWD>');
  });

  test('--no-redact path preserves homedir', () => {
    const home = process.env.HOME ?? '/tmp/none';
    logFriction({ runId: 'run-noredact', phase: 'p', message: `at ${home}/foo` });
    const md = renderReport('run-noredact', { format: 'md', redact: false });
    expect(md).toContain(home);
  });

  test('interrupted run shows banner', () => {
    logFriction({ runId: 'run-i', phase: 'p', message: 'partial' });
    logFriction({ runId: 'run-i', phase: 'p', message: 'killed', kind: 'interrupted' });
    const md = renderReport('run-i', { format: 'md', redact: false });
    expect(md).toContain('Run was interrupted');
  });
});

describe('summary', () => {
  test('two columns, friction + delight side-by-side', () => {
    logFriction({ runId: 'run-s', phase: 'p', message: 'bad-thing' });
    logFriction({ runId: 'run-s', phase: 'p', message: 'good-thing', kind: 'delight' });
    const md = renderSummary('run-s', { format: 'md' });
    expect(md).toContain('| friction (1) | delight (1) |');
    expect(md).toContain('bad-thing');
    expect(md).toContain('good-thing');
  });
});

describe('redactEntry pure function', () => {
  test('replaces homedir occurrences', () => {
    const home = process.env.HOME ?? '/x';
    const e: FrictionEntry = {
      schema_version: '1', ts: 'now', run_id: 'r', phase: 'p', kind: 'friction',
      message: `${home}/secret/file.txt`, source: 'claw', cwd: '/cwd', gbrain_version: 'test',
    };
    const r = redactEntry(e);
    expect(r.message).toContain('<HOME>');
    expect(r.cwd).toBe('<CWD>');
  });
});
