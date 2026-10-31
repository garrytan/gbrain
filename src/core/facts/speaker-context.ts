/**
 * #8064: the context cell of a fact saved from an agent-launched session
 * carries a speaker note after its provenance, so recall shows whose claim
 * it is. Shared by the unmanaged backstop writers and the managed facts batch.
 */
import { speakerContextNote } from '../context/session-speaker.ts';
import { appendContextNote } from './subject-infer.ts';

export function withSpeakerNote(speaker: { principal: string } | undefined, context: string | null): string | null {
  return speaker ? appendContextNote(context, speakerContextNote(speaker.principal)) : context;
}
