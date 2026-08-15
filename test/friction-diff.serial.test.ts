/**
 * gbrain friction diff — cross-run comparison tests (Phase E).
 *
 * Zero-binary: exercises runFriction dispatch + the exported diff helpers
 * directly against a tmp GBRAIN_HOME, same conventions as friction-cli.test.ts.
 *
 * Spec anchors (plan Phase E + adversarial gate): identity is (kind, phase,
 * normalized message prefix — digits collapsed) with severity EXCLUDED (it is
 * the compared attribute, as a per-severity multiset); identities are
 * MULTISETS (count deltas are differences); only kind friction|delight is
 * diffable (markers/interruptions feed the compatibility banner); exit codes
 * 0 = ran, 1 = resolution/IO error, 2 = usage error.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, appendFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runFriction, computeFrictionDiff, resolveRunSpec } from '../src/commands/friction.ts';
import { logFriction, frictionFile } from '../src/core/friction.ts';
import type { FrictionSeverity } from '../src/core/friction.ts';

const ORIG_HOME = process.env.GBRAIN_HOME;
const ORIG_RUN_ID = process.env.GBRAIN_FRICTION_RUN_ID;
let tmp: string;
let stdoutLines: string[];
let stderrLines: string[];
let origStdoutWrite: typeof process.stdout.write;
let origConsoleLog: typeof console.log;
let origConsoleError: typeof console.error;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-diff-'));
  process.env.GBRAIN_HOME = tmp;
  delete process.env.GBRAIN_FRICTION_RUN_ID;
  stdoutLines = [];
  stderrLines = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origConsoleLog = console.log;
  origConsoleError = console.error;
  process.stdout.write = ((chunk: string) => { stdoutLines.push(String(chunk)); return true; }) as any;
  console.log = (...args: unknown[]) => { stdoutLines.push(args.join(' ') + '\n'); };
  console.error = (...args: unknown[]) => { stderrLines.push(args.join(' ') + '\n'); };
});

afterEach(() => {
  process.env.GBRAIN_HOME = ORIG_HOME;
  if (ORIG_RUN_ID !== undefined) process.env.GBRAIN_FRICTION_RUN_ID = ORIG_RUN_ID;
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write = origStdoutWrite;
  console.log = origConsoleLog;
  console.error = origConsoleError;
});

/** Stamp the run-start marker the harness writes on every run. */
function startMarker(runId: string, opts: { agent?: string; scenario?: string } = {}): void {
  logFriction({
    runId, phase: 'run', kind: 'phase-marker', marker: 'start',
    message: 'run start', source: 'harness',
    agent: opts.agent, scenario: opts.scenario,
  });
}

function friction(runId: string, phase: string, message: string, severity: FrictionSeverity = 'error'): void {
  logFriction({ runId, phase, message, severity, kind: 'friction', source: 'claw' });
}

function diffJson(base: string, compare: string): { code: number; parsed: any } {
  stdoutLines.length = 0;
  const code = runFriction(['diff', '--base', base, '--compare', compare, '--json']);
  const out = stdoutLines.join('').trim();
  return { code, parsed: out ? JSON.parse(out) : undefined };
}

describe('three sections', () => {
  test('unique-to-compare, unique-to-base, and severity change land in the right buckets', () => {
    startMarker('run-base', { agent: 'scripted', scenario: 'fresh-install' });
    friction('run-base', 'install', 'init did not say which engine', 'error');
    startMarker('run-cmp', { agent: 'scripted', scenario: 'fresh-install' });
    friction('run-cmp', 'install', 'init did not say which engine', 'blocker'); // X, severity bumped
    friction('run-cmp', 'query', 'query returned nothing for a seeded doc', 'confused'); // Y

    const { code, parsed } = diffJson('run-base', 'run-cmp');
    expect(code).toBe(0);
    expect(parsed.unique_to_base).toEqual([]);
    expect(parsed.unique_to_compare.length).toBe(1);
    expect(parsed.unique_to_compare[0].phase).toBe('query');
    expect(parsed.unique_to_compare[0].message).toContain('query returned nothing');
    expect(parsed.changed.length).toBe(1);
    expect(parsed.changed[0].phase).toBe('install');
    expect(parsed.changed[0].severity_changed).toBe(true);
    expect(parsed.changed[0].count_changed).toBe(false);
    expect(parsed.changed[0].base_severities).toEqual(['error']);
    expect(parsed.changed[0].compare_severities).toEqual(['blocker']);
  });

  test('human output labels sections by run-id (instrument, not judge) and groups by phase', () => {
    startMarker('run-base', { agent: 'scripted', scenario: 'fresh-install' });
    friction('run-base', 'install', 'only in base run');
    startMarker('run-cmp', { agent: 'scripted', scenario: 'fresh-install' });
    friction('run-cmp', 'query', 'only in compare run');

    stdoutLines.length = 0;
    const code = runFriction(['diff', '--base', 'run-base', '--compare', 'run-cmp']);
    expect(code).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('Unique to `run-cmp`');
    expect(out).toContain('Unique to `run-base`');
    expect(out).toContain('Shared but changed');
    expect(out).toContain('### `install`');
    expect(out).toContain('### `query`');
  });
});

