/**
 * BrainEngine parity — the remote read policy read (search/private-visibility.ts readRemotePolicyNow): the config
 * keys that say whether privacy is relaxed, whether the brain holds member-access restrictions, who the owner member
 * is, and whom the brain serves.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readRemotePolicyNow returns the same policy on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), on a fresh brain and on a brain that set
 *    every key, through the typed keyed config read (`getConfigValues`).
 *  - Regression: an engine that cannot run the read falls back to the fail-closed policy (restricted, whom the brain
 *    serves unknown). Every remote write guard then judges the caller under a widened policy, so remote add_link,
 *    add_timeline_entry, extract_entities and other writes refuse on that engine although nothing is restricted.
 *  - Why existing coverage misses it: the read ran its own SELECT through `executeRaw`, which the Rust engine
 *    refuses (D18), and the fallback swallowed the refusal, so no test saw it fail.
 *  - Seam: none. Real engines through the parity harness.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import {
  ACCESS_RESTRICTIONS_KEY, MEMBERS_READ_LINEAGE_KEY, OWNER_MEMBER_KEY, OWNER_READS_RESTRICTED_KEY, readRemotePolicyNow,
  REMOTE_PRIVATE_PAGES_KEY, REQUESTER_SCOPE_ENFORCE_KEY, schemaVersionNow, SERVES_KEY, SERVES_SINCE_KEY,
} from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

/**
 * The policy without the schema version. The harness PGLite brain carries no `version` config row while a fresh Rust
 * brain stamps one, so the version is a fixture difference, not a policy one; schemaVersionNow is checked to agree.
 */
async function policyOf(engine: Parameters<typeof readRemotePolicyNow>[0]) {
  const { schemaVersion: _schemaVersion, ...policy } = await readRemotePolicyNow(engine);
  return { policy };
}

describe('engine parity: remote read policy', () => {
  parityTest('readRemotePolicyNow reads a fresh brain as unrestricted, with whom it serves known', {
    methods: ['getConfigValues'],
  }, async (engine) => {
    const fresh = await policyOf(engine);
    expect(fresh.policy).toEqual({
      privacyRelaxed: process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1', restricted: false, ownerMember: null,
      ownerReadsRestricted: false, membersReadLineage: false, serves: { several: false, from: 'members', since: null, enforce: true },
    });
    expect((await schemaVersionNow(engine)).schemaVersion).toBe((await readRemotePolicyNow(engine)).schemaVersion);
    return fresh;
  });

  parityTest('readRemotePolicyNow reads every policy key a brain set', {
    methods: ['setConfig', 'getConfigValues'],
  }, async (engine) => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    await engine.setConfig(ACCESS_RESTRICTIONS_KEY, '1');
    await engine.setConfig(OWNER_MEMBER_KEY, 'alice-example');
    await engine.setConfig(OWNER_READS_RESTRICTED_KEY, '1');
    await engine.setConfig(MEMBERS_READ_LINEAGE_KEY, '1');
    await engine.setConfig(SERVES_KEY, 'several');
    await engine.setConfig(SERVES_SINCE_KEY, '2026-01-02T03:04:05Z');
    await engine.setConfig(REQUESTER_SCOPE_ENFORCE_KEY, 'off');
    const set = await policyOf(engine);
    expect(set.policy).toEqual({
      privacyRelaxed: true, restricted: true, ownerMember: 'alice-example', ownerReadsRestricted: true,
      membersReadLineage: true, serves: { several: true, from: 'config', since: Date.parse('2026-01-02T03:04:05Z') / 1000, enforce: false },
    });
    return set;
  });
});
