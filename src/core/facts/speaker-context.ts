/**
 * #8064: the context cell of a fact saved from an agent-launched session
 * carries a speaker note after its provenance, so recall shows whose claim
 * it is. Shared by the unmanaged backstop writers and the managed facts batch.
 */
import { speakerContextNote } from '../context/session-speaker.ts';
import { basename } from 'node:path';
import { corpusFileSessionId } from '../context/corpus-segments.ts';
import { captureGateLaneForSource } from './capture-sources.ts';
import { appendContextNote } from './subject-infer.ts';

/** Readable capture provenance, shared by file fences and database-only facts.
 * Keep the full session identity in source_session; corpus sweep IDs wrap a
 * filename, not a harness ID, so unwrap before shortening it for display.
 */
export function factSourceContext(ctx: { source: string; sourceSlug?: string; sessionId: string | null }, pageSlug?: string): string | null {
  if (ctx.sourceSlug !== undefined) return ctx.sourceSlug;
  if (captureGateLaneForSource(ctx.source) && ctx.sessionId) {
    const session = ctx.sessionId.startsWith('sweep:corpus:')
      ? corpusFileSessionId(basename(ctx.sessionId.slice('sweep:corpus:'.length)))
      : ctx.sessionId;
    if (session) return `session ${session.slice(0, 8)}`;
  }
  return pageSlug ?? null;
}

export function withSpeakerNote(speaker: { principal: string } | undefined, context: string | null): string | null {
  return speaker ? appendContextNote(context, speakerContextNote(speaker.principal)) : context;
}
