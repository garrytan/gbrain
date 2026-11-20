/**
 * Engine parity for the shared pre-admission reads that ran through `executeRaw` outside page-mutations.ts: every live
 * source's import roots (persistence/import-prepare.ts `assertImportPaths`) and the whole config table a preparation
 * reads once (persistence/config-snapshot.ts `preparationConfigView`). The brain identity reads of
 * company-brain/admission.ts, company-brain/runtime.ts and skillpack/shared-brain-bridge.ts moved to the existing
 * `readPersistenceBrainId`, served on every arm (its own parity file covers it).
 *
 * Fail-first: on rust-engine/shared-read-callers' base ace4b8a225 case 1 fails on every arm (listSourceImportRoots and
 * readConfigTable did not exist). With the base config-snapshot.ts and import-prepare.ts, cases 2 and 3 fail on the
 * SQL arms (the declared typed read is never called). On the Rust arm each read was an `executeRaw`, which the Rust
 * engine refuses (raw_sql): case 3 fails on that refusal, and case 2 ends on it as a stop, never as equal.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) `listSourceImportRoots(hostId)` answers every unarchived source with its own local path and, when its
 *    binding is at the source's current incarnation, the binding's relative path and host `hostId`'s worktree path
 *    (null otherwise); `readConfigTable()` answers every stored config row byte for byte, the same rows as
 *    `getAllConfig` outside a request snapshot; (2) a preparation's config view answers `getConfig`, `getAllConfig`
 *    and the keyed `SELECT value FROM config WHERE key=$1` from that one read; (3) a managed import of a file inside
 *    another live source's root, its own local path or its bound worktree on this host, refuses `source_changed`
 *    naming that source, and a file under no other root passes.
 *  - Regression: both reads were `executeRaw` calls; the Rust engine refuses raw SQL, so a managed sync's config view
 *    and a managed import's root check failed there.
 *  - Why existing coverage misses it: test/import-*.test.ts and the managed sync tests run on the SQL engines only.
 *  - Seam: none. Real engines, the real config view and the real import root check; bindings are seeded through the
 *    claim's store (worktreeClaimStore), as write-misc.test.ts does.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktreeBinding } from '../../src/core/engine-sql/worktree-claim.ts';
import { preparationConfigView } from '../../src/core/persistence/config-snapshot.ts';
import { assertImportPaths } from '../../src/core/persistence/import-prepare.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';

const { parityTest } = parityArms(testBackends());

const HOST_A = '00000000-0000-4000-8000-00000000000a';
const HOST_B = '00000000-0000-4000-8000-00000000000b';
/** A value with spaces, a newline, a quote and non-ASCII text: the reads must hand it back byte for byte. */
const ODD_VALUE = ' leading and trailing \n"quoted" — café ';

