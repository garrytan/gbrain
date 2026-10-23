/**
 * GBRA-161 PR 4 (#7065, plan D3; Captain decision (a), applying the plan Garry approved on Oct 21: replace only on a
 * complete, non-empty result, always version first, always reversible): the activation of each re-synthesized
 * transcript's outputs, run after postprocess and the provenance stamp. New outputs publish as they always did (the
 * children write them); this records them as the transcript's new `synthesis` generation and retires an earlier output
 * only when it is matched (generations/synthesis-coverage.ts). An unmatched earlier output stays live and
 * `gbrain repair generations --kind synthesis --mode cleanup` lists it.
 *
 * A transcript is complete only when every child job of every chunk completed after reading its whole chunk; otherwise
 * (or with `generations.synthesis.retire_previous` off) its generation is partial: the new outputs are recorded and
 * nothing retires. The shrink floor and the valve of the primitive still apply.
 */
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import type { ProposedItem } from '../generations/contract.ts';
import { publishGeneration, readLiveGeneration, type PublishRequest } from '../generations/publish.ts';
import { planManagedGeneration } from '../generations/managed.ts';
import { admitInPlaceGeneration, resumeRetireMembers } from '../generations/managed-retire.ts';
import { SYNTHESIS_KIND, synthesisAdapter, synthesisOwnerKey, type SynthesisGenerationContext } from '../generations/adapters/synthesis.ts';
import { matchPredecessor, type PredecessorMatch, type SynthesisPage } from '../generations/synthesis-coverage.ts';
import { removeDreamPageFile } from './derived-write-through.ts';
import { resolveTranscriptKeys, transcriptRoot } from './extract-atoms-generation.ts';

export const RETIRE_PREVIOUS_KEY = 'generations.synthesis.retire_previous';

/** `generations.synthesis.retire_previous`: on unless set to false, off, no or 0. */
export async function retirePreviousEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = (await engine.getConfig(RETIRE_PREVIOUS_KEY).catch(() => null))?.trim().toLowerCase();
  return !['false', 'off', 'no', '0'].includes(value ?? '');
}

type Unmatched = Extract<PredecessorMatch, { matched: false }>;
/** An earlier output the activation left live: why (`unreadable`: segmented or gone, never compared) and what it holds alone. */
export interface UnmatchedPredecessor { slug: string; why: Unmatched['why'] | 'unreadable'; missing: Unmatched['missing'] | null }

export interface SynthesisActivationDetails {
  activated: number;
  partial: number;
  retired: string[];
  unmatched: string[];
  held: Array<{ owner_key: string; reason: string }>;
  failed: Array<{ owner_key: string; error: string }>;
  file_holds: string[];
  resumed_members: number;
}

export interface SynthesisActivationInput {
  sourceId: string;
  maintenance: MaintenanceAuthority | null;
  brainDir: string;
  transcripts: ReadonlyArray<{ filePath: string; contentHash: string; content: string; basename: string }>;
  refs: ReadonlyArray<{ slug: string; source_id: string; raw_source?: string }>;
  outcomes: ReadonlyArray<{ jobId: number; status: string }>;
  jobRawSource: ReadonlyMap<number, string>;
  /** Basenames whose submission was deferred or cancelled this run (never complete). */
  deferred: ReadonlySet<string>;
  /** A publication still pending or in conflict: no transcript is complete this run. */
  publicationIncomplete: boolean;
  corpusDir: string | null;
  meetingDir: string | null;
}

async function pages(engine: BrainEngine, sourceId: string, slugs: readonly string[]): Promise<SynthesisPage[]> {
  if (!slugs.length) return [];
  const rows = await engine.executeRaw<{ slug: string; title: string | null; body: string | null }>(
    `SELECT slug, title, COALESCE(compiled_truth, '') || E'\\n' || COALESCE(timeline, '') AS body FROM pages
      WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL AND body_storage <> 'segmented' ORDER BY slug`, [sourceId, [...slugs]]);
  return rows.map(row => ({ slug: row.slug, title: row.title ?? '', body: row.body ?? '' }));
}

