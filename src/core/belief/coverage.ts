/**
 * Coverage intervals and the activation baseline (docs/designs/BELIEF_LEDGER.md
 * section 7.1). `enableBeliefLedger` appends `coverage.started`, then baselines
 * each page under its own page key (one snapshot `baseline` event, or one per
 * subject for a page over 1 MiB) and each database-only subject under its slug
 * key, then appends `coverage.complete`, whose recorded_at is the source's
 * watermark. A run is resumable: a page whose baseline for the current run
 * exists is skipped. `disableBeliefLedger` appends `coverage.stopped`; the next
 * enable starts a new interval with a new baseline.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { COVERAGE_KEY, pageKey } from './keys.ts';
import { appendBeliefEvents, markBeliefCommits, type BeliefEventDraft } from './append.ts';
import { coverageActive, currentStateHash, readLedgerSource } from './ledger.ts';
import { keyedSubjects, type Subject } from './subjects.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { validateSlug } from '../utils.ts';

export interface CoverageRun { runId: string; resumed: boolean; pages: number; complete: boolean; certified: boolean; unkeyable: string[] }
const BASELINE_BATCH = 200;

type Coverage = { type: string; run: string | null; recorded_at: string; id: number };

/** The coverage state of the source's current incarnation: its newest coverage event other than `coverage.restored` (a restore never starts or stops recording). */
export async function latestCoverage(engine: Pick<BrainEngine, 'readLatestBeliefCoverage'>, sourceId: string): Promise<Coverage | null> {
  const row = await engine.readLatestBeliefCoverage(sourceId);
  return row ? { type: row.event_type, run: row.run, recorded_at: row.recorded_at, id: row.id } : null;
}

/**
 * Appends the coverage event `decide` picks from the state re-read under the source row lock (`lockSourceRow`: FOR
 * UPDATE, which every page-key holder waits on; on a Rust brain the single writer's transaction), or nothing when it returns null. Returns that state and whether it appended.
 */
async function appendCoverage(engine: BrainEngine, sourceId: string,
  decide: (latest: Coverage | null, tx: BrainEngine) => Promise<{ eventType: string; cause: Record<string, unknown> } | null>): Promise<{ latest: Coverage | null; appended: Record<string, unknown> | null }> {
  const publicationId = randomUUID();
  const out = await engine.transaction(async tx => {
    if ((await tx.lockSourceRow(sourceId)) === null) throw new Error(`source not found: ${sourceId}`);
    const source = (await readLedgerSource(tx, sourceId))!;
    const latest = await latestCoverage(tx, sourceId);
    const next = await decide(latest, tx);
    if (!next) return { latest, appended: null };
    await appendBeliefEvents(tx, [{ sourceId, incarnation: source.incarnation, lifetime: null, slug: '', subjectKind: 'coverage', subjectKey: COVERAGE_KEY,
      eventType: next.eventType, trustTier: 'unknown', tierBasis: 'unknown', visibility: 'world', value: null, stateHash: '', cause: { op: next.eventType, ...next.cause } }],
    { publicationId, origin: 'live', purgesPossible: false });
    return { latest, appended: next.cause };
  });
  if (out.appended) await markBeliefCommits(engine, [publicationId]);
  return out;
}

/**
 * One page's baseline under its key, in the same form as a creation snapshot (or per subject when over 1 MiB).
 * 'baselined', 'nothing' (no state to baseline, already baselined, or recording stopped) or 'dropped' (drafts that appended nothing).
 */
async function baselinePage(engine: BrainEngine, sourceId: string, slug: string, runId: string): Promise<'baselined' | 'nothing' | 'dropped'> {
  const publicationId = randomUUID();
  const appended = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const source = await readLedgerSource(tx, sourceId);
    if (!source || !coverageActive(source.coverage)) return null;
    if (!await lacksBaseline(tx, sourceId, slug, runId)) return null;
    const { hash, state, lifetimes } = await currentStateHash(tx, sourceId, source.incarnation, slug);
    const page = state.pages.find(p => p.slug === slug);
    const subjects = keyedSubjects({ incarnation: source.incarnation, lifetimes, pagesBySlug: new Map(page ? [[slug, page]] : []) }, state,
      id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world').filter(s => s.stream === slug);
    const lifetime = page ? lifetimes.get(page.id)! : null;
    const cause = { op: 'baseline', run: runId };
    const drafts: BeliefEventDraft[] = [];
    const perSubject = (list: Subject[]) => list.map((s): BeliefEventDraft => ({ sourceId, incarnation: source.incarnation, lifetime: s.dbOnly && !page ? null : lifetime,
      slug, stream: slug, subjectKind: s.kind, subjectKey: s.key, eventType: 'baseline', trustTier: s.kind === 'link' || s.kind === 'link_transition' ? 'unknown' : s.tier,
      tierBasis: s.kind === 'link' || s.kind === 'link_transition' ? 'unknown' : 'row', visibility: s.visibility, value: s.value, stateHash: hash,
      claimFp: s.claimFp, validFrom: s.validFrom, validUntil: s.validUntil, cause: { ...cause, ...(s.rowNum != null ? { row: s.rowNum } : {}), label: s.label } }));
    if (page) {
      const bound = subjects.filter(s => !s.dbOnly);
      const counts = { facts: bound.filter(s => s.kind === 'fact').length, takes: bound.filter(s => s.kind === 'take').length,
        links: bound.filter(s => s.kind === 'link').length, link_transitions: bound.filter(s => s.kind === 'link_transition').length };
      drafts.push({ sourceId, incarnation: source.incarnation, lifetime, slug, stream: slug, subjectKind: 'page', subjectKey: pageKey(lifetime!), eventType: 'baseline',
        trustTier: page.tier, visibility: page.visible ? 'world' : 'private', value: { revision_after: page.revision, snapshot: !page.large, counts, ...(page.deleted ? { deleted: true } : {}) },
        stateHash: hash, cause });
      if (page.large) drafts.push(...perSubject(bound));
    }
    drafts.push(...perSubject(subjects.filter(s => s.dbOnly)));
    return drafts.length ? appendBeliefEvents(tx, drafts, { publicationId, origin: 'baseline', purgesPossible: source.purgesPossible }) : null;
  });
  if (appended) await markBeliefCommits(engine, [publicationId]);
  return appended === null ? 'nothing' : appended > 0 ? 'baselined' : 'dropped';
}

