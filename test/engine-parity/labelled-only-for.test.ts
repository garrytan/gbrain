/**
 * BrainEngine parity: `labelledOnlyFor` (src/core/access/labelled-only.ts), the check every remote read runs to decide
 * whether its caller's member carries the labelled-only grant.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member carries the grant exactly when its access_members row says so (disabled and removed members
 *    included, as the SQL reads them); a member without it, an unknown member and a caller with no member never do.
 *  - Regression: the check read access_members with raw SQL and counted any failure as "yes". On a Rust brain the raw
 *    read is refused, so every bound member read as labelled-only and every remote read by a member was refused
 *    (test/engine-parity/remote-access-matrix.test.ts).
 *  - Why existing coverage misses it: test/access-labelled-only.test.ts runs PGLite and Postgres only.
 *  - Seam: none; the members are written through the access member commands.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember } from '../../src/core/access/members.ts';
import { labelledOnlyFor, setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: labelledOnlyFor', () => {
  parityTest('a member is labelled-only exactly when its row carries the grant', {
    methods: ['hasLabelledOnlyMemberAmong'],
  }, async (engine) => {
    for (const id of ['bot-example', 'bob-example']) await addMember(engine, id, { remote: false });
    expect(await setMemberLabelledOnly(engine, 'bot-example', true, { remote: false })).toMatchObject({ changed: true });
    const got = {
      bot: await labelledOnlyFor(engine, [['member:bot-example']]),
      bob: await labelledOnlyFor(engine, [['member:bob-example']]),
      both: await labelledOnlyFor(engine, [['member:bob-example'], ['member:bot-example']]),
      unknown: await labelledOnlyFor(engine, [['member:ghost-example']]),
      noMember: await labelledOnlyFor(engine, [['group:team-a', 'token:x']]),
    };
    expect(got).toEqual({ bot: true, bob: false, both: true, unknown: false, noMember: false });
    return got;
  });
});
