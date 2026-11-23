/**
 * BrainEngine parity — the reads and writes every default `importFromContent` makes before it writes a page.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the import guards (managed-mode, strict-source, transaction settings, local writer identity, ledger
 *    source probe, source row, folder restriction, keyed config read) return the same observable result on every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; a Rust arm later through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of these guards differently (a malformed managed-mode row shape, a lock
 *    that is not taken, a settings read that skips the transaction, a source row missing a column) changes which writes
 *    a brain accepts; the Rust engine has no SQL, so each guard has to exist as a typed method it can implement.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none in the cases. Typed methods only (no executeRaw: D18); the fixtures that need rows no typed method
 *    creates (a second source, a folder rule, belief coverage) go through harness.ts behind the backend switch.
 *    Generated ids (the brain id, a source incarnation) are compared by shape, never by value; no serial id is compared.
 */
import { describe, expect } from 'bun:test';
import { createSource, enableBeliefCoverage, parityArms, restrictFolder } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWN = 'parity.import.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANT = { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null };
const WRITER = 'a0000000-0000-4000-8000-0000000000a1';
const OTHER_WRITER = 'a0000000-0000-4000-8000-0000000000a2';
const HASH = 'f'.repeat(64);

describe('engine parity: import path guards', () => {
  parityTest('getSource returns one source row with its import columns; an unknown id is null', { methods: ['getSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { keep: 1 });
    const work = await engine.getSource('work');
    expect(work?.created_at).toBeInstanceOf(Date);
    const unknown = await engine.getSource('no-such-source');
    expect(unknown).toBeNull();
    const defaultSource = await engine.getSource('default');
    expect(defaultSource?.id).toBe('default');
    const view = (row: typeof work) => row && {
      id: row.id, name: row.name, local_path: row.local_path, last_commit: row.last_commit, last_sync_at: row.last_sync_at,
      config: row.config, contextual_retrieval_mode: row.contextual_retrieval_mode, trust_frontmatter_overrides: row.trust_frontmatter_overrides,
    };
    expect(view(work)).toEqual({
      id: 'work', name: 'work', local_path: null, last_commit: null, last_sync_at: null, config: { keep: 1 },
      contextual_retrieval_mode: null, trust_frontmatter_overrides: false,
    });
    return { work: view(work), defaultSource: view(defaultSource), unknown };
  });

  parityTest('getConfigValues returns the stored rows of the named keys, ordered by key; unset keys are absent', { methods: ['setConfig', 'getConfigValues'] }, async (engine) => {
    await engine.setConfig(`${OWN}beta`, 'two');
    await engine.setConfig(`${OWN}alpha`, 'one');
    await engine.setConfig(`${OWN}empty`, '');
    await engine.setConfig(`${OWN}other`, 'not asked for');
    const rows = await engine.getConfigValues([`${OWN}empty`, `${OWN}beta`, `${OWN}missing`, `${OWN}alpha`]);
    expect(rows).toEqual([
      { key: `${OWN}alpha`, value: 'one' },
      { key: `${OWN}beta`, value: 'two' },
      { key: `${OWN}empty`, value: '' },
    ]);
    const none = await engine.getConfigValues([`${OWN}missing`]);
    expect(none).toEqual([]);
    const noKeys = await engine.getConfigValues([]);
    expect(noKeys).toEqual([]);
    return { rows, none, noKeys };
  });

  parityTest('readManagedModeRows returns the one unmanaged row of a fresh brain; getSourceStrictness is true only for canonical git', { methods: ['readManagedModeRows', 'getSourceStrictness'] }, async (engine, backend) => {
    await createSource(engine, backend, 'strict', { canonical: 'git' });
    await createSource(engine, backend, 'loose', { canonical: 'database' });
    await createSource(engine, backend, 'unset', {});
    const modes = await engine.readManagedModeRows();
    expect(modes).toEqual([{ enabled: false }]);
    const strictness = {
      strict: await engine.getSourceStrictness('strict'),
      loose: await engine.getSourceStrictness('loose'),
      unset: await engine.getSourceStrictness('unset'),
      default: await engine.getSourceStrictness('default'),
      unknown: await engine.getSourceStrictness('no-such-source'),
    };
    expect(strictness).toEqual({ strict: true, loose: false, unset: false, default: false, unknown: false });
    return { modes, strictness };
  });

  parityTest('readPersistenceBrainId returns the brain identity, the same on every read', { methods: ['readPersistenceBrainId'] }, async (engine) => {
    const first = await engine.readPersistenceBrainId();
    const second = await engine.readPersistenceBrainId();
    expect(first).toMatch(UUID);
    expect(second).toBe(first);
    return { isUuid: UUID.test(first ?? ''), stable: first === second };
  });

  parityTest('insertLocalWriterRow registers a writer once; readLocalWriterRow returns it, with or without the share lock', { methods: ['insertLocalWriterRow', 'readLocalWriterRow', 'transaction'] }, async (engine) => {
    const absent = await engine.readLocalWriterRow(WRITER);
    expect(absent).toBeUndefined();
    const inserted = await engine.insertLocalWriterRow({ id: WRITER, lane: 'stdio', credentialHash: HASH, grant: GRANT });
    expect(inserted).toBe(true);
    const row = await engine.readLocalWriterRow(WRITER);
    expect(row).toEqual({ lane: 'stdio', credential_hash: HASH, grant_ceiling: GRANT, revoked_at: null });
    const again = await engine.insertLocalWriterRow({ id: WRITER, lane: 'stdio', credentialHash: HASH, grant: GRANT });
    expect(again).toBe(false);
    const sameCredential = await engine.insertLocalWriterRow({ id: OTHER_WRITER, lane: 'cli', credentialHash: HASH, grant: GRANT });
    expect(sameCredential).toBe(false);
    const otherRow = await engine.readLocalWriterRow(OTHER_WRITER);
    expect(otherRow).toBeUndefined();
    const locked = await engine.transaction(tx => tx.readLocalWriterRow(WRITER, { lock: true }));
    expect(locked).toEqual(row);
    return { absent, inserted, row, again, sameCredential, otherRow, locked };
  });

  parityTest('readTransactionSettings and applyTransactionSettings read and set settings inside the transaction only', { methods: ['readTransactionSettings', 'applyTransactionSettings', 'transaction'] }, async (engine) => {
    const names = ['gbrain.git_protocol', 'gbrain.persistence_protocol'];
    // A setting that was never set reads null, or an empty string once an earlier transaction on the connection set it.
    const blank = (values: Array<string | null>) => values.map(value => value ?? '');
    const before = blank(await engine.readTransactionSettings(names));
    expect(before).toEqual(['', '']);
    const inside = await engine.transaction(async (tx) => {
      const start = blank(await tx.readTransactionSettings(names));
      await tx.applyTransactionSettings(names, ['one', 'two']);
      const set = await tx.readTransactionSettings(names);
      await tx.applyTransactionSettings([names[0]!], ['three']);
      const nested = await tx.readTransactionSettings(names);
      const reversed = await tx.readTransactionSettings([names[1]!, names[0]!]);
      return { start, set, nested, reversed };
    });
    expect(inside).toEqual({ start: ['', ''], set: ['one', 'two'], nested: ['three', 'two'], reversed: ['two', 'three'] });
    const after = blank(await engine.readTransactionSettings(names));
    expect(after).toEqual(['', '']);
    // The names are code constants; anything else is refused before a statement is sent.
    await expect(engine.applyTransactionSettings(["x'); DROP TABLE pages; --"], ['v'])).rejects.toThrow(/Invalid transaction setting name/);
    await expect(engine.readTransactionSettings(['Bad Name'])).rejects.toThrow(/Invalid transaction setting name/);
    return { before, inside, after };
  });

  parityTest('readLedgerSource probes a source: an unknown id is null, a plain source has no coverage, and the batch probe reads the managed mode', { methods: ['readLedgerSource', 'transaction'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const unknown = await engine.readLedgerSource('no-such-source');
    expect(unknown).toBeNull();
    const probe = await engine.readLedgerSource('work');
    expect(probe?.incarnation).toMatch(UUID);
    const view = (row: typeof probe) => row && {
      incarnationIsUuid: UUID.test(row.incarnation), purgeEpoch: row.purgeEpoch, coverage: row.coverage, purgesPossible: row.purgesPossible,
      managedRows: row.managedRows, planModePrev: row.planModePrev,
    };
    expect(view(probe)).toEqual({ incarnationIsUuid: true, purgeEpoch: 0, coverage: null, purgesPossible: false, managedRows: undefined, planModePrev: undefined });
    const batch = await engine.transaction(async tx => ({
      unknown: await tx.readLedgerSource('no-such-source', { batch: true }),
      plain: view(await tx.readLedgerSource('work', { batch: true })),
    }));
    expect(batch.unknown).toBeNull();
    expect(batch.plain).toEqual({ incarnationIsUuid: true, purgeEpoch: 0, coverage: null, purgesPossible: false, managedRows: [{ enabled: false }], planModePrev: 'auto' });
    await enableBeliefCoverage(engine, backend, 'work');
    const covered = await engine.transaction(async (tx) => {
      const probeCovered = view(await tx.readLedgerSource('work', { batch: true }));
      // With coverage active the batch probe switches the transaction to generic plans and names the mode it replaced.
      const [planMode] = await tx.readTransactionSettings(['plan_cache_mode']);
      return { probeCovered, planMode };
    });
    expect(covered).toEqual({
      probeCovered: { incarnationIsUuid: true, purgeEpoch: 0, coverage: 'coverage.complete', purgesPossible: false, managedRows: [{ enabled: false }], planModePrev: 'auto' },
      planMode: 'force_generic_plan',
    });
    const plain = view(await engine.readLedgerSource('work'));
    expect(plain?.coverage).toBe('coverage.complete');
    return { unknown, probe: view(probe), batch, covered, plain };
  });

  parityTest('isFolderRestricted is false for an open folder and true under a folder rule or a pending prefix', { methods: ['isFolderRestricted'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const open = await engine.isFolderRestricted('work', 'people/alice-example');
    expect(open).toBe(false);
    await restrictFolder(engine, backend, 'work', 'private/', 'rule');
    await restrictFolder(engine, backend, 'work', 'queued/', 'pending');
    const answers = {
      open: await engine.isFolderRestricted('work', 'people/alice-example'),
      underRule: await engine.isFolderRestricted('work', 'private/diary'),
      underPending: await engine.isFolderRestricted('work', 'queued/notes'),
      otherSource: await engine.isFolderRestricted('default', 'private/diary'),
      prefixOnly: await engine.isFolderRestricted('work', 'private'),
    };
    expect(answers).toEqual({ open: false, underRule: true, underPending: true, otherSource: false, prefixOnly: false });
    return answers;
  });
});
