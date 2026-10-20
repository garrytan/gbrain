/**
 * #6712 PR 4a: the level classifier (design v3.2 §2.3) and the pass kind (§2.2), pure.
 *
 * Authoring gate: (1) protects the contract that every path of a managed source gets exactly one class, with the
 * settled/unsettled and action the design states, including the fail-closed rows (dirty, drift, deleted pages that
 * stay deleted); (2) a reordered or dropped row, or a definition that drifts (fileSame, dbSame, proof, obligation),
 * makes the cross-product comparison against the state-space reference model fail; (3) nothing else covers the new
 * module; (4) no seam.
 *
 * The reference model below is written from the state space (page state × level × dirtiness, then the
 * fileSame × dbSame × proof regions the totality argument names), not from the row list, so the ordered first-match
 * table in sync-classify.ts and this decision tree must agree on every input.
 *
 * #6712 PR 4b rulings (Garry's Q3 = A: a settled path is matched, held, or in an action-tagged class): a legacy marker
 * settles only with a recorded deletion and never under a full obligation (b1, b5); a path with a hold never settles in
 * another class (b2).
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { classifySyncPath, SYNC_CLASSES, syncClassAction, syncPassKind, type SyncClass, type SyncDirtiness, type SyncPassKindInput, type SyncPathState } from '../src/core/persistence/sync-classify.ts';

const sha = (oid: string | null) => (oid === null ? null : `sha-${oid}`);
const CLEAN: ReadonlySet<SyncDirtiness | null> = new Set(['clean', 'clean_eol', 'clean_lfs']);

/** The reference model: page state first, then level, then dirtiness, then the fileSame × dbSame × proof regions. */
function reference(s: SyncPathState): SyncClass {
  if (s.hold && s.hold.atLevel && !s.hold.rescreenDue && !s.hold.retried) return 'held';
  const rest = referenceAfterHold(s);
  if (!s.hold) return rest;
  if (s.level !== null && (rest === 'matched' || rest === 'import')) return 'held';
  const dirtySettled = (s.tree !== null && !!s.record?.blobOids.includes(s.tree)) || (s.diskOid !== null && !!s.record?.blobOids.includes(s.diskOid)) || s.published;
  return SETTLED.has(rest) || (rest === 'dirty' && dirtySettled) ? 'held' : rest;
}

function referenceAfterHold(s: SyncPathState): SyncClass {
  if (s.spelling) return 'spelling';
  const absorbed = new Set(s.record?.blobOids ?? []);
  const fileSame = s.level !== null && absorbed.has(s.level);
  const dbSame = s.page !== null && s.record !== null && s.record.revision !== null && s.record.revision === s.page.revision;
  const proof = dbSame || s.attested !== null;
  const dirtyCommitted = s.mode === 'committed' && s.tree !== null && !CLEAN.has(s.dirty) && s.dirty !== 'deleted';
  const dirtyClass = (): SyncClass => 'dirty';
  const state = s.page === null ? 'none' : s.page.live ? 'live' : 'tombstone';
  if (state !== 'live') {
    if (s.mode === 'committed' && s.tree === null) return 'untracked';
    if (s.level === null) return 'gone';
    const markerHolds = s.marker?.kind === 'deleted' && s.marker.blobOids.includes(s.level);
    if ((state === 'tombstone' && fileSame) || markerHolds) return 'deleted_same';
    const deletedEvidence = state === 'tombstone' || s.marker?.kind === 'deleted';
    if (deletedEvidence && !s.published) return 'deleted_edited';
    if (s.marker?.kind === 'legacy' && s.marker.deletion && !s.fullObligation && s.marker.blobOids.includes(s.level)) return 'legacy_same';
    return dirtyCommitted ? dirtyClass() : 'import';
  }
  if (s.level === null && s.mode === 'committed' && s.present) return 'kept';
  if (s.level === null && !s.present) return proof ? 'delete' : 'delete_drift';
  if (dirtyCommitted) return dirtyClass();
  const obligation = !s.record?.parserSame || !s.page!.originMatches || s.episodeUnsatisfied;
  const adoptable = !obligation && ((s.attested?.hash != null && s.levelSha256 !== null && s.levelSha256 === s.attested.hash)
    || (fileSame && s.record?.revision === null && s.attested?.arm1 === true));
  const region = `${fileSame ? 'F' : 'f'}${dbSame ? 'D' : 'd'}${proof ? 'P' : 'p'}`;
  switch (region) {
    case 'FDP': return obligation ? 'reparse' : 'matched';
    case 'FdP': case 'Fdp': return adoptable ? 'adopt' : 'db_ahead';
    case 'fDP': case 'fdP': return adoptable ? 'adopt' : 'import';
    case 'fdp':
      if (s.record?.revision == null && s.level === s.baseline) return 'legacy_unverified';
      if (s.keepDb && s.mode === 'committed' && s.dirty === 'clean') return 'keep_db';
      return 'drift';
    default: throw new Error(`unreachable region ${region}`);
  }
}

