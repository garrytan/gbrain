/**
 * stampRowTrust reads the row trust through the typed `readRowTrustRows` member.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a capability refusal from `readRowTrustRows` (an engine that does not serve a table refuses it) reaches the
 *    caller; any other read failure keeps the fail-open label `unknown` / `unrecorded`; a row the read returns is
 *    labeled with its tier, origin, flag and contested proposal.
 *  - Regression: a catch-all would turn a capability refusal into rows labeled `unrecorded`, which a reader cannot tell
 *    apart from rows a legacy writer left unstamped.
 *  - Why existing coverage misses it: fence-chunk-trust-read.test.ts runs on SQL engines, which never refuse.
 *  - Seam: a fake engine with only `readRowTrustRows`, the one member stampRowTrust calls.
 */
import { describe, expect, test } from 'bun:test';
import { stampRowTrust } from '../src/core/eligibility/stamp.ts';
import type { RowTrustLookup, RowTrustRow } from '../src/core/engine.ts';

const fake = (read: (lookup: RowTrustLookup) => Promise<RowTrustRow[]>) => ({ readRowTrustRows: read });
const refusal = () => Object.assign(new Error('readRowTrustRows (table facts)'), { code: 'engine_capability_missing' });

describe('stampRowTrust', () => {
  test('passes a capability refusal on instead of labeling the rows unrecorded', async () => {
    const engine = fake(async () => { throw refusal(); });
    await expect(stampRowTrust(engine, 'facts', [{ id: 1 }], r => r.id)).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  test('labels the rows unknown and unrecorded when the read fails another way', async () => {
    const engine = fake(async () => { throw new Error('connection reset'); });
    expect(await stampRowTrust(engine, 'takes', [{ id: 1 }], r => r.id)).toEqual([{ id: 1, trust_tier: 'unknown', origin: 'unrecorded' }]);
  });

  test('labels each row with the trust the read returns, once per distinct id', async () => {
    const lookups: RowTrustLookup[] = [];
    const engine = fake(async (lookup) => {
      lookups.push(lookup);
      return [{ id: 7, trust_tier: 'agent_written', write_origin: { channel: 'agent' }, flagged: true, contested: null, precedence: null }];
    });
    const out = await stampRowTrust(engine, 'timeline_entries', [{ id: 7 }, { id: '7' }, { id: 8 }], r => r.id);
    expect(lookups).toEqual([{ table: 'timeline_entries', ids: [7, 8] }]);
    expect(out.map(r => r.trust_tier)).toEqual(['agent_written', 'agent_written', 'unknown']);
    expect(out[2]).toMatchObject({ origin: 'unrecorded' });
    expect(out[0]).not.toMatchObject({ origin: 'unrecorded' });
  });
});