describe('multiset counts', () => {
  test('1×error vs 10×error of the same identity is a count delta, not equality', () => {
    startMarker('run-a', { agent: 'scripted' });
    friction('run-a', 'embed', 'embed batch rejected by provider', 'error');
    startMarker('run-b', { agent: 'scripted' });
    for (let i = 0; i < 10; i++) friction('run-b', 'embed', 'embed batch rejected by provider', 'error');

    const { code, parsed } = diffJson('run-a', 'run-b');
    expect(code).toBe(0);
    expect(parsed.unique_to_base).toEqual([]);
    expect(parsed.unique_to_compare).toEqual([]);
    expect(parsed.changed.length).toBe(1);
    expect(parsed.changed[0].base_count).toBe(1);
    expect(parsed.changed[0].compare_count).toBe(10);
    expect(parsed.changed[0].count_changed).toBe(true);
    expect(parsed.changed[0].severity_changed).toBe(false);
  });
});

describe('kind filter', () => {
  test('phase-marker and interrupted entries never enter the three sections; they feed the banner', () => {
    startMarker('run-a', { agent: 'scripted' });
    logFriction({ runId: 'run-a', phase: 'run', kind: 'phase-marker', marker: 'end', message: 'MARKER SENTINEL A', source: 'harness' });
    logFriction({ runId: 'run-a', phase: 'run', kind: 'interrupted', message: 'INTERRUPT SENTINEL A', source: 'harness' });
    friction('run-a', 'install', 'real base friction');
    startMarker('run-b', { agent: 'scripted' });
    logFriction({ runId: 'run-b', phase: 'run', kind: 'phase-marker', marker: 'end', message: 'MARKER SENTINEL B', source: 'harness' });
    logFriction({ runId: 'run-b', phase: 'run', kind: 'interrupted', message: 'INTERRUPT SENTINEL B', source: 'harness' });
    friction('run-b', 'install', 'real compare friction');

    const { code, parsed } = diffJson('run-a', 'run-b');
    expect(code).toBe(0);
    const sections = JSON.stringify([parsed.unique_to_base, parsed.unique_to_compare, parsed.changed]);
    expect(sections).not.toContain('SENTINEL');
    expect(parsed.unique_to_base.length).toBe(1);
    expect(parsed.unique_to_compare.length).toBe(1);
    expect(parsed.banner.base.interrupted).toBe(true);
    expect(parsed.banner.compare.interrupted).toBe(true);
  });
});

describe('run resolution', () => {
  test('agent name resolves to the LATEST run carrying that agent', () => {
    startMarker('older-run', { agent: 'hermes' });
    friction('older-run', 'install', 'old friction');
    startMarker('newer-run', { agent: 'hermes' });
    friction('newer-run', 'install', 'new friction');
    // Deterministic mtimes: older-run well in the past, newer-run now.
    const past = new Date(Date.now() - 60_000);
    utimesSync(frictionFile('older-run'), past, past);

    expect(resolveRunSpec('hermes')).toBe('newer-run');

    const { code, parsed } = diffJson('hermes', 'older-run');
    expect(code).toBe(0);
    expect(parsed.base).toBe('newer-run');
    expect(parsed.compare).toBe('older-run');
  });

  test('an exact run-id wins over agent-name interpretation', () => {
    // A run whose run-id IS the string 'hermes', carrying a different agent...
    startMarker('hermes', { agent: 'scripted' });
    // ...and a newer run whose AGENT is 'hermes'.
    startMarker('agent-stamped-run', { agent: 'hermes' });
    const past = new Date(Date.now() - 60_000);
    utimesSync(frictionFile('hermes'), past, past);

    expect(resolveRunSpec('hermes')).toBe('hermes');
  });
});