const SETTLED: ReadonlySet<SyncClass> = new Set(['held', 'untracked', 'kept', 'gone', 'deleted_same', 'legacy_same', 'matched', 'adopt', 'db_ahead', 'legacy_unverified']);

const base: SyncPathState = { mode: 'committed', tree: 'A', level: 'A', present: true, dirty: 'clean', diskOid: 'A',
  page: { live: true, revision: 'R1', originMatches: true }, record: { blobOids: ['A'], revision: 'R1', parserSame: true },
  attested: null, levelSha256: sha('A'), published: false, hold: null, marker: null, baseline: 'A', spelling: false, episodeUnsatisfied: false, keepDb: false, openWork: false };
const at = (patch: Partial<SyncPathState>) => ({ ...base, ...patch });

describe('rows (v3.2 §2.3)', () => {
  const cases: Array<[string, Partial<SyncPathState>, SyncClass, boolean]> = [
    ['1 held at its level', { hold: { atLevel: true, rescreenDue: false, retried: false }, level: 'B', tree: 'B' }, 'held', true],
    ['1 a re-screen-due hold does not settle: the pass re-runs it', { hold: { atLevel: true, rescreenDue: true, retried: false } }, 'held', false],
    ['1 a re-screen-due hold on a page-less file is held, not imported or legacy (b2)', { hold: { atLevel: true, rescreenDue: true, retried: false }, page: null, record: null }, 'held', false],
    ['1 a hold over a database-ahead level stands (never imported over)', { hold: { atLevel: false, rescreenDue: false, retried: false }, page: { live: true, revision: 'R2', originMatches: true } }, 'held', true],
    ['2 spelling', { spelling: true }, 'spelling', false],
    ['3 untracked: committed, not in T, no live page', { tree: null, level: null, page: null, record: null }, 'untracked', true],
    ['4 kept: live, committed, absent from T, file present', { tree: null, level: null, present: true, dirty: null }, 'kept', true],
    ['5 delete with proof', { tree: null, level: null, present: false, dirty: null }, 'delete', false],
    ['6 delete_drift without proof', { tree: null, level: null, present: false, dirty: null, page: { live: true, revision: 'R2', originMatches: true } }, 'delete_drift', false],
    ['7 gone', { mode: 'working', tree: 'A', level: null, present: false, dirty: null, page: null }, 'gone', true],
    ['8 deleted_same (tombstone)', { page: { live: false, revision: 'R1', originMatches: true } }, 'deleted_same', true],
    ['8 deleted_same (marker)', { page: null, record: null, marker: { kind: 'deleted', blobOids: ['A'] } }, 'deleted_same', true],
    ['9 deleted_edited (tombstone)', { tree: 'B', level: 'B', page: { live: false, revision: 'R1', originMatches: true } }, 'deleted_edited', false],
    ['9 deleted_edited (marker without OIDs, fail closed)', { page: null, record: null, marker: { kind: 'deleted', blobOids: [] } }, 'deleted_edited', false],
    ['10 legacy_same: a marker that records a deletion', { page: null, record: null, marker: { kind: 'legacy', blobOids: ['A'], deletion: 'req-1' } }, 'legacy_same', true],
    ['10 a baseline-equal legacy marker without a deletion settles nothing (b1)', { page: null, record: null, marker: { kind: 'legacy', blobOids: ['A'] } }, 'import', false],
    ['10 a legacy-marked path under a full obligation imports (b5)', { page: null, record: null, marker: { kind: 'legacy', blobOids: ['A'], deletion: 'req-1' }, fullObligation: true }, 'import', false],
    ['10 a legacy-marked file that changed imports', { tree: 'B', level: 'B', page: null, record: null, marker: { kind: 'legacy', blobOids: ['A'] } }, 'import', false],
    ['11 dirty, absorbed', { dirty: 'modified', diskOid: 'C' }, 'dirty', true],
    ['11 dirty, not absorbed', { tree: 'B', level: 'B', dirty: 'modified', diskOid: 'C' }, 'dirty', false],
    ['11 dirty unknown is never clean', { tree: 'B', level: 'B', dirty: 'unknown', diskOid: null }, 'dirty', false],
    ['11 dirty, published', { tree: 'B', level: 'B', dirty: 'staged', diskOid: 'C', published: true }, 'dirty', true],
    ['12 matched', {}, 'matched', true],
    ['13 adopt by hash', { tree: 'B', level: 'B', levelSha256: 'h', attested: { hash: 'h', arm1: false } }, 'adopt', true],
    ['13 adopt by revision (arm 1, pre-PR 0 record)', { record: { blobOids: ['A'], revision: null, parserSame: true }, attested: { hash: null, arm1: true } }, 'adopt', true],
    ['14 reparse: parser changed on fileSame ∧ dbSame', { record: { blobOids: ['A'], revision: 'R1', parserSame: false } }, 'reparse', false],
    ['14 reparse: open full episode', { episodeUnsatisfied: true }, 'reparse', false],
    ['15 db_ahead db_only', { page: { live: true, revision: 'R2', originMatches: true } }, 'db_ahead', true],
    ['16 import with proof', { tree: 'B', level: 'B' }, 'import', false],
    ['16 a new file', { tree: 'B', level: 'B', page: null, record: null }, 'import', false],
    ['17 legacy_unverified', { tree: 'B', level: 'B', baseline: 'B', record: null, page: { live: true, revision: 'R2', originMatches: true } }, 'legacy_unverified', true],
    ['18 keep_db', { tree: 'B', level: 'B', keepDb: true, page: { live: true, revision: 'R2', originMatches: true } }, 'keep_db', false],
    ['19 drift (both)', { tree: 'B', level: 'B', page: { live: true, revision: 'R2', originMatches: true } }, 'drift', false],
  ];
  for (const [name, patch, cls, settled] of cases) test(name, () => {
    const got = classifySyncPath(at(patch));
    expect(got.cls).toBe(cls);
    expect(got.settled).toBe(settled);
    expect(reference(at(patch))).toBe(cls);
  });

  test('drift side: unknown without a record revision; db_ahead sub-labels', () => {
    expect(classifySyncPath(at({ tree: 'B', level: 'B', record: null, baseline: 'A', page: { live: true, revision: 'R2', originMatches: true } }))).toMatchObject({ cls: 'drift', side: 'unknown' });
    expect(classifySyncPath(at({ page: { live: true, revision: 'R2', originMatches: true }, attested: { hash: null, arm1: false } }))).toMatchObject({ cls: 'db_ahead', sub: 'pending' });
    expect(classifySyncPath(at({ record: { blobOids: ['A'], revision: null, parserSame: true }, page: { live: true, revision: 'R2', originMatches: true } }))).toMatchObject({ cls: 'db_ahead', sub: 'unproven' });
  });

  test('row 15: keep_db writes only db_only on a clean committed path; an open full obligation skips db_only/unproven', () => {
    const moved = { page: { live: true, revision: 'R2', originMatches: true } };
    expect(classifySyncPath(at({ ...moved, keepDb: true }))).toMatchObject({ cls: 'db_ahead', sub: 'db_only', keepDbWrite: true, action: 'keep_db' });
    expect(classifySyncPath(at({ ...moved, keepDb: true, dirty: 'clean_eol' })).keepDbWrite).toBeUndefined();
    expect(classifySyncPath(at({ ...moved, keepDb: true, mode: 'working' })).keepDbWrite).toBeUndefined();
    expect(classifySyncPath(at({ ...moved, keepDb: true, record: { blobOids: ['A'], revision: null, parserSame: true } })).keepDbWrite).toBeUndefined();
    expect(classifySyncPath(at({ ...moved, episodeUnsatisfied: true }))).toMatchObject({ cls: 'db_ahead', fullSkipped: true });
    expect(classifySyncPath(at({ ...moved, episodeUnsatisfied: true, attested: { hash: null, arm1: false } })).fullSkipped).toBeUndefined();
  });

  test('overlay: an unsettled class with open work is in flight; a settled class stays settled', () => {
    expect(classifySyncPath(at({ tree: 'B', level: 'B', openWork: true }))).toMatchObject({ cls: 'import', settled: false, inFlight: true });
    expect(classifySyncPath(at({ openWork: true }))).toMatchObject({ cls: 'matched', settled: true, inFlight: false });
  });

  test('glossary: every class has an action tag', () => {
    for (const cls of SYNC_CLASSES) expect(['none', 'owner', 'repair']).toContain(syncClassAction(cls));
    expect(syncClassAction('in_flight')).toBe('owner');
    expect(syncClassAction('deletes_withheld')).toBe('repair');
  });
});

