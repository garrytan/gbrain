/**
 * BrainEngine parity — the content-setup source read of `gbrain init` (engine-sql/content-setup.ts
 * `readContentSetupSource`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `readContentSetupSource(id)` answers `{ id, incarnation, local_path }` of a registered source that is not
 *    archived, and null for an id no source has. The same answer on every engine arm (incarnations compared by shape).
 *  - Regression: setupSharedBrainContent read the source through executeRaw, so `gbrain init` on the Rust engine
 *    stopped on the raw-SQL refusal before it could record even a database-only receipt.
 *  - Why existing coverage misses it: init ran on PGLite and Postgres only.
 *  - Seam: none. Real engines, typed members only. `readFreshContentDatabase` is read before initSchema, which no
 *    parity brain can be; test/rust-init-db-only.serial.test.ts covers it through a fresh and a repeated init.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('engine parity: content setup', () => {
  parityTest('readContentSetupSource answers a live source with its incarnation and path, and null for no source', {
    methods: ['readContentSetupSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'notes-example');
    const read = async (id: string) => {
      const row = await engine.readContentSetupSource(id);
      return row && { ...row, incarnation: UUID.test(row.incarnation) ? 'uuid' : row.incarnation };
    };
    const out = { default: await read('default'), added: await read('notes-example'), missing: await read('missing-example') };
    expect(out.default).toEqual({ id: 'default', incarnation: 'uuid', local_path: null });
    expect(out.missing).toBeNull();
    return out;
  });
});
