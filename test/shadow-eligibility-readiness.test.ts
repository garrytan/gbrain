/**
 * Readiness criterion 11 reads the eligibility producer (src/shadow/eligibility.ts -> src/core/engine-swap/readiness.ts).
 *
 * Protects: one observed writer host with no unknown writer path, a personal brain and a preview target pass
 * criterion 11; two hosts refuse `multiple_writer_hosts`; evidence of an unseen writer refuses
 * `writer_coverage_unknown`; with no engine passed in, or a SELECT that throws, the writer fields are absent and
 * criterion 11 is `missing` (NOT READY), never a pass. Regression it catches: a producer field name that drifts from
 * the ShadowStatus interface, or an omission that reads as zero hosts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { buildEligibilityStatus } from '../src/shadow/eligibility.ts';
import { WriterObserver } from '../src/shadow/writer-observations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let primary: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-elig-readiness-'));
});

afterAll(async () => {
  await primary.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(primary);
  await primary.executeRaw('DELETE FROM engine_writer_observations');
});

async function observe(host: string, app: string): Promise<void> {
  const o = new WriterObserver({ primary, dir, identity: () => ({ hostId: host, applicationName: app, processKind: 'cli', gbrainVersion: 'test' }) });
  o.note();
  while (o.inFlight) await o.inFlight;
  o.stop();
}

async function criterion11(input: { engine?: BrainEngine; unknown?: number; brain?: string; target?: string | null }) {
  const out = await buildEligibilityStatus({
    dir, state: null, engine: input.engine, source: { name: 'test', unknownPaths: () => input.unknown ?? 0 },
    brainId: () => input.brain ?? 'host', addonTarget: () => (input.target === undefined ? 'linux-x64-glibc' : input.target),
  });
  const verdict = evaluateReadiness({ eligibility: out.eligibility } as ShadowStatus);
  return { out, verdict, row: verdict.criteria.find(c => c.n === 11)! };
}

describe('criterion 11 from the eligibility producer', () => {
  test('one host, no unknown path, a personal brain on a preview target passes', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { row } = await criterion11({ engine: primary });
    expect(row.state).toBe('pass');
  });

  test('two writer hosts refuse multiple_writer_hosts', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    await observe('22222222-2222-4222-8222-222222222222', 'gbrain sync:2:bbbbbbbb');
    const { row, verdict } = await criterion11({ engine: primary });
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('multiple_writer_hosts');
  });

  test('evidence of an unseen writer refuses writer_coverage_unknown', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { row, verdict } = await criterion11({ engine: primary, unknown: 1 });
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('no engine passed in: the writer fields are absent and criterion 11 is missing, NOT READY', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { out, row, verdict } = await criterion11({});
    expect('writer_hosts_7d' in out.eligibility).toBe(false);
    expect(row.state).toBe('missing');
    expect(verdict.verdict).toBe('NOT READY');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('a SELECT that throws: the same missing row, never a pass', async () => {
    const failing = { executeRaw: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } } as unknown as BrainEngine;
    const { row, verdict } = await criterion11({ engine: failing });
    expect(row.state).toBe('missing');
    expect(verdict.verdict).toBe('NOT READY');
  });

  test('no observed writer is missing evidence, not one host', async () => {
    const { row } = await criterion11({ engine: primary });
    expect(row.state).toBe('missing');
  });

  test('a mounted team brain refuses team_brain; a musl host is not a preview target', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    expect((await criterion11({ engine: primary, brain: 'team-a' })).verdict.reason).toBe('team_brain');
    expect((await criterion11({ engine: primary, target: 'linux-x64-musl' })).row.state).toBe('fail');
  });
});
