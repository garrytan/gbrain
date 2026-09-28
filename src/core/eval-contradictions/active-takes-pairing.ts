/**
 * eval-contradictions/active-takes-pairing — candidate pairs for the
 * `active_takes` strategy (dream `take_contradictions` phase).
 *
 * Unlike the two query-driven strategies (cross_slug_chunks,
 * intra_page_chunk_take), this one has no search query to scope pairs to —
 * it runs corpus-wide. To stay bounded (never full O(n^2) over every active
 * take), it generates candidates from two cheap, capped clustering passes
 * over one shared pool of recent active takes:
 *
 *   1. Holder cluster — the same holder's own takes on DIFFERENT pages
 *      (catches "this person's stated position here disagrees with their
 *      stated position there").
 *   2. Topical cluster — a take's nearest embedding neighbors on a
 *      DIFFERENT page (catches "two different holders, same topic" — the
 *      primary case this strategy exists for).
 *
 * Two takes on the SAME page are never paired here — that's
 * intra_page_chunk_take's job, not this one's.
 */

import type { BrainEngine, Take, TakeHit } from '../engine.ts';
import { classifySlugTier } from './cross-source.ts';
import { takeToMember } from './runner.ts';
import type { ContradictionPair } from './types.ts';

export interface ActiveTakesPairingOpts {
  /** Size of the candidate pool pulled from listTakes. */
  maxCandidateTakes: number;
  /** Max pairs contributed per holder (lazy cap, not exhaustive combinations). */
  maxPerHolderPairs: number;
  /** Max vector neighbors considered per candidate take. */
  maxNeighborsPerTake: number;
}

interface TakeLike {
  id: number;
  row_num: number;
  page_slug: string;
  claim: string;
  holder: string;
  /** Cheap temporal anchor (Step 2: free, already on the Take row). Null
   *  when unavailable, e.g. a TakeHit from vector search carries no date. */
  since_date: string | null;
}

function takeToTakeLike(t: Take): TakeLike {
  return { id: t.id, row_num: t.row_num, page_slug: t.page_slug, claim: t.claim, holder: t.holder, since_date: t.since_date };
}

function hitToTakeLike(hit: TakeHit): TakeLike {
  return { id: hit.take_id, row_num: hit.row_num, page_slug: hit.page_slug, claim: hit.claim, holder: hit.holder, since_date: null };
}

function pairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

function buildPair(a: TakeLike, aPageId: number, b: TakeLike, bPageId: number): ContradictionPair | null {
  if (aPageId === bPageId) return null; // same page → intra_page_chunk_take's job, not ours
  const aTier = classifySlugTier(a.page_slug);
  const bTier = classifySlugTier(b.page_slug);
  return {
    kind: 'active_takes',
    a: takeToMember(a, aTier, a.since_date, a.since_date ? 'takes.since_date' : null),
    b: takeToMember(b, bTier, b.since_date, b.since_date ? 'takes.since_date' : null),
    // No retrieval score exists for a corpus-wide pair; 1.0 matches
    // intra_page_chunk_take's convention for its take side.
    combined_score: 1.0,
  };
}

export async function generateActiveTakesPairs(
  engine: BrainEngine,
  opts: ActiveTakesPairingOpts,
): Promise<ContradictionPair[]> {
  const candidates: Take[] = await engine.listTakes({
    active: true,
    limit: opts.maxCandidateTakes,
    sortBy: 'created_at',
  });
  if (candidates.length < 2) return [];

  const seenPairs = new Set<string>();
  const pairs: ContradictionPair[] = [];

  const tryAdd = (a: TakeLike, aPageId: number, b: TakeLike, bPageId: number) => {
    const key = pairKey(a.id, b.id);
    if (seenPairs.has(key)) return;
    const pair = buildPair(a, aPageId, b, bPageId);
    if (!pair) return;
    seenPairs.add(key);
    pairs.push(pair);
  };

  // Pass 1: same holder, different pages.
  const byHolder = new Map<string, Take[]>();
  for (const c of candidates) {
    const list = byHolder.get(c.holder);
    if (list) list.push(c);
    else byHolder.set(c.holder, [c]);
  }
  for (const holderTakes of byHolder.values()) {
    if (holderTakes.length < 2) continue;
    let addedForHolder = 0;
    outer: for (let i = 0; i < holderTakes.length; i++) {
      for (let j = i + 1; j < holderTakes.length; j++) {
        if (addedForHolder >= opts.maxPerHolderPairs) break outer;
        const before = pairs.length;
        tryAdd(
          takeToTakeLike(holderTakes[i]), holderTakes[i].page_id,
          takeToTakeLike(holderTakes[j]), holderTakes[j].page_id,
        );
        if (pairs.length > before) addedForHolder++;
      }
    }
  }

  // Pass 2: embedding neighbors on a different page (the primary
  // cross-holder case buildJudgePrompt's crossHolderDisagreementCounts
  // mode exists to catch). One vector search per embedded candidate — up to
  // maxCandidateTakes independent, unrelated DB round trips, so they run
  // concurrently rather than serially awaiting one at a time.
  const embeddings = await engine.getTakeEmbeddings(candidates.map((c) => c.id));
  const embedded = candidates.filter((c) => embeddings.has(c.id));
  const neighborLists = await Promise.all(
    embedded.map((c) =>
      engine.searchTakesVector(embeddings.get(c.id)!, {
        limit: opts.maxNeighborsPerTake + 1, // +1: the candidate itself is its own nearest neighbor
      }),
    ),
  );
  embedded.forEach((candidate, i) => {
    let addedForCandidate = 0;
    for (const hit of neighborLists[i]!) {
      if (addedForCandidate >= opts.maxNeighborsPerTake) break;
      if (hit.take_id === candidate.id) continue;
      if (hit.page_id === candidate.page_id) continue;
      const before = pairs.length;
      tryAdd(takeToTakeLike(candidate), candidate.page_id, hitToTakeLike(hit), hit.page_id);
      if (pairs.length > before) addedForCandidate++;
    }
  });

  return pairs;
}
