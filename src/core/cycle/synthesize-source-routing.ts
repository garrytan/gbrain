/**
 * #7805: dream synthesis writes a captured session's pages to the session's own
 * source, the one #6268 froze for it, never to the cycle's source.
 *
 * Every corpus file resolves through `resolveCorpusFileSource`, the resolver the
 * facts sweep uses (sweep.ts, "#6268 source fidelity"): a spool file's stamp, or
 * its session's frozen record (an unresolved record with a cwd is frozen first,
 * from the brain's resolution chain, exactly as the sweep does), and a top-level
 * legacy file only with durable evidence of its source. A file of the cycle's
 * source is synthesized; a file of another source is skipped
 * (`corpus_source_other`) and synthesizes when the phase runs for that source; a
 * file with no evidence of its source is held with the resolver's reason. Nothing
 * falls back to the cycle's source. Files outside the session corpus (the meeting
 * transcripts dir, an `--input` file elsewhere) and imported conversation pages
 * (read from the cycle's source) are not session captures and pass unchanged.
 * extract_atoms routes its session-corpus transcripts through the same two
 * functions (#7846).
 *
 * A file is a corpus file when its spelled path or its real path lies in the
 * corpus (listing follows symlinks, so an aliasing meeting dir or a linked
 * spool dir still names corpus files); a path whose real path cannot be read is
 * held (`corpus_path_unresolvable`), never passed through (#7871). Work queued
 * or retained by an earlier run is checked again before it writes: a synthesis
 * child re-resolves its pinned file (`corpusSourceChanged`, #7850), and an
 * explicit atom retry or a resumed generation member re-checks its transcript
 * (`transcriptSourceHold`, #7869, #7870). Dry runs resolve read-only.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { corpusSpoolDir } from '../context/corpus-segments.ts';
import { resolveCorpusFileSource, type CorpusFileLocation, type CorpusFileSource } from '../context/corpus-source.ts';
import { CONVERSATION_PAGE_URI_PREFIX, type DiscoveredTranscript } from './transcript-discovery.ts';
import { UnrecoverableError } from '../minions/types.ts';

export interface SessionSourceRouting {
  /** Corpus files of other sources (`corpus_source_other`), counted by the source each belongs to. */
  corpus_source_other: Record<string, number>;
  /** Corpus files with no evidence of their source, counted by the resolver's hold reason. */
  held: Record<string, number>;
  /** extract_atoms: pending generation members not resubmitted because their transcript no longer resolves to this source, by reason. */
  generation_members_held?: Record<string, number>;
}

export const emptySessionSourceRouting = (): SessionSourceRouting => ({ corpus_source_other: {}, held: {} });

/** The corpus file a synthesis child writes for, and the source incarnation discovery resolved it to (#7850). */
export interface CorpusSourcePin { raw_source: string; corpus_dir: string; incarnation: string }

function realpathOrMissing(path: string): string | null | undefined {
  try { return realpathSync(path); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
}

function locate(file: string, root: string, spool: string | null): CorpusFileLocation | null {
  const rel = relative(root, file);
  if (dirname(file) === spool) return 'spool';
  return !rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) ? null : 'legacy';
}

function corpusLocation(filePath: string, corpusDir: string): CorpusFileLocation | 'unresolvable' | null {
  const root = resolve(corpusDir);
  const lexical = locate(resolve(filePath), root, resolve(corpusSpoolDir(root)));
  const realRoot = realpathOrMissing(root);
  if (realRoot === null) return lexical;
  const realSpool = realpathOrMissing(corpusSpoolDir(root));
  const realFile = realpathOrMissing(filePath);
  if (realFile === null && !lstatSync(filePath, { throwIfNoEntry: false })) return lexical;
  if (realRoot === undefined || realSpool === undefined || !realFile) return 'unresolvable';
  const real = locate(realFile, realRoot, realSpool);
  return lexical === 'spool' || real === 'spool' ? 'spool' : lexical ?? real;
}

/** The session source of a corpus file, or null when `filePath` is not a corpus file (an unreadable real path is held). */
export async function corpusFileOwner(engine: BrainEngine, filePath: string, corpusDir: string | null,
  opts: { readOnly?: boolean } = {}): Promise<CorpusFileSource | null> {
  if (!corpusDir || filePath.startsWith(CONVERSATION_PAGE_URI_PREFIX)) return null;
  const location = corpusLocation(filePath, corpusDir);
  if (location === 'unresolvable') return { ok: false, reason: 'corpus_path_unresolvable' };
  return location ? resolveCorpusFileSource(engine, corpusDir, basename(filePath), location, opts) : null;
}

/** The transcripts this cycle may synthesize into `sourceId`, each corpus file pinned; every other corpus file is counted in `routing`. */
export async function keepSessionSourceTranscripts<T extends DiscoveredTranscript>(engine: BrainEngine, transcripts: T[],
  opts: { corpusDir: string | null; sourceId: string; readOnly?: boolean }, routing: SessionSourceRouting): Promise<Array<T & { corpusSource?: CorpusSourcePin }>> {
  const kept: Array<T & { corpusSource?: CorpusSourcePin }> = [];
  for (const t of transcripts) {
    const owner = await corpusFileOwner(engine, t.filePath, opts.corpusDir, opts);
    if (!owner) kept.push(t);
    else if (!owner.ok) routing.held[owner.reason] = (routing.held[owner.reason] ?? 0) + 1;
    else if (owner.sourceId !== opts.sourceId) routing.corpus_source_other[owner.sourceId] = (routing.corpus_source_other[owner.sourceId] ?? 0) + 1;
    else kept.push({ ...t, corpusSource: { raw_source: t.filePath, corpus_dir: opts.corpusDir!, incarnation: owner.incarnation } });
  }
  return kept;
}