// The alphabet (v3.1 §2.3 cross product, v3.2 additions: parser/origin/episode conjuncts, durability via published,
// staged-but-present working paths, which reach the classifier as a working level from the physical bytes).
const oid = fc.constantFrom<string | null>(null, 'A', 'B', 'C');
const stateArb: fc.Arbitrary<SyncPathState> = fc.record({
  mode: fc.constantFrom<'committed' | 'working'>('committed', 'working'),
  tree: fc.constantFrom<string | null>(null, 'A', 'B'),
  working: oid,
  present: fc.boolean(),
  dirty: fc.constantFrom<SyncDirtiness | null>('clean', 'clean_eol', 'clean_lfs', 'modified', 'deleted', 'staged', 'untracked', 'unknown', null),
  diskOid: oid,
  page: fc.constantFrom<SyncPathState['page']>(null, { live: true, revision: 'R1', originMatches: true }, { live: true, revision: 'R1', originMatches: false },
    { live: true, revision: 'R2', originMatches: true }, { live: false, revision: 'R1', originMatches: true }),
  record: fc.constantFrom<SyncPathState['record']>(null, { blobOids: ['A'], revision: null, parserSame: true }, { blobOids: ['A'], revision: 'R1', parserSame: true },
    { blobOids: ['A'], revision: 'R1', parserSame: false }, { blobOids: ['A', 'B'], revision: 'R1', parserSame: true }, { blobOids: ['A'], revision: 'R2', parserSame: true }),
  attested: fc.constantFrom<SyncPathState['attested']>(null, { hash: sha('A'), arm1: false }, { hash: sha('B'), arm1: false }, { hash: null, arm1: true }),
  published: fc.boolean(),
  hold: fc.constantFrom<SyncPathState['hold']>(null, { atLevel: true, rescreenDue: false, retried: false }, { atLevel: false, rescreenDue: false, retried: false },
    { atLevel: true, rescreenDue: true, retried: false }, { atLevel: true, rescreenDue: false, retried: true }),
  marker: fc.constantFrom<SyncPathState['marker']>(null, { kind: 'deleted', blobOids: ['A'] }, { kind: 'deleted', blobOids: [] }, { kind: 'legacy', blobOids: ['A'] }, { kind: 'legacy', blobOids: ['A'], deletion: 'req-1' }),
  baseline: fc.constantFrom<string | null>(null, 'A', 'B'),
  spelling: fc.boolean(), episodeUnsatisfied: fc.boolean(), fullObligation: fc.boolean(), keepDb: fc.boolean(), openWork: fc.boolean(),
}).map(({ working, ...raw }) => {
  // Consistency the pass guarantees: committed L = T[p] and Dp only for T paths; working L = the bytes, present ⇔ L.
  const level = raw.mode === 'committed' ? raw.tree : working;
  const present = raw.mode === 'committed' ? raw.present : level !== null;
  const dirty = raw.mode === 'committed' && raw.tree !== null ? raw.dirty : null;
  return { ...raw, level, present, dirty, levelSha256: sha(level) };
});

