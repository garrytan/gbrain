/**
 * D8 adoption funnel: off by default (nothing written), counts per stage from
 * the local record, no content fields, and the pinned `--funnel --json` shape.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __setFunnelPathForTests, deleteFunnel, enableFunnel, funnelEnabled, readFunnelReport, recordFunnelEvent,
  recordRecallOutcome, recordRememberOutcome, type FunnelEvent,
} from '../src/core/funnel.ts';
import { runStatusFunnel } from '../src/commands/status-funnel.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-funnel-'));
let dir: string;
let path: string;
let n = 0;

beforeEach(() => {
  dir = join(root, `case-${n++}`);
  path = join(dir, 'funnel.jsonl');
  __setFunnelPathForTests(path);
});
afterEach(() => __setFunnelPathForTests(null));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = () => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, string>);
const events = () => lines().map(l => l.event);
const ALL: FunnelEvent[] = ['clean_install', 'import', 'save', 'recall', 'correction', 'withdrawal'];

describe('default off', () => {
  test('no record file: every recorder writes nothing and creates no directory', () => {
    for (const e of ALL) recordFunnelEvent(e);
    recordRememberOutcome({ status: 'superseded' });
    recordRememberOutcome({ status: 'inserted' });
    recordRecallOutcome([{ slug: 'x' }]);
    expect(funnelEnabled()).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test('the report says off with zero counts', () => {
    expect(readFunnelReport()).toEqual({
      schema_version: 1, enabled: false, enabled_on: null,
      stages: [
        { stage: 'clean_install', count: 0, first_on: null },
        { stage: 'import_useful_data', count: 0, first_on: null },
        { stage: 'recall_new_session', count: 0, first_on: null },
        { stage: 'correction_applied', count: 0, first_on: null },
        { stage: 'withdrawal_applied', count: 0, first_on: null },
        { stage: 'use_after_seven_days', count: 0, first_on: null },
      ],
    });
  });
});

describe('recording', () => {
  test('enable writes one line; delete removes the record and turns recording off', () => {
    enableFunnel();
    enableFunnel();
    expect(events()).toEqual(['enabled']);
    expect(deleteFunnel()).toBe(true);
    recordFunnelEvent('correction');
    expect(existsSync(path)).toBe(false);
    expect(deleteFunnel()).toBe(false);
  });

  test('save and recall are recorded once per session; the other events every time', () => {
    enableFunnel();
    for (let i = 0; i < 3; i++) for (const e of ALL) recordFunnelEvent(e);
    const counts = Object.fromEntries(ALL.map(e => [e, events().filter(x => x === e).length]));
    expect(counts).toEqual({ clean_install: 3, import: 3, save: 1, recall: 1, correction: 3, withdrawal: 3 });
  });

  test('remember outcomes: superseded is a correction, inserted or duplicate a save, a refusal nothing', () => {
    enableFunnel();
    recordRememberOutcome({ status: 'superseded', id: '7' });
    recordRememberOutcome({ status: 'inserted' });
    recordRememberOutcome({ batch: true });
    recordRememberOutcome(null);
    expect(events()).toEqual(['enabled', 'correction', 'save']);
  });

  test('a recall counts only when it returned something (search rows, recall facts or results)', () => {
    enableFunnel();
    recordRecallOutcome([]);
    recordRecallOutcome({ facts: [], results: [] });
    expect(events()).toEqual(['enabled']);
    recordRecallOutcome({ facts: [], results: [{}] });
    expect(events()).toEqual(['enabled', 'recall']);
  });

  test('lines hold an event name and two timestamps, nothing else', () => {
    enableFunnel();
    for (const e of ALL) recordFunnelEvent(e);
    recordRememberOutcome({ status: 'superseded', fact: 'Alice Example left acme-example.', entity_slug: 'people/alice-example' });
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const l of lines()) {
      expect(Object.keys(l).sort()).toEqual(['at', 'event', 'session']);
      expect(l.at).toMatch(iso);
      expect(l.session).toMatch(iso);
    }
    expect(readFileSync(path, 'utf8')).not.toMatch(/alice|acme|people\//i);
  });
});

describe('counts per stage', () => {
  const write = (rows: Array<[FunnelEvent, string, string]>) =>
    writeFileSync(path, rows.map(([event, at, session]) => JSON.stringify({ event, at, session })).join('\n') + '\n{"torn":\n');

  test('each stage counts from the record; a recall counts only in a later session than a write', () => {
    mkdirSync(dir, { recursive: true });
    const s1 = '2026-10-01T09:00:00.000Z', s2 = '2026-10-02T09:00:00.000Z', s3 = '2026-10-09T09:00:00.000Z', s4 = '2026-10-10T09:00:00.000Z';
    write([
      ['enabled', '2026-10-01T08:59:00.000Z', '2026-10-01T08:58:00.000Z'],
      ['clean_install', '2026-10-01T09:00:01.000Z', s1],
      ['recall', '2026-10-01T09:00:02.000Z', s1],
      ['import', '2026-10-01T09:00:03.000Z', s1],
      ['recall', '2026-10-01T09:30:00.000Z', '2026-10-01T09:29:00.000Z'],
      ['recall', '2026-10-02T09:00:05.000Z', s2],
      ['correction', '2026-10-02T09:00:06.000Z', s2],
      ['withdrawal', '2026-10-02T09:00:07.000Z', s2],
      ['recall', '2026-10-09T09:00:01.000Z', s3],
      ['save', '2026-10-09T10:00:00.000Z', s3],
      ['recall', '2026-10-10T09:00:01.000Z', s4],
      ['withdrawal', '2026-10-10T09:00:02.000Z', s4],
    ]);
    expect(readFunnelReport()).toEqual({
      schema_version: 1, enabled: true, enabled_on: '2026-10-01',
      stages: [
        { stage: 'clean_install', count: 1, first_on: '2026-10-01' },
        { stage: 'import_useful_data', count: 1, first_on: '2026-10-01' },
        { stage: 'recall_new_session', count: 4, first_on: '2026-10-01' },
        { stage: 'correction_applied', count: 1, first_on: '2026-10-02' },
        { stage: 'withdrawal_applied', count: 2, first_on: '2026-10-02' },
        { stage: 'use_after_seven_days', count: 2, first_on: '2026-10-09' },
      ],
    });
  });

  test('without a clean install, seven days count from when recording was turned on', () => {
    mkdirSync(dir, { recursive: true });
    write([
      ['enabled', '2026-10-03T08:00:00.000Z', '2026-10-03T08:00:00.000Z'],
      ['recall', '2026-10-09T23:00:00.000Z', '2026-10-09T23:00:00.000Z'],
      ['recall', '2026-10-10T00:30:00.000Z', '2026-10-10T00:30:00.000Z'],
    ]);
    const r = readFunnelReport();
    expect(r.stages.find(s => s.stage === 'use_after_seven_days')).toEqual({ stage: 'use_after_seven_days', count: 1, first_on: '2026-10-10' });
    expect(r.stages.find(s => s.stage === 'recall_new_session')!.count).toBe(0);
  });
});

describe('gbrain status --funnel', () => {
  const run = (args: string[]) => {
    let out = '', err = '';
    const { exitCode } = runStatusFunnel(['--funnel', ...args], { stdout: s => { out += s; }, stderr: s => { err += s; } });
    return { exitCode, out, err };
  };

  test('off by default: --json reports enabled false and creates nothing', () => {
    const r = run(['--json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.out)).toEqual(readFunnelReport());
    expect(JSON.parse(r.out).enabled).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(run([]).out).toContain('gbrain status --funnel --enable');
  });

  test('--enable, view, --delete', () => {
    expect(run(['--enable', '--json']).exitCode).toBe(0);
    expect(funnelEnabled()).toBe(true);
    recordFunnelEvent('correction');
    const json = JSON.parse(run(['--json']).out);
    expect(json.stages.find((s: { stage: string }) => s.stage === 'correction_applied').count).toBe(1);
    expect(JSON.stringify(json)).not.toContain(dir);
    expect(run([]).out).toContain('correction_applied');
    expect(run(['--delete']).out).toContain('recording is off');
    expect(funnelEnabled()).toBe(false);
  });

  test('usage errors exit 2 and change nothing', () => {
    expect(run(['--enable', '--delete']).exitCode).toBe(2);
    expect(run(['--section', 'queue']).exitCode).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });
});