/**
 * Why a transcript an earlier run extracted may not be written into `sourceId` now, or null: a corpus file must resolve
 * to `sourceId`, and any other transcript is a meeting file, which only `default` reads (#7846).
 */
export async function transcriptSourceHold(engine: BrainEngine, filePath: string,
  opts: { corpusDir: string | null; sourceId: string }): Promise<{ reason: string; owner?: string } | null> {
  const owner = await corpusFileOwner(engine, filePath, opts.corpusDir);
  if (!owner) return opts.sourceId === 'default' ? null : { reason: 'transcript_outside_corpus' };
  if (!owner.ok) return { reason: owner.reason };
  return owner.sourceId === opts.sourceId ? null : { reason: 'corpus_source_other', owner: owner.sourceId };
}

/** Why a queued synthesis child may no longer write `pin.raw_source`'s pages into `sourceId`, or null (read-only). */
export async function corpusSourceChanged(engine: BrainEngine, pin: { raw_source: string; corpus_dir: string | null; incarnation?: string },
  sourceId: string): Promise<string | null> {
  const owner = await corpusFileOwner(engine, pin.raw_source, pin.corpus_dir, { readOnly: true });
  if (!owner) return pin.incarnation ? 'corpus_path_unresolvable' : null;
  if (!owner.ok) return owner.reason;
  if (owner.sourceId !== sourceId) return 'corpus_source_other';
  return pin.incarnation && owner.incarnation !== pin.incarnation ? 'corpus_source_incarnation_changed' : null;
}

/**
 * A dream synthesis child's check before any model call: refused (`session_source_changed: <reason>`, no retry) when its
 * pinned file no longer resolves to the job's source or incarnation. A child queued before the pin existed is checked
 * from `dream_output.raw_source` and the configured corpus dir, which only a managed brain's children carry; an unmanaged
 * child queued before the pin has neither and runs unchecked.
 */
export async function refuseChangedSessionSource(engine: BrainEngine,
  data: { corpus_source?: CorpusSourcePin; dream_output?: { raw_source: string }; source_id?: string }): Promise<void> {
  if (!data.corpus_source && !data.dream_output) return;
  const sourceId = data.source_id ?? 'default';
  const pin = data.corpus_source ?? { raw_source: data.dream_output!.raw_source,
    corpus_dir: await engine.getConfig('dream.synthesize.session_corpus_dir').catch(() => null) };
  const changed = await corpusSourceChanged(engine, pin, sourceId);
  if (changed) throw new UnrecoverableError(`session_source_changed: ${changed}: the session of ${pin.raw_source} no longer resolves to source ${sourceId} as it did when this job was queued, so nothing was synthesized or written. It synthesizes when the dream runs for its own source, or after gbrain sweep --assign-corpus <source> maps it.`);
}

/** Names every corpus file the phase left out, with the command that synthesizes (or extracts) or releases it. */
export function withSessionSourceRouting(result: PhaseResult, routing: SessionSourceRouting, sourceId: string,
  phase: 'synthesize' | 'extract_atoms' = 'synthesize'): PhaseResult {
  const others = Object.entries(routing.corpus_source_other).sort(([a], [b]) => a.localeCompare(b));
  const held = Object.entries(routing.held).sort(([a], [b]) => a.localeCompare(b));
  const members = Object.entries(routing.generation_members_held ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!others.length && !held.length && !members.length) return result;
  const otherCount = others.reduce((n, [, c]) => n + c, 0);
  const heldCount = held.reduce((n, [, c]) => n + c, 0);
  const memberCount = members.reduce((n, [, c]) => n + c, 0);
  const fix = [
    ...others.map(([id]) => `gbrain dream --source ${id} --phase ${phase}`),
    ...(heldCount ? ['gbrain sweep --assign-corpus <source>'] : []),
    ...(memberCount ? [`gbrain doctor --only generation_pending --json`] : []),
  ];
  const parts = [
    ...(otherCount ? [`${otherCount} corpus file(s) belong to other sources (${others.map(([id, c]) => `${id}: ${c}`).join(', ')}) and ${phase === 'synthesize' ? 'synthesize' : 'extract'} only under their own source`] : []),
    ...(heldCount ? [`${heldCount} held with no frozen session source (${held.map(([r, c]) => `${r}: ${c}`).join(', ')})`] : []),
    ...(memberCount ? [`${memberCount} pending generation member(s) held, not resubmitted: their transcript no longer resolves to this source (${members.map(([r, c]) => `${r}: ${c}`).join(', ')})`] : []),
  ];
  process.stderr.write(`[dream] ${phase} for source ${sourceId}: ${parts.join('; ')}. Fix: ${fix.join(' | ')}\n`);
  return { ...result, summary: `${result.summary}; ${parts.join('; ')}`,
    details: { ...result.details, source_routing: { source_id: sourceId, ...routing, fix } } };
}