describe('P0 properties', () => {
  test('(f) total, deterministic, and equal to the state-space reference model', () => {
    fc.assert(fc.property(stateArb, s => {
      const a = classifySyncPath(s), b = classifySyncPath(s);
      expect(a).toEqual(b);
      expect(SYNC_CLASSES).toContain(a.cls);
      expect(a.cls).toBe(reference(s));
      if (a.cls !== 'dirty' && a.cls !== 'spelling' && a.cls !== 'held') expect(a.settled).toBe(SETTLED.has(a.cls));
      if (a.cls === 'held') expect(a.settled).toBe(!a.rescreenDue);
      expect(a.inFlight).toBe(!a.settled && s.openWork);
    }), { numRuns: 60_000, seed: 6712 });
  });

  test('(f) exhaustive over the core alphabet', () => {
    let n = 0;
    for (const mode of ['committed', 'working'] as const) for (const tree of [null, 'A', 'B']) for (const working of [null, 'A', 'B'])
    for (const present of mode === 'committed' ? [true, false] : [working !== null])
    for (const dirty of mode === 'committed' && tree !== null ? (['clean', 'clean_eol', 'modified', 'deleted', 'staged', 'unknown'] as const) : [null])
    for (const page of [null, { live: true, revision: 'R1', originMatches: true }, { live: true, revision: 'R2', originMatches: true }, { live: false, revision: 'R1', originMatches: true }])
    for (const record of [null, { blobOids: ['A'], revision: null, parserSame: true }, { blobOids: ['A'], revision: 'R1', parserSame: true }, { blobOids: ['A'], revision: 'R1', parserSame: false }])
    for (const attested of [null, { hash: sha('A'), arm1: false }, { hash: null, arm1: true }])
    for (const marker of [null, { kind: 'deleted' as const, blobOids: ['A'] }, { kind: 'legacy' as const, blobOids: ['A'] }, { kind: 'legacy' as const, blobOids: ['A'], deletion: 'req-1' }])
    for (const published of [false, true]) for (const baseline of [null, 'A']) for (const keepDb of [false, true]) for (const episodeUnsatisfied of [false, true]) for (const fullObligation of [false, true]) {
      const level = mode === 'committed' ? tree : working;
      const s: SyncPathState = { mode, tree, level, present, dirty, diskOid: 'C', page, record, attested, levelSha256: sha(level), published, hold: null, marker, baseline,
        spelling: false, episodeUnsatisfied, fullObligation, keepDb, openWork: false };
      const got = classifySyncPath(s);
      if (got.cls !== reference(s)) throw new Error(`mismatch ${got.cls} vs ${reference(s)} for ${JSON.stringify(s)}`);
      n++;
    }
    expect(n).toBeGreaterThan(100_000);
  });

  test('(j) no page-less import while a deleted marker or tombstone matches the level', () => {
    fc.assert(fc.property(stateArb, s => {
      const live = s.page?.live === true;
      const tombstoneMatches = s.page !== null && !s.page.live && s.level !== null && !!s.record?.blobOids.includes(s.level);
      const markerMatches = s.marker?.kind === 'deleted' && s.level !== null && s.marker.blobOids.includes(s.level);
      if (!live && (tombstoneMatches || markerMatches)) expect(classifySyncPath(s).action).not.toBe('import');
    }), { numRuns: 40_000, seed: 67121 });
  });

  test('(k) an edit to a swept legacy page imports with no Decision', () => {
    // The legacy sweep (v3.2 §2.7) writes {blob_oid, disk_blob_oid, revision, parser: fp} for an equal legacy page.
    const swept = at({ record: { blobOids: ['A'], revision: 'R1', parserSame: true }, baseline: 'A' });
    expect(classifySyncPath(swept).cls).toBe('matched');
    for (const mode of ['committed', 'working'] as const) {
      const edited = classifySyncPath({ ...swept, mode, tree: mode === 'committed' ? 'B' : 'A', level: 'B', diskOid: 'B', levelSha256: sha('B') });
      expect(edited).toMatchObject({ cls: 'import', action: 'import' });
    }
  });

  test('fail closed: a committed path with uncommitted bytes never imports, adopts or writes DB-wins', () => {
    fc.assert(fc.property(stateArb, s => {
      if (s.mode === 'committed' && s.tree !== null && !CLEAN.has(s.dirty) && s.dirty !== 'deleted' && !s.spelling && !(s.hold?.atLevel && !s.hold.rescreenDue && !s.hold.retried)) {
        expect(['import', 'adopt', 'reparse', 'keep_db']).not.toContain(classifySyncPath(s).action);
      }
    }), { numRuns: 40_000, seed: 67122 });
  });

  test('GBRA-133 S-27/S-28: a committed path no file backs (deleted, skip-worktree, sparse) classifies at its committed level, as a clean one does, except for the DB-wins write', () => {
    fc.assert(fc.property(stateArb, s => {
      if (s.mode !== 'committed' || s.tree === null || s.dirty !== 'deleted') return;
      const got = classifySyncPath(s), clean = classifySyncPath({ ...s, dirty: 'clean' });
      expect(got.cls === 'keep_db' ? 'drift' : got.cls).toBe(clean.cls === 'keep_db' ? 'drift' : clean.cls);
      expect(got.action).not.toBe('keep_db');
    }), { numRuns: 40_000, seed: 67133 });
  });

  test('no DB-wins write without keep_db on a clean committed path, and never for unproven pages', () => {
    fc.assert(fc.property(stateArb, s => {
      const got = classifySyncPath(s);
      if (got.action === 'keep_db') {
        expect(s.keepDb && s.mode === 'committed' && s.dirty === 'clean').toBe(true);
        expect(got.sub).not.toBe('unproven');
      }
    }), { numRuns: 40_000, seed: 67123 });
  });
});