const lacksBaseline = async (engine: BrainEngine, sourceId: string, slug: string, runId: string) => !(await engine.hasBeliefBaseline(sourceId, slug, runId));

/** Slugs of the source still lacking a baseline in this run: live and soft-deleted pages, then page-less database-only fact subjects. */
function pendingSlugs(engine: Pick<BrainEngine, 'listBeliefBaselinePending'>, sourceId: string, runId: string, after: string, skip: readonly string[]): Promise<string[]> {
  return engine.listBeliefBaselinePending(sourceId, runId, after, skip, BASELINE_BATCH);
}

/**
 * Starts (or resumes) the source's run and baselines every pending slug. Start, completion and stop are decided under
 * the source row lock: a second enable resumes the open run, a disable during the walk ends it without a
 * `coverage.complete`, and the completion re-checks the pending set (a page renamed onto a slug the cursor already
 * passed is baselined before the watermark). A slug no page key can name, or whose baseline appended nothing, is left
 * out and listed in the completion (`unkeyable_slugs`, `unbaselined_slugs`).
 */
export async function enableBeliefLedger(engine: BrainEngine, sourceId: string): Promise<CoverageRun> {
  const start = await appendCoverage(engine, sourceId, async latest =>
    latest?.type === 'coverage.started' || latest?.type === 'coverage.complete' ? null : { eventType: 'coverage.started', cause: { run: randomUUID() } });
  const certified = await readManagedMode(engine);
  if (start.latest?.type === 'coverage.complete') return { runId: start.latest.run ?? '', resumed: true, pages: 0, complete: true, certified, unkeyable: [] };
  const runId = start.appended ? String(start.appended.run) : start.latest!.run!;
  const unkeyable: string[] = [];
  const unbaselined: string[] = [];
  const attempted = new Set<string>();
  let pages = 0;
  for (let walk = 0; ; walk++) {
    const skip = () => walk ? [...unkeyable, ...attempted] : unkeyable;
    for (let after = '', slugs = await pendingSlugs(engine, sourceId, runId, after, skip()); slugs.length; slugs = await pendingSlugs(engine, sourceId, runId, after, skip())) {
      for (const slug of slugs) {
        try { validateSlug(slug); } catch { unkeyable.push(slug); continue; }
        attempted.add(slug);
        const outcome = await baselinePage(engine, sourceId, slug, runId);
        if (outcome === 'baselined') pages++;
        if (outcome === 'dropped') unbaselined.push(slug);
      }
      after = slugs[slugs.length - 1]!;
      const latest = await latestCoverage(engine, sourceId);
      if (latest?.type !== 'coverage.started' || latest.run !== runId) break;
    }
    const end = await appendCoverage(engine, sourceId, async (latest, tx) => {
      if (latest?.type !== 'coverage.started' || latest.run !== runId) return null;
      if ((await pendingSlugs(tx, sourceId, runId, '', [...unkeyable, ...attempted])).length) return null;
      const done = await tx.countBeliefBaselineSlugs(sourceId, runId);
      return { eventType: 'coverage.complete', cause: { run: runId, certified, pages: done, ...(unkeyable.length ? { unkeyable_slugs: unkeyable } : {}),
        ...(unbaselined.length ? { unbaselined_slugs: unbaselined } : {}) } };
    });
    const complete = !!end.appended || (end.latest?.type === 'coverage.complete' && end.latest.run === runId);
    if (complete || end.latest?.type !== 'coverage.started' || end.latest.run !== runId) {
      return { runId, resumed: !start.appended, pages, complete, certified: complete && certified, unkeyable };
    }
  }
}

export async function disableBeliefLedger(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const out = await appendCoverage(engine, sourceId, async latest => !latest || latest.type === 'coverage.stopped' ? null : { eventType: 'coverage.stopped', cause: { run: latest.run } });
  return !!out.appended;
}
