/**
 * GST-3216 PR 3: a conversation fact lands on the brain's owner only when the page proves who the owner is.
 *
 * The extractor names subjects from speaker labels and text, and a label is not identity: a meeting recorder puts its
 * owner's name on every line it captured, and an agent's brief sits in the user's seat. So a fact whose subject is the
 * owner entity (`ownerIdentity`, for the member the page's source belongs to) keeps it only when the page carries a
 * trusted `speaker_owner` marker (speaker-owner.ts) and:
 *   - the owner asserted it (`attributed_to` user, or no attribution): a turn by the marker's label is in the window,
 *     as the page's own parser read it;
 *   - someone else asserted it about the owner (`assistant`, `other`): the marker alone, since it proves which speaker
 *     the owner is.
 * Otherwise the fact keeps no subject and is stored on the page with the note `speaker unknown`, so it stays visible.
 * A subject that mention inference found (a name in the text) never makes the owner. Nothing reads less: the guard
 * only withholds a subject, never the fact.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { ownerIdentity } from '../identity/owner.ts';
import { readSpeakerOwners, sourceSpeakerOwnerStamp } from '../identity/speaker-owner.ts';
import type { ConversationSegment } from './conversation-types.ts';
import type { FactAttribution } from '../engine.ts';
import { appendContextNote } from './subject-infer.ts';

export const SPEAKER_UNKNOWN_NOTE = 'speaker unknown';

/**
 * The owner entity a page's facts may land on, the other pages that also count as the owner (each person page carrying
 * an owner identifier, such as a directory entry; never edited), and the owner's speaker label when the page proves it.
 */
export interface ConversationOwner { entity: string; also: string[]; label: string | null }

/** The owner for a source's pages: the identity of the member the source belongs to, else of the brain's owner. */
export async function sourceOwner(engine: BrainEngine, sourceId: string): Promise<Omit<ConversationOwner, 'label'>> {
  const stamp = await sourceSpeakerOwnerStamp(engine, sourceId);
  const identity = await ownerIdentity(engine, stamp?.member ? { member: stamp.member } : {});
  return { entity: identity.entity.slug, also: identity.pages.map(p => p.slug).filter(slug => slug !== identity.entity.slug) };
}

/** Whether a subject is the owner: the owner entity or another page that counts as the owner. */
export const isOwnerSubject = (owner: Omit<ConversationOwner, 'label'>, slug: string | null | undefined): boolean =>
  !!slug && (slug === owner.entity || owner.also.includes(slug));

export async function conversationOwner(engine: BrainEngine, sourceId: string, page: Pick<Page, 'slug'>): Promise<ConversationOwner> {
  const [read] = await readSpeakerOwners(engine, [{ source_id: sourceId, slug: page.slug }]);
  return { ...await sourceOwner(engine, sourceId), label: read?.status === 'trusted' ? read.marker!.label : null };
}

/** One fact row after the guard; `inferred` marks a subject mention inference supplied. A kept owner fact goes to the owner entity. */
export function guardOwnerFact<T extends { entity_slug?: string | null; attributed_to?: FactAttribution | null; context?: string | null }>(
  row: T, owner: ConversationOwner, seg: Pick<ConversationSegment, 'messages'>, inferred: boolean): T {
  if (!isOwnerSubject(owner, row.entity_slug)) return row;
  const spoke = owner.label !== null && seg.messages.some(m => m.speaker === owner.label);
  const thirdParty = row.attributed_to === 'assistant' || row.attributed_to === 'other';
  if (!inferred && owner.label !== null && (thirdParty || spoke)) return { ...row, entity_slug: owner.entity };
  return { ...row, entity_slug: null, context: appendContextNote(row.context, SPEAKER_UNKNOWN_NOTE) };
}
