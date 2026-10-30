/**
 * GBRA-60: the publication steps of one synthesize_concepts run (cycle/synthesize-concepts.ts). A concept publishes
 * private, or once at world when its banked provenance edges already cover every member (#5525); its edges are banked
 * against the revision that publication produced; a world concept whose edges now cover its members is promoted. An
 * unmanaged brain runs those steps per concept (publishClassicConcept). A managed brain queues its concepts and
 * publishes them in batches (publishManagedConcepts): every first publication in one maintenance batch, the edges, then
 * the world promotions in a second, so Postgres publishes a run's concepts as one group.
 */
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { Visibility } from '../search/private-visibility.ts';
import type { MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { isAvailable } from '../ai/gateway.ts';
// #2163: unmanaged concept pages route through importFromContent (the same
// parse→chunk→embed pipeline put_page uses) instead of a bare engine.putPage,
// so they land in the retrieval surface (content_chunks + embeddings) where
// source-boost's 1.3× 'concepts/' weighting can actually reach them.
import { importFromContent } from '../import-file.ts';
import type { ConceptRetryBound } from './concept-retry-bound.ts';
import {
  conceptProvenanceCovers, replaceConceptProvenanceLinks, CONCEPT_DEFERRAL_CODES, CONCEPT_HOLD_CODES, publishClassicConcept, publishManagedConcepts,
} from './concept-publication.ts';

/** Managed concepts a run holds before publishing them as one batch: put_pages' page cap (page-batch.ts PAGE_BATCH_MAX_PAGES). */
const MANAGED_CONCEPT_BATCH = 50;

/** A concept this run publishes, with what its publication steps need. */
export interface ConceptWrite {
  /** The concept's stem, as the run's outcome lists name it. */
  concept: string;
  conceptSlug: string;
  atomSlugs: string[];
  visibility: Visibility;
  covered: boolean;
  synthesisMode: string;
  synthesized: (pageVisibility: Visibility) => Record<string, unknown>;
  narrative: string;
  /** Managed: the revision the next publication is bound to (the revision the narrative was synthesized from, then each publication's result). */
  revision: string | null;
  /** Unmanaged: the narrative the page held when synthesis started; a different narrative under the page lock defers the concept (D-N3). */
  baseline: string;
}

export interface ConceptWriterDeps {
  engine: BrainEngine;
  maintenance: MaintenanceAuthority | null;
  /** The cycle's resolved source (#4416); `importSourceId` is the caller's own, passed to the unmanaged import as given. */
  sourceId: string;
  importSourceId?: string;
  brainDir?: string;
  writeThrough: boolean;
  retries: ConceptRetryBound;
  publicationDeferred: Array<{ concept: string; reason: string }>;
  publicationHeld: Array<{ concept: string; reason: string }>;
  linkWarnings: Array<{ concept: string; warning: string }>;
  /** Called once per concept whose publication steps all landed. */
  written: () => void;
}

export function conceptWriter(deps: ConceptWriterDeps) {
  const { engine, maintenance, sourceId: src } = deps;
  // A publication that lost a revision race or would lose canonical
  // material is recorded and skipped; any other error stops the phase.
  const recorded = (write: ConceptWrite, err: unknown): false => {
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string') throw err;
    const reason = `${code}: ${(err as Error).message}`;
    if (CONCEPT_DEFERRAL_CODES.has(code)) deps.publicationDeferred.push({ concept: write.concept, reason });
    else if (CONCEPT_HOLD_CODES.has(code)) deps.publicationHeld.push({ concept: write.concept, reason });
    else throw err;
    return false;
  };
  const publishClassic = async (write: ConceptWrite, pageVisibility: Visibility): Promise<boolean> => {
    try {
      write.baseline = await publishClassicConcept(engine, write.conceptSlug, src, write.synthesized(pageVisibility), write.narrative,
        write.baseline, { writeThrough: deps.writeThrough, members: write.atomSlugs, importPage: (markdown) => importFromContent(engine, write.conceptSlug, markdown, {
          noEmbed: !isAvailable('embedding'), sourceId: deps.importSourceId, preserveGateMarkers: true,
        }) });
      return true;
    } catch (err) { return recorded(write, err); }
  };
  /**
   * #4589: bank concept<->member-atom provenance edges after a concept's first publication. The prompt forbids
   * enumerating atoms in the body and no frontmatter field maps to a link verb, so without this every concept page
   * lands with zero edges (graph orphan). Dedicated link_source keeps reconcile passes from pruning them; both
   * endpoints sit in the cycle's source (an atom living in another source drops out of the batch JOIN — no
   * cross-source edge). ON CONFLICT DO NOTHING makes re-runs idempotent, so a failure here is best-effort: recorded
   * as a warn, the page write stands. Mirrors #3961. Returns whether the concept now goes to world.
   */
  const bankProvenance = async (write: ConceptWrite): Promise<boolean> => {
    const { conceptSlug } = write;
    if (write.synthesisMode === 'llm') deps.retries.succeed(`${src}:${conceptSlug}`);
    const provenanceLinks: LinkBatchInput[] = [...new Set(write.atomSlugs)].flatMap((atomSlug) => [
      { from_slug: conceptSlug, to_slug: atomSlug, link_type: 'synthesized_from', link_source: 'concept-provenance', context: 'member atom', from_source_id: src, to_source_id: src },
      { from_slug: atomSlug, to_slug: conceptSlug, link_type: 'synthesizes', link_source: 'concept-provenance', context: 'concept synthesized from this atom', from_source_id: src, to_source_id: src },
    ]);
    try {
      const written = await replaceConceptProvenanceLinks(engine, src, conceptSlug, provenanceLinks, { expectedRevision: maintenance ? write.revision : null, managed: !!maintenance });
      // Zero rows back with edges requested means every member atom fell
      // out of the batch JOIN (not in this source) — unless a prior run
      // already banked them (ON CONFLICT DO NOTHING also returns 0). A
      // silent 'ok' here is a graph orphan with a clean receipt.
      if (written === 'moved') deps.linkWarnings.push({ concept: write.concept, warning: 'provenance links: the concept changed after it was published, so its edges were left as they were; the next run reconciles them' });
      else if (written.inserted === 0 && provenanceLinks.length > 0) {
        const banked = (await engine.getLinks(conceptSlug, { sourceId: src }))
          .some((l) => l.link_source === 'concept-provenance');
        if (!banked) {
          deps.linkWarnings.push({ concept: write.concept, warning: `provenance links: 0 of ${provenanceLinks.length} edges landed (member atoms not in source '${src}'?)` });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.linkWarnings.push({ concept: write.concept, warning: `provenance links failed: ${msg}` });
      console.error(`[synthesize_concepts] provenance links failed for ${conceptSlug} (non-fatal): ${msg}`);
    }
    return write.visibility === 'world' && !write.covered && await conceptProvenanceCovers(engine, src, conceptSlug, write.atomSlugs);
  };
  /** One managed batch; each concept settles on its own, and the ones that published carry their new revision. */
  const publishManaged = async (writes: ConceptWrite[], pageVisibility: (write: ConceptWrite) => Visibility): Promise<ConceptWrite[]> => {
    const outcomes = writes.length ? await publishManagedConcepts(engine, maintenance!, writes.map(write => ({ slug: write.conceptSlug,
      synthesized: write.synthesized(pageVisibility(write)), narrative: write.narrative, expectedRevision: write.revision, members: write.atomSlugs })), deps.brainDir) : [];
    return writes.filter((write, i) => {
      const outcome = outcomes[i]!;
      if ('error' in outcome) return recorded(write, outcome.error);
      write.revision = outcome.revision;
      return true;
    });
  };
  let pending: ConceptWrite[] = [];
  const flush = async () => {
    const writes = pending;
    pending = [];
    const promote: ConceptWrite[] = [];
    for (const write of await publishManaged(writes, write => write.covered ? 'world' : 'private')) {
      if (await bankProvenance(write)) promote.push(write);
      else deps.written();
    }
    for (const _ of await publishManaged(promote, () => 'world')) deps.written();
  };
  return {
    /** Unmanaged: the concept's publication steps, now; a recorded refusal skips the rest. */
    async publish(write: ConceptWrite): Promise<void> {
      if (!await publishClassic(write, write.covered ? 'world' : 'private')) return;
      if (await bankProvenance(write) && !await publishClassic(write, 'world')) return;
      deps.written();
    },
    /** Managed: queue the concept; a full queue publishes. */
    async queue(write: ConceptWrite): Promise<void> {
      pending.push(write);
      if (pending.length >= MANAGED_CONCEPT_BATCH) await flush();
    },
    /** Managed: publish whatever is queued. */
    flush,
  };
}
