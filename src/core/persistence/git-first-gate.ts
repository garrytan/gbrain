/**
 * The activation gate of Wave C's git-first strict write path (spec §3.1, §3.8; review d1, eng-r3-outside-4,
 * ceo-r3-native-5). On a strict source (`config.canonical = "git"`) a write of a page Git keeps goes through the door
 * first, and the database rows of a segmented page are derived afterwards from the committed blob by the
 * `index-split-page` effect. The path is on for a source only when all three hold:
 *
 * 1. the source is strict;
 * 2. an `index-split-page` consumer is registered in this process (1I registers it; a standalone 1H tree has none, so
 *    it keeps today's behaviour exactly);
 * 3. no writer seen in the last `GIT_FIRST_WRITER_WINDOW_DAYS` days is stamped below the git-first floor. An older
 *    writer would still stage page bytes in the database and would claim an index effect it cannot run, so index
 *    effects are queued only when every recent writer is at the floor (an activation barrier, not a kind filter).
 *
 * The floor is the `since` of the `git_first_strict_path` BEHAVIOR_CHANGES row, and this build's VERSION while that
 * row says 'TBD', so the merge-slot stamp edits only the row (the same pattern as SEGMENTED_WRITER_FLOOR).
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { SegmentedGateWriter } from './writer-versions.ts';
import type { PersistenceEffect } from './effect-model.ts';

/** The effect kind that indexes a committed page from its blob (spec §3.6). */
export const INDEX_SPLIT_PAGE_EFFECT = 'index-split-page' as const;
/** The `id` of the BEHAVIOR_CHANGES row whose `since` is the git-first writer floor. */
export const GIT_FIRST_CHANGE = 'git_first_strict_path';
/** A writer below the floor keeps the path off until this many days after its last write. */
export const GIT_FIRST_WRITER_WINDOW_DAYS = 7;
/** The writer gate is read at most once per this many ms per engine. */
export const GIT_FIRST_GATE_TTL_MS = 30_000;

/** The runner of claimed `index-split-page` effects (persistence/index-split-page.ts). */
export interface IndexSplitPageConsumer {
  run(engine: BrainEngine, config: GBrainConfig, effect: PersistenceEffect, hostId: string): Promise<void>;
}

let consumer: IndexSplitPageConsumer | null = null;

/** Registers the process's index consumer; the git-first path and index effect claims stay off without one. */
export function registerIndexSplitPageConsumer(next: IndexSplitPageConsumer): void { consumer = next; }
/** Test seam: forget the registered consumer. */
export function _unregisterIndexSplitPageConsumerForTests(): void { consumer = null; }
export function indexSplitPageConsumer(): IndexSplitPageConsumer | null { return consumer; }

/** The effect kinds this process claims: the built-in ones, plus `index-split-page` once a consumer is registered. */
export function claimableEffectKinds(builtIn: readonly string[]): string[] {
  return consumer ? [...builtIn, INDEX_SPLIT_PAGE_EFFECT] : [...builtIn];
}

/** The git-first floor: the BEHAVIOR_CHANGES row's `since`, or this build's VERSION while it is 'TBD'. */
export async function gitFirstWriterFloor(): Promise<string> {
  const [{ BEHAVIOR_CHANGES }, { VERSION }] = await Promise.all([import('../behavior-change-notice.ts'), import('../../version.ts')]);
  const row = BEHAVIOR_CHANGES.find(change => change.id === GIT_FIRST_CHANGE);
  if (!row) throw new Error(`BEHAVIOR_CHANGES has no row with id ${GIT_FIRST_CHANGE}`);
  return row.since === 'TBD' ? VERSION : row.since;
}

let writerGate = new WeakMap<object, { at: number; blockers: SegmentedGateWriter[] }>();

function engineRoot(engine: object): object {
  let root: object = engine;
  for (let proto = Object.getPrototypeOf(root); proto && !Object.hasOwn(proto, 'constructor'); proto = Object.getPrototypeOf(proto)) root = proto;
  return root;
}

/**
 * Writers seen in the last `GIT_FIRST_WRITER_WINDOW_DAYS` days stamped below the git-first floor, by any role (admitter,
 * consumer, importer, resident; an unstamped writer counts as below). Any one keeps the path off on every strict source.
 * Cached per engine for `GIT_FIRST_GATE_TTL_MS`; `fresh` (doctor, tests) reads through.
 */
export async function gitFirstWriterBlockers(engine: Pick<BrainEngine, 'executeRaw'>, opts: { fresh?: boolean } = {}): Promise<SegmentedGateWriter[]> {
  const root = engineRoot(engine);
  const cached = writerGate.get(root);
  if (!opts.fresh && cached && Date.now() - cached.at < GIT_FIRST_GATE_TTL_MS) return cached.blockers;
  const [{ segmentedGateEvidence, writerVersionBelowFloor }, floor] = await Promise.all([import('./writer-versions.ts'), gitFirstWriterFloor()]);
  const blockers = (await segmentedGateEvidence(engine, GIT_FIRST_WRITER_WINDOW_DAYS)).filter(row => writerVersionBelowFloor(row.version, floor));
  writerGate.set(root, { at: Date.now(), blockers });
  return blockers;
}

/** Test seam: forget cached writer-gate reads. */
export function _resetGitFirstGateForTests(): void { writerGate = new WeakMap(); }

/**
 * Whether the git-first strict path is on for `sourceId`: a registered consumer, a strict source, and no recent writer
 * below the floor. `strict` skips the source read when the caller already knows the source's flag.
 */
export async function gitFirstStrictActive(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, opts: { strict?: boolean; fresh?: boolean } = {}): Promise<boolean> {
  if (!consumer) return false;
  const strict = opts.strict ?? (await engine.executeRaw<{ strict: boolean }>(
    `SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1`, [sourceId]))[0]?.strict === true;
  if (!strict) return false;
  return (await gitFirstWriterBlockers(engine, opts)).length === 0;
}