describe('failure semantics', () => {
  test('unknown run or agent exits 1 and stderr lists available runs', () => {
    startMarker('run-known', { agent: 'scripted' });
    stderrLines.length = 0;
    const code = runFriction(['diff', '--base', 'no-such-run', '--compare', 'run-known']);
    expect(code).toBe(1);
    const err = stderrLines.join('');
    expect(err).toContain('no-such-run');
    expect(err).toContain('available runs');
    expect(err).toContain('run-known');
  });

  test('no runs at all: unknown spec exits 1 with an empty available list', () => {
    const code = runFriction(['diff', '--base', 'ghost-a', '--compare', 'ghost-b']);
    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('(none)');
  });
});

describe('empty and identical runs', () => {
  test('a run with only a start marker produces a valid empty diff, exit 0', () => {
    startMarker('empty-a', { agent: 'scripted', scenario: 'fresh-install' });
    startMarker('empty-b', { agent: 'scripted', scenario: 'fresh-install' });
    const { code, parsed } = diffJson('empty-a', 'empty-b');
    expect(code).toBe(0);
    expect(parsed.unique_to_base).toEqual([]);
    expect(parsed.unique_to_compare).toEqual([]);
    expect(parsed.changed).toEqual([]);
    expect(parsed.banner.warnings).toEqual([]);
  });

  test('base equals compare: valid no-difference output, exit 0', () => {
    startMarker('run-same', { agent: 'scripted' });
    friction('run-same', 'install', 'a friction entry');
    const { code, parsed } = diffJson('run-same', 'run-same');
    expect(code).toBe(0);
    expect(parsed.base).toBe('run-same');
    expect(parsed.compare).toBe('run-same');
    expect(parsed.unique_to_base).toEqual([]);
    expect(parsed.unique_to_compare).toEqual([]);
    expect(parsed.changed).toEqual([]);

    stdoutLines.length = 0;
    expect(runFriction(['diff', '--base', 'run-same', '--compare', 'run-same'])).toBe(0);
    expect(stdoutLines.join('')).toContain('No differences');
  });
});

describe('malformed JSONL tolerance', () => {
  test('a malformed line is skipped, its count surfaces, and the diff is still produced', () => {
    startMarker('mal-run', { agent: 'scripted' });
    appendFileSync(frictionFile('mal-run'), '{this is not json\n', 'utf-8');
    friction('mal-run', 'install', 'friction after the bad line');
    startMarker('clean-run', { agent: 'scripted' });

    const { code, parsed } = diffJson('mal-run', 'clean-run');
    expect(code).toBe(0);
    expect(parsed.banner.base.malformed).toBe(1);
    expect(parsed.banner.compare.malformed).toBe(0);
    expect(parsed.unique_to_base.length).toBe(1);

    stdoutLines.length = 0;
    runFriction(['diff', '--base', 'mal-run', '--compare', 'clean-run']);
    expect(stdoutLines.join('')).toContain('1 malformed line(s) skipped');
  });
});

describe('compatibility banner', () => {
  test('scenario mismatch warns loudly, naming both scenarios', () => {
    startMarker('scen-a', { agent: 'scripted', scenario: 'fresh-install' });
    startMarker('scen-b', { agent: 'scripted', scenario: 'upgrade-from-v0.18' });

    const { code, parsed } = diffJson('scen-a', 'scen-b');
    expect(code).toBe(0);
    expect(parsed.banner.warnings.length).toBeGreaterThanOrEqual(1);
    const joined = parsed.banner.warnings.join('\n');
    expect(joined).toContain('fresh-install');
    expect(joined).toContain('upgrade-from-v0.18');

    stdoutLines.length = 0;
    runFriction(['diff', '--base', 'scen-a', '--compare', 'scen-b']);
    const out = stdoutLines.join('');
    expect(out).toContain('WARN');
    expect(out).toContain('fresh-install');
    expect(out).toContain('upgrade-from-v0.18');
  });

  test('banner carries agent, scenario, and gbrain version from the start markers', () => {
    startMarker('meta-a', { agent: 'hermes', scenario: 'fresh-install' });
    startMarker('meta-b', { agent: 'openclaw', scenario: 'fresh-install' });
    const { parsed } = diffJson('meta-a', 'meta-b');
    expect(parsed.banner.base.agent).toBe('hermes');
    expect(parsed.banner.compare.agent).toBe('openclaw');
    expect(parsed.banner.base.scenario).toBe('fresh-install');
    expect(typeof parsed.banner.base.gbrain_version).toBe('string');
    // Same version on both sides (same process) → no version warning.
    expect(parsed.banner.warnings).toEqual([]);
  });
});