/** Activates one synthesis generation per transcript this run synthesized; never throws for one transcript. */
export async function activateSynthesisGenerations(engine: BrainEngine, input: SynthesisActivationInput): Promise<SynthesisActivationDetails> {
  const details: SynthesisActivationDetails = { activated: 0, partial: 0, retired: [], unmatched: [], held: [], failed: [], file_holds: [], resumed_members: 0 };
  const { sourceId, maintenance } = input;
  if (maintenance) details.resumed_members = await resumeRetireMembers(engine, maintenance, SYNTHESIS_KIND);
  const submitted = input.transcripts.filter(t => [...input.jobRawSource.values()].includes(t.filePath));
  if (!submitted.length) return details;
  const retireOn = await retirePreviousEnabled(engine);
  const keys = await resolveTranscriptKeys(engine, sourceId, submitted.map(t => ({ filePath: t.filePath, contentHash: t.contentHash,
    ...(isAbsolute(t.filePath) && input.corpusDir ? { root: transcriptRoot(t.filePath, input.corpusDir, input.meetingDir ?? undefined) } : {}) })), false, SYNTHESIS_KIND);
  for (const t of submitted) {
    const key = { kind: SYNTHESIS_KIND, sourceId, ownerKey: synthesisOwnerKey(keys.get(t.filePath) ?? t.filePath) };
    try {
      const jobs = [...input.jobRawSource].filter(([, path]) => path === t.filePath).map(([jobId]) => jobId);
      const complete = !input.publicationIncomplete && !input.deferred.has(t.basename)
        && jobs.every(jobId => input.outcomes.find(outcome => outcome.jobId === jobId)?.status === 'completed');
      const context: SynthesisGenerationContext = { locator: t.filePath, transcriptInput: { pin: t.contentHash, size: Buffer.byteLength(t.content) } };
      const fresh = [...new Set(input.refs.filter(ref => ref.source_id === sourceId && ref.raw_source === t.filePath).map(ref => ref.slug))];
      const live = await readLiveGeneration(engine, key);
      const earlier = [...(live?.items.keys() ?? [])].filter(slug => !fresh.includes(slug));
      if (!fresh.length && !live) continue;
      const partial = !complete || !retireOn;
      const unmatched: UnmatchedPredecessor[] = [];
      if (!partial) {
        const successors = await pages(engine, sourceId, fresh);
        const readable = new Map((await pages(engine, sourceId, earlier)).map(page => [page.slug, page]));
        for (const slug of earlier) {
          const page = readable.get(slug);
          const match = page ? matchPredecessor(page, successors) : null;
          if (!match) unmatched.push({ slug, why: 'unreadable', missing: null });
          else if (!match.matched) unmatched.push({ slug, why: match.why, missing: match.missing });
        }
      }
      const proposed = partial ? fresh : [...fresh, ...unmatched.map(entry => entry.slug)];
      const rows = await synthesisAdapter.readItems(engine, key, proposed, context);
      const items: ProposedItem[] = proposed.flatMap(slug => { const row = rows.get(slug); return row?.live ? [{ key: slug, content: '', identityHash: row.identityHash }] : []; });
      const request: PublishRequest<SynthesisGenerationContext> = { key, items, input: context.transcriptInput, partial, context, locator: t.filePath,
        ...(unmatched.length ? { note: { unmatched } } : {}) };
      let retired: string[] = [];
      if (maintenance) {
        const plan = await planManagedGeneration(engine, synthesisAdapter, request, { locator: t.filePath });
        if (plan.kind === 'held') { details.held.push({ owner_key: key.ownerKey, reason: plan.outcome.reason }); continue; }
        if (plan.kind === 'unchanged') continue;
        await admitInPlaceGeneration(engine, maintenance, plan);
        retired = plan.members.filter(member => member.action === 'retire').map(member => member.slug);
      } else {
        const outcome = await publishGeneration(engine, synthesisAdapter, request);
        if (outcome.state === 'held') { details.held.push({ owner_key: key.ownerKey, reason: outcome.reason }); continue; }
        if (outcome.state === 'unchanged') continue;
        retired = outcome.retired;
        for (const slug of retired) {
          const file = await removeDreamPageFile(engine, input.brainDir, slug, sourceId, sourceId);
          if (file.held) details.file_holds.push(file.held);
        }
      }
      details.activated++;
      if (partial) details.partial++;
      details.retired.push(...retired);
      details.unmatched.push(...unmatched.map(entry => entry.slug));
    } catch (error) {
      details.failed.push({ owner_key: key.ownerKey, error: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`[dream] synthesize: the synthesis generation of ${key.ownerKey} was not activated (${error instanceof Error ? error.message : String(error)}); every output stays live.\n`);
    }
  }
  return details;
}