describe('pass kind (v3.2 §2.2)', () => {
  const converged = { target: 'H', parserFp: 'p', pack: null, selectionFp: 's', passesSinceFull: 1, lastFullAt: 0 };
  const idle: SyncPassKindInput = { converged, head: 'H', parserFp: 'p', pack: null, selectionFp: 's', now: 1000, openEpisode: false, owedTail: false, retryRow: false,
    notConvergedStreak: 0, mismatchStreak: 0, requestNewer: false, openAtStampFinished: false, workingChange: false, rescreenDueHold: false, full: false };
  test('idle when nothing disqualifies it', () => expect(syncPassKind(idle)).toEqual({ kind: 'idle', blockers: [] }));
  test('probe 49 (pure): a re-screen-due hold alone runs a hold-only round, not a full round', () => {
    expect(syncPassKind({ ...idle, rescreenDueHold: true }).kind).toBe('hold_only');
    expect(syncPassKind({ ...idle, rescreenDueHold: true, requestNewer: true }).kind).toBe('full');
  });
  test('every obligation disqualifies idle (probe 30: --full or a retry at an unchanged HEAD runs a full round)', () => {
    for (const patch of [{ full: true }, { openEpisode: true }, { retryRow: true }, { owedTail: true }, { notConvergedStreak: 1 }, { mismatchStreak: 2 },
      { requestNewer: true }, { openAtStampFinished: true }, { workingChange: true }, { head: 'H2' }, { parserFp: 'p2' }, { pack: 'x' }, { selectionFp: 's2' },
      { converged: null }, { now: converged.lastFullAt + 24 * 3600_000 }, { converged: { ...converged, passesSinceFull: 200 } }] as Array<Partial<SyncPassKindInput>>) {
      expect(syncPassKind({ ...idle, ...patch }).kind).toBe('full');
    }
  });
});
