/**
 * BrainEngine parity — the repair kinds' source reads (batch 2 of the repair-on-Rust plan, push 3).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain repair` unwithdrawn-facts, captured-facts, fact-claim-dates and url-clone-fences preview the
 *    same plan on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) on a brain with two
 *    live sources and an archived one, for the whole brain and for one `--source`; and `readSourceStates` returns the
 *    known sources of a list (archived ones included, unknown ids dropped) in byte order of id.
 *  - Regression: these kinds counted, listed or read their sources (`count(*) FROM sources WHERE archived IS NOT
 *    TRUE`, `SELECT id FROM sources ...`, `SELECT id, incarnation ... WHERE id = ANY($1)`) through `executeRaw`, which
 *    a Rust brain refuses, so each preview stopped at that read there. The archived source tells a count of live
 *    sources from a count of all of them: the printed `--source` narrowing depends on it.
 *  - Why existing coverage misses it: the kinds' own tests (test/repair-*.test.ts) run on PGLite or Postgres only,
 *    and the runner's parity file (repair-runner.test.ts) previews on empty brains only.
 *  - Seam: none. Generated values (the brain id, incarnations, hashes, timestamps) are compared by shape. Each
 *    kind's apply on rows it fixes is its own batch's case (the 67-kind map, rust/docs/store/repair-bookkeeping.md).
 */
import { describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { readSourceStates } from '../../src/core/source-rows.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;

/** A value with the generated parts reduced to their shape: SHA-256 digests, UUIDs and timestamps. */
function norm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(UUID, '<uuid>').replace(ISO, '<ts>'));
}

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return norm({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } });
}

const quiet = { info() {}, warn() {}, error() {} } as never;

/** `gbrain repair <kind>` (a preview) for the whole brain, or for one `--source`. */
async function preview(engine: BrainEngine, kind: RepairKind, source?: string) {
  const scope = await resolveRepairScope(engine, source);
  return shape(await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true }));
}

/** The checkouts' parent: fixed, so a path a preview prints is the same on every arm. */
const ROOT = '/var/tmp/gbrain-parity-source-reads';

/** Three live sources (`default`, `side` and `zeta`, the last two with checkouts) and an archived one (`old`). */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1], root: string) {
  for (const id of ['side', 'zeta', 'old']) {
    mkdirSync(join(root, id), { recursive: true });
    await createSource(engine, backend, id, {}, join(root, id));
  }
  await archiveSource(engine, backend, 'old');
}

describe('engine parity: repair source reads on a brain with an archived source', () => {
  parityTest('repair previews count and list the live sources the same, for the brain and for one source', {
    methods: ['listAllSources', 'listSourceIncarnations', 'readSourceIncarnation', 'readPersistenceBrainId'], timeout: 60_000,
  }, async (engine, backend) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-source-reads-home-'));
    const root = ROOT;
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await seed(engine, backend, root);
        const out: Record<string, unknown> = {};
        for (const kind of ['unwithdrawn-facts', 'captured-facts', 'url-clone-fences'] as const) {
          out[kind] = { brain: await preview(engine, kind), side: await preview(engine, kind, 'side') };
        }
        out['fact-claim-dates'] = { side: await preview(engine, 'fact-claim-dates', 'side') };
        return out;
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  parityTest('readSourceStates returns the known sources of a list, archived ones included, in byte order of id', {
    methods: ['readSourceState'], timeout: 60_000,
  }, async (engine, backend) => {
    const root = ROOT;
    try {
      await seed(engine, backend, root);
      const rows = await readSourceStates(engine, ['zeta', 'old', 'gone', 'side', 'zeta']);
      expect(rows.map(row => row.id)).toEqual(['old', 'side', 'zeta']);
      return norm(rows);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});