describe('identity normalization', () => {
  test('case, whitespace, and redaction differences collapse to the same identity', () => {
    startMarker('norm-a', { agent: 'scripted' });
    friction('norm-a', 'install', `Engine   Init FAILED at ${process.cwd()}/x.ts`, 'error');
    startMarker('norm-b', { agent: 'scripted' });
    friction('norm-b', 'install', 'engine init failed at <CWD>/x.ts', 'error');

    const diff = computeFrictionDiff('norm-a', 'norm-b');
    expect(diff.unique_to_base).toEqual([]);
    expect(diff.unique_to_compare).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test('messages sharing the first 80 normalized chars are the same identity', () => {
    const prefix = 'p'.repeat(80);
    startMarker('pre-a', { agent: 'scripted' });
    friction('pre-a', 'query', prefix + ' tail one', 'error');
    startMarker('pre-b', { agent: 'scripted' });
    friction('pre-b', 'query', prefix + ' completely different tail', 'error');

    const diff = computeFrictionDiff('pre-a', 'pre-b');
    expect(diff.unique_to_base).toEqual([]);
    expect(diff.unique_to_compare).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

describe('CLI dispatch', () => {
  test('diff with base and compare run-ids returns 0', () => {
    startMarker('cli-a', { agent: 'scripted' });
    startMarker('cli-b', { agent: 'scripted' });
    expect(runFriction(['diff', '--base', 'cli-a', '--compare', 'cli-b'])).toBe(0);
  });

  test('missing compare flag is a usage error, exit 2', () => {
    const code = runFriction(['diff', '--base', 'cli-a']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toContain('usage');
  });

  test('missing both flags is a usage error, exit 2', () => {
    expect(runFriction(['diff'])).toBe(2);
  });
});

describe('identity hardening (adversarial-gate pins)', () => {
  test('a delight→friction flip surfaces as unique-to-each, never equality', () => {
    startMarker('run-base', { agent: 'scripted' });
    logFriction({ runId: 'run-base', phase: 'query', message: 'results ranked well', kind: 'delight', source: 'claw' });
    startMarker('run-cmp', { agent: 'scripted' });
    logFriction({ runId: 'run-cmp', phase: 'query', message: 'results ranked well', kind: 'friction', severity: 'confused', source: 'claw' });

    const { code, parsed } = diffJson('run-base', 'run-cmp');
    expect(code).toBe(0);
    expect(parsed.changed).toEqual([]);
    expect(parsed.unique_to_base.length).toBe(1);
    expect(parsed.unique_to_base[0].kind).toBe('delight');
    expect(parsed.unique_to_compare.length).toBe(1);
    expect(parsed.unique_to_compare[0].kind).toBe('friction');
  });

  test('severity redistribution with equal totals and equal severity sets is a reported difference', () => {
    startMarker('run-base', { agent: 'scripted' });
    friction('run-base', 'import', 'import warned', 'error');
    friction('run-base', 'import', 'import warned', 'error');
    friction('run-base', 'import', 'import warned', 'nit');
    startMarker('run-cmp', { agent: 'scripted' });
    friction('run-cmp', 'import', 'import warned', 'error');
    friction('run-cmp', 'import', 'import warned', 'nit');
    friction('run-cmp', 'import', 'import warned', 'nit');

    const { code, parsed } = diffJson('run-base', 'run-cmp');
    expect(code).toBe(0);
    expect(parsed.changed.length).toBe(1);
    expect(parsed.changed[0].severity_changed).toBe(true);
    expect(parsed.changed[0].count_changed).toBe(false);
    expect(parsed.changed[0].base_severity_counts).toEqual({ error: 2, nit: 1 });
    expect(parsed.changed[0].compare_severity_counts).toEqual({ error: 1, nit: 2 });
  });

  test('volatile digits (durations, retry counts) do not split identities across runs', () => {
    startMarker('run-base', { agent: 'scripted' });
    friction('run-base', 'agent_invoke', 'agent exited with code 1 after 5123ms');
    startMarker('run-cmp', { agent: 'scripted' });
    friction('run-cmp', 'agent_invoke', 'agent exited with code 1 after 98764ms');

    const { code, parsed } = diffJson('run-base', 'run-cmp');
    expect(code).toBe(0);
    expect(parsed.unique_to_base).toEqual([]);
    expect(parsed.unique_to_compare).toEqual([]);
    expect(parsed.changed).toEqual([]);
  });
});
