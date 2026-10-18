/**
 * #5575 I2 taint for the dream derivers (ENG-3): the tier of a synthesis or
 * patterns output is the least trusted input placed in the child's prompt,
 * capped at agent_written.
 *
 * - Synthesis: each child reads one transcript. A conversation page
 *   (`gbrain-page://<source>/<slug>`) is that page's stored tier; a corpus
 *   file is the cap its frontmatter names, else agent_written (the user's own
 *   sessions: relayed user turns are agent_written); a file under the meeting
 *   transcripts directory is third-party speech, external_untrusted.
 * - The dream summary page indexes the pages it lists.
 * - Patterns: each pass's outputs take the least trusted reflection submitted
 *   in that pass (patterns.ts partitions external reflections into their own pass).
 */
import { resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { parseMarkdown } from '../markdown.ts';
import { declareDerivation, deriveTrust, derivedMaintenanceTransaction, derivedWriteTrust, frontmatterTaint, type DerivationDeclaration } from '../trust/taint.ts';
import type { TaintInput, TrustTier, WriteTrust } from '../trust/tier.ts';
import { CONVERSATION_PAGE_URI_PREFIX } from './transcript-discovery.ts';

export interface Derivation { trust: WriteTrust; inputs: TaintInput[] }

/** The derivation of every page a synthesis child wrote from one transcript. */
export async function transcriptDerivation(engine: Pick<BrainEngine, 'executeRaw'>, transcript: { filePath: string; content?: string } | undefined,
  meetingTranscriptsDir?: string | null): Promise<Derivation> {
  const channel = 'derive:synthesize';
  if (!transcript) return { trust: derivedWriteTrust({ channel, inputs: [], lowerTo: ['unknown'] }), inputs: [] };
  const sourceUri = transcript.filePath;
  if (sourceUri.startsWith(CONVERSATION_PAGE_URI_PREFIX)) {
    const rest = sourceUri.slice(CONVERSATION_PAGE_URI_PREFIX.length);
    const cut = rest.indexOf('/');
    return deriveTrust(engine, [{ table: 'pages', sourceId: rest.slice(0, cut), slug: rest.slice(cut + 1) }], { channel, sourceUri });
  }
  const meeting = !!meetingTranscriptsDir && resolve(sourceUri).startsWith(resolve(meetingTranscriptsDir) + sep);
  let cap: TrustTier = meeting ? 'external_untrusted' : 'agent_written';
  if (!meeting && transcript.content) {
    try { cap = frontmatterTaint(parseMarkdown(transcript.content).frontmatter) ?? cap; } catch { cap = 'unknown'; }
  }
  return { trust: derivedWriteTrust({ channel, inputs: [], lowerTo: [cap], sourceUri }), inputs: [] };
}

/** The derivation of a page written from several transcripts (the unmanaged quote-repair writeback): the least trusted of them. */
export async function transcriptsDerivation(engine: Pick<BrainEngine, 'executeRaw'>, transcripts: Array<{ filePath: string; content?: string }>,
  meetingTranscriptsDir?: string | null): Promise<Derivation> {
  const each = await Promise.all(transcripts.map(t => transcriptDerivation(engine, t, meetingTranscriptsDir)));
  if (each.length === 1) return each[0];
  const inputs = each.flatMap(d => d.inputs);
  return { inputs, trust: derivedWriteTrust({ channel: 'derive:synthesize', inputs, lowerTo: each.length ? each.map(d => d.trust.tier) : ['unknown'] }) };
}

/** Synthesis output refs with the derivation of the transcript each was written from (the unmanaged provenance stamp). */
export async function withTranscriptTaint<R extends { raw_source?: string }>(engine: BrainEngine, refs: R[],
  transcripts: Array<{ filePath: string; content: string }>, meetingTranscriptsDir?: string | null): Promise<Array<R & { derivation: Derivation }>> {
  const byPath = new Map(transcripts.map(t => [t.filePath, t]));
  const out: Array<R & { derivation: Derivation }> = [];
  for (const ref of refs) {
    const transcript = ref.raw_source ? byPath.get(ref.raw_source) ?? { filePath: ref.raw_source } : undefined;
    out.push({ ...ref, derivation: await transcriptDerivation(engine, transcript, meetingTranscriptsDir) });
  }
  return out;
}

/** The dream summary page's derivation: the output pages it indexes. */
export async function summaryDerivation(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<Derivation & { declaration: DerivationDeclaration }> {
  const { trust, inputs } = await deriveTrust(engine, slugs.map(slug => ({ table: 'pages' as const, sourceId, slug })), { channel: 'derive:synthesize' });
  return { trust, inputs, declaration: declareDerivation(trust, inputs) };
}

/** An unmanaged derived page write (the dream summary): putPage at the derivation's tier, lowered, with its input edges. */
export async function putDerivedPage(engine: BrainEngine, derivation: Derivation, slug: string,
  page: Parameters<BrainEngine['putPage']>[1], opts: { sourceId: string }): Promise<void> {
  await derivedMaintenanceTransaction(engine, derivation, async tx => {
    const written = await tx.putPage(slug, page, opts);
    return { result: undefined, rows: [{ table: 'pages' as const, id: Number(written.id), sourceId: opts.sourceId }] };
  });
}

/** One patterns pass's derivation: every reflection submitted in its prompt. */
export function patternsDerivation(submitted: Array<{ taint?: TaintInput }>): Derivation & { declaration: DerivationDeclaration } {
  const inputs = submitted.flatMap(r => (r.taint ? [r.taint] : []));
  const trust = derivedWriteTrust({ channel: 'derive:patterns', inputs, lowerTo: inputs.length < submitted.length ? ['unknown'] : [] });
  return { trust, inputs, declaration: declareDerivation(trust, inputs) };
}
