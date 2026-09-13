// v0.39 T16 — aggregator unit test.
// Pins the pass-criterion codex finding #9 demanded: filing accuracy
// delta is the gate, NOT manifest correctness.
//
// E4 (v0.48.4.0) added the runner contract: until the fixture-brain harness
// lands, running the eval must read as an honest not-implemented verdict
// (#4198 shape), never as a pass or a data-bearing inconclusive.

import { describe, test, expect, spyOn } from 'bun:test';
import {
  aggregateVerdict,
  parseArgs,
  runEvalSchemaAuthoring,
  runEvalSchemaAuthoringCli,
} from '../src/commands/eval-schema-authoring.ts';

describe('v0.39 T16 — eval-schema-authoring aggregator', () => {
  test('pass when baseline already high + no suggestions needed', () => {
    const v = aggregateVerdict(0.95, 0.95, 0, 0);
    expect(v.verdict).toBe('pass');
  });

  test('pass when filing accuracy improves >=10pp', () => {
    const v = aggregateVerdict(0.4, 0.6, 5, 1);
    expect(v.verdict).toBe('pass');
    expect(v.delta).toBeCloseTo(0.2, 2);
  });

  test('inconclusive when delta improvement is <10pp', () => {
    const v = aggregateVerdict(0.6, 0.65, 3, 0);
    expect(v.verdict).toBe('inconclusive');
  });

  test('inconclusive when baseline is low but no suggestions returned', () => {
    const v = aggregateVerdict(0.4, 0.4, 0, 0);
    expect(v.verdict).toBe('inconclusive');
  });

  test('fail when filing accuracy regresses', () => {
    const v = aggregateVerdict(0.7, 0.55, 5, 3);
    expect(v.verdict).toBe('fail');
    expect(v.reasoning).toContain('REGRESSED');
  });

  test('parseArgs --fixture + --source + --json', () => {
    const a = parseArgs(['--fixture', '/tmp/brain', '--source', 'dept-x', '--json']);
    expect(a.fixture).toBe('/tmp/brain');
    expect(a.source).toBe('dept-x');
    expect(a.json).toBe(true);
  });

  test('parseArgs accepts --source-id alias', () => {
    const a = parseArgs(['--source-id', 'alt']);
    expect(a.source).toBe('alt');
  });
});

describe('E4 — eval-schema-authoring runner is an honest not-implemented scaffold (#4198 shape)', () => {
  test('runEvalSchemaAuthoring never reads as a pass for work it did not run', async () => {
    const r = await runEvalSchemaAuthoring([]);
    expect(r.schema_version).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('not_implemented');
    expect(r.details.fixture).toBeNull();
    expect(r.details.planned).toBeDefined();
  });

  test('records --fixture / --source in details without evaluating', async () => {
    const r = await runEvalSchemaAuthoring(['--fixture', '/tmp/brain', '--source', 'dept-x']);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('not_implemented');
    expect(r.details.fixture).toBe('/tmp/brain');
    expect(r.details.source).toBe('dept-x');
  });

  test('CLI entry exits 1 for the scaffold (json + human) and 0 only for --help', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runEvalSchemaAuthoringCli(['--json'])).toBe(1);
      const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(payload.ok).toBe(false);
      expect(payload.status).toBe('not_implemented');

      expect(await runEvalSchemaAuthoringCli([])).toBe(1);
      expect(err.mock.calls.some((c) => String(c[0]).includes('NOT_IMPLEMENTED'))).toBe(true);

      expect(await runEvalSchemaAuthoringCli(['--help'])).toBe(0);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
