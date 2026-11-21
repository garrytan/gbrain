/**
 * `gbrain agent register --reissue` rotates a client's secret from the hash it read: two reissues that read the same
 * secret cannot both succeed.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: of two concurrent reissues that read the same secret hash, exactly one succeeds and the stored hash is the
 *    hash of the secret it returned; a reissue made from a hash that is no longer stored is refused and leaves the newer
 *    secret in place. On every engine arm (PGLite always; Postgres with DATABASE_URL).
 *  - Regression: the rotation used to be an advisory lock around an unconditional UPDATE, so both reissues succeeded, the
 *    second replaced the first's secret, and the secret the first caller was shown stopped working at once. The cases
 *    below fail on that code (both reissues succeed) and pass on the compare-and-set.
 *  - Why existing coverage misses it: test/agent-register.test.ts reissues one client one at a time.
 *  - Seam: none. The real `rotateClientSecret` on real engines; the client row is seeded with one INSERT.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './engine-parity/harness.ts';
import { testBackends } from './helpers/test-backends.ts';
import { rotateClientSecret } from '../src/commands/agent-register.ts';
import { hashToken } from '../src/core/utils.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const H0 = hashToken('gbrain_cs_seed');

const seed = (engine: BrainEngine) => engine.executeRaw(
  `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, grant_types, scope) VALUES ('rot', 'rot', $1, '{client_credentials}'::text[], 'read')`, [H0]);
const stored = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ client_secret_hash: string }>(`SELECT client_secret_hash FROM oauth_clients WHERE client_id = 'rot'`))[0]!.client_secret_hash;
// The reissue passes the hash it read; rotateClientSecret(engine, clientId, readSecretHash).
const reissue = (engine: BrainEngine, readHash: string) => rotateClientSecret(engine, 'rot', readHash);

describe('agent register --reissue rotation', () => {
  parityTest('two concurrent reissues that read the same secret: exactly one wins and its secret is the stored one', { methods: [] }, async (engine) => {
    await seed(engine);
    const settled = await Promise.allSettled([reissue(engine, H0), reissue(engine, H0)]);
    const won = settled.filter((s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled').map(s => s.value);
    expect(won.length).toBe(1);
    expect(await stored(engine)).toBe(hashToken(won[0]!));
    return { winners: won.length, losers: settled.length - won.length };
  });

  parityTest('a reissue made from a secret that is no longer stored is refused and leaves the newer secret', { methods: [] }, async (engine) => {
    await seed(engine);
    const first = await reissue(engine, H0);
    const stale = await reissue(engine, H0).then(() => 'accepted', (e: unknown) => (e as { code?: string }).code ?? String(e));
    expect(stale).not.toBe('accepted');
    expect(await stored(engine)).toBe(hashToken(first));
    return { stale: stale === 'accepted' ? stale : 'refused' };
  });
});