/** A claimed binding of `sourceId` on `hostId` at `localPath`; `incarnation` binds an incarnation the source moved past. */
async function bindWorktree(engine: BrainEngine, sourceId: string, hostId: string, localPath: string, incarnation?: string): Promise<void> {
  await claimWorktreeBinding(engine, async store => {
    const source = await store.lockSource(sourceId);
    const id = randomUUID();
    await store.insertWorktree({ id, ownerHostId: hostId, ownerEpoch: 1, topologyGeneration: 1, state: 'active', manifest: {} });
    await store.insertSourceBinding({ sourceId, incarnation: incarnation ?? source!.incarnation, worktreeId: id, relativePath: 'notes', topologyGeneration: 1 });
    await store.insertHostBinding({ worktreeId: id, hostId, localPath, coordinationPath: `${localPath}-coord`, gitDurability: 'enabled' });
  });
}

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const byKey = (rows: Array<{ key: string; value: string }>) => [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
/** The refusal a call ended on (its code, message and fix, with the fixture root `base` written as `<base>`); null when it passed. */
const refusalOf = async (base: string, run: () => Promise<unknown>) => {
  try { await run(); return null; } catch (error) {
    const e = error as { code?: string; message?: string; fix?: { argv?: string[] } };
    return { code: e.code ?? String(error), message: e.message ?? null, fix: e.fix?.argv?.map(arg => arg.split(base).join('<base>')) ?? null };
  }
};

describe('the shared pre-admission reads a write makes outside page-mutations', () => {
  parityTest('the members: every live source\'s import roots on a host, and the whole config table', {
    methods: ['listSourceImportRoots', 'readConfigTable', 'getAllConfig', 'setConfig'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'rooted-example', {}, '/srv/brains/rooted-example');
    await createSource(engine, backend, 'bound-example');
    await createSource(engine, backend, 'stale-example');
    await createSource(engine, backend, 'archived-example', {}, '/srv/brains/archived-example');
    await bindWorktree(engine, 'bound-example', HOST_A, '/var/tmp/bound-root');
    await bindWorktree(engine, 'stale-example', HOST_A, '/var/tmp/stale-root', randomUUID());
    await archiveSource(engine, backend, 'archived-example');
    await engine.setConfig('parity.shared_read_example', ODD_VALUE);
    const table = await engine.readConfigTable();
    const all = await engine.getAllConfig();
    const out = {
      onHostA: byId(await engine.listSourceImportRoots(HOST_A)),
      onHostB: byId(await engine.listSourceImportRoots(HOST_B)),
      sameRowsAsGetAllConfig: JSON.stringify(byKey(table)) === JSON.stringify(byKey(Object.entries(all).map(([key, value]) => ({ key, value })))),
      oneRowPerKey: new Set(table.map(row => row.key)).size === table.length,
      example: table.filter(row => row.key === 'parity.shared_read_example'),
    };
    expect(out).toEqual({
      onHostA: [
        { id: 'bound-example', local_path: null, worktree_path: '/var/tmp/bound-root', relative_path: 'notes' },
        { id: 'default', local_path: null, worktree_path: null, relative_path: null },
        { id: 'rooted-example', local_path: '/srv/brains/rooted-example', worktree_path: null, relative_path: null },
        { id: 'stale-example', local_path: null, worktree_path: null, relative_path: null },
      ],
      onHostB: [
        { id: 'bound-example', local_path: null, worktree_path: null, relative_path: 'notes' },
        { id: 'default', local_path: null, worktree_path: null, relative_path: null },
        { id: 'rooted-example', local_path: '/srv/brains/rooted-example', worktree_path: null, relative_path: null },
        { id: 'stale-example', local_path: null, worktree_path: null, relative_path: null },
      ],
      sameRowsAsGetAllConfig: true, oneRowPerKey: true,
      example: [{ key: 'parity.shared_read_example', value: ODD_VALUE }],
    });
    return out;
  });

  parityTest('a preparation\'s config view answers every config read from its one table read', {
    methods: ['readConfigTable', 'setConfig'],
  }, async (engine) => {
    await engine.setConfig('parity.view_example', ODD_VALUE);
    const view = await preparationConfigView(engine);
    // A write after the view was taken does not reach it: the view answers from its one read.
    await engine.setConfig('parity.view_example', 'written after the view');
    const keyed = await view.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', ['parity.view_example']);
    const out = {
      getConfig: await view.getConfig('parity.view_example'),
      missing: await view.getConfig('parity.no_such_key'),
      keyed, keyedMissing: await view.executeRaw('SELECT value FROM config WHERE key=$1', ['parity.no_such_key']),
      fromAll: (await view.getAllConfig())['parity.view_example'],
      live: await engine.getConfig('parity.view_example'),
    };
    expect(out).toEqual({ getConfig: ODD_VALUE, missing: null, keyed: [{ value: ODD_VALUE }], keyedMissing: [], fromAll: ODD_VALUE,
      live: 'written after the view' });
    return out;
  });

  parityTest('a managed import of a file inside another live source\'s root refuses source_changed naming it', {
    methods: ['listSourceImportRoots', 'readSourceIncarnation'],
  }, async (engine, backend) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-import-roots-')));
    try {
      const own = join(base, 'own'), rooted = join(base, 'rooted'), bound = join(base, 'bound'), loose = join(base, 'loose');
      for (const dir of [own, rooted, join(bound, 'notes'), loose]) mkdirSync(dir, { recursive: true });
      await createSource(engine, backend, 'import-example', {}, own);
      await createSource(engine, backend, 'rooted-example', {}, rooted);
      await createSource(engine, backend, 'bound-example');
      await bindWorktree(engine, 'bound-example', hostIdFor(engine), bound);
      const check = (input: string) => refusalOf(base, () => assertImportPaths(engine, 'import-example', own, input, join(own, 'notes', 'example.md')));
      const out = {
        inRooted: await check(join(rooted, 'example.md')),
        inBound: await check(join(bound, 'notes', 'example.md')),
        outsideBoundRelative: await check(join(bound, 'example.md')),
        loose: await check(join(loose, 'example.md')),
      };
      const refused = (source: string, input: string) => ({ code: 'source_changed', message: 'The import path belongs to a different registered source. Select that source explicitly.',
        fix: ['gbrain', 'import', input, '--source', source] });
      expect(out).toEqual({ inRooted: refused('rooted-example', '<base>/rooted/example.md'), inBound: refused('bound-example', '<base>/bound/notes/example.md'),
        outsideBoundRelative: null, loose: null });
      return out;
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
