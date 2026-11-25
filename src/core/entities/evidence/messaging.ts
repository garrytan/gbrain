/**
 * Dedupe v2 (GST-3609): messaging evidence, read locally from the conversation pages already in the brain and sent
 * nowhere. Zero conversation pages is normal and changes nothing.
 *
 * Pages, read through the conversation parser's body reader, which reads a page stored in segments whole up to 24 MiB;
 * a larger one, which that reader gives only as its newest window, is set aside and listed (a window can hide speakers,
 * which would make a group chat read as one-to-one; such a page's segments are not read), as is a page stored in segments
 * that fails to read: `type: imessage` day pages (core/imessage/render.ts: `**Speaker** (time):` anchors; a one-to-one chat shows
 * its handle only where the Mac had no name, so the same chat key can show the handle on older days and the name on
 * newer ones) and chat pages under a `conversations/` folder, parsed by core/conversation-parser without any model
 * (iMessage, WhatsApp and the other export layouts it knows). An export page counts as one-to-one only when it has
 * exactly two speakers and one is its `speaker_owner` label. Agent session transcripts (`transcript_import`) and the
 * archive's day indexes are not chats and are skipped. gbrain has no Signal reader, so Signal adds nothing.
 *
 * A label that reads as an email address or a phone number is a handle (people.ts handleOf); any other label except
 * "Me" and "Unknown" is a name. A one-to-one chat binds every handle and name it shows to one person; a group chat of at
 * most MAX_SMALL_GROUP people binds a handle and a name that never appear on the same day. For a pair of person pages,
 * using a handle one page holds and the other doesn't:
 *   M1  a one-to-one chat binds the handle, which exactly one person page holds, to a name that agrees with the other
 *       page's name; exclusive, like C1.
 *   M3  the same, through a handle other person pages hold too, or through two or more small group chats; strong.
 *   M2  a chat binds a handle of either page to a name that agrees with that page's own name; supporting only.
 *   Mx  a handle the pair rests on is bound to two names that disagree (a shared or reused phone); a contradiction.
 */
import type { BrainEngine } from '../../engine.ts';
import type { Page } from '../../types.ts';
import { parseConversation } from '../../conversation-parser/parse.ts';
import { ConversationBodyTooLargeError, readConversationInput } from '../../conversation-parser/body.ts';
import { isSegmentedPage } from '../../page-body/page-shape.ts';
import { namesAgree } from '../name-variants.ts';
import { handleOf, type PersonPage } from './people.ts';

export const MAX_SMALL_GROUP = 8;
export const GROUP_CHATS_FOR_M3 = 2;
const PAGE = 200;
const ANCHOR = /^\*\*([^*\n]+)\*\* \(\d{4}-\d{2}-\d{2} /gm;
const NOT_A_PERSON = new Set(['me', 'unknown']);

export type MessagingSignal = 'M1' | 'M2' | 'M3' | 'Mx';

interface Day { handles: Set<string>; names: Set<string> }
interface Chat { oneToOne: boolean; size: number; days: Day[] }

export interface MessagingIndex {
  pages: number;
  chats: number;
  one_to_one: number;
  /** Pages left unread because their transcript file is over the parser's size limit. */
  too_large: number;
  /** Pages stored in segments: read whole, or set aside (listed) because only a window of them could be read. */
  segmented: { read: number; set_aside: Array<{ source_id: string; slug: string }> };
  /** Handle → names a one-to-one chat binds it to. */
  direct: Map<string, Set<string>>;
  /** Handle → name → how many small group chats bind them. */
  grouped: Map<string, Map<string, number>>;
}

function speakersOf(page: Page, body: string): { labels: string[]; oneToOne: boolean } | null {
  const fm = page.frontmatter ?? {};
  if (fm.type === 'imessage' || page.type === 'imessage') {
    const labels = [...body.matchAll(ANCHOR)].map(m => m[1]!.trim());
    const oneToOne = fm.group === false;
    const title = typeof fm.title === 'string' ? fm.title.replace(/\s+\d{4}-\d{2}-\d{2}$/, '').trim() : '';
    return { labels: oneToOne && title ? [...labels, title] : labels, oneToOne };
  }
  const parsed = parseConversation(body, { page, noPolish: true, noFallback: true });
  if (!parsed.messages.length) return null;
  const speakers = [...new Set(parsed.messages.map(m => m.speaker.trim()).filter(Boolean))];
  const owner = (fm.speaker_owner as { label?: unknown } | undefined)?.label;
  const ownerLabel = typeof owner === 'string' ? owner.trim() : null;
  const oneToOne = speakers.length === 2 && !!ownerLabel && speakers.includes(ownerLabel);
  return { labels: speakers.filter(s => s !== ownerLabel), oneToOne };
}

async function* conversationPages(engine: BrainEngine): AsyncGenerator<Page & { source_id?: string }> {
  for (const source of await engine.listAllSources()) {
    for (const filter of [{ type: 'imessage' }, { slugPrefix: 'conversations/' }] as const) {
      for (let offset = 0; ; offset += PAGE) {
        const rows = await engine.listPages({ ...filter, sourceId: source.id, sort: 'slug', limit: PAGE, offset } as never);
        for (const row of rows) yield Object.assign(row, { source_id: source.id });
        if (rows.length < PAGE) break;
      }
    }
  }
}

export async function readMessagingIndex(engine: BrainEngine, countryCode: string): Promise<MessagingIndex> {
  const index: MessagingIndex = { pages: 0, chats: 0, one_to_one: 0, too_large: 0, segmented: { read: 0, set_aside: [] }, direct: new Map(), grouped: new Map() };
  const chats = new Map<string, Chat>();
  const seen = new Set<string>();
  for await (const page of conversationPages(engine)) {
    const id = `${page.source_id}\t${page.slug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (page.frontmatter?.transcript_import || page.slug.startsWith('conversations/days/')) continue;
    let body: string;
    try {
      const input = await readConversationInput(engine, page, { priorFacts: async () => 1 });
      if (input.window) { index.segmented.set_aside.push({ source_id: page.source_id!, slug: page.slug }); continue; }
      body = input.body;
      if (isSegmentedPage(page) && !input.sidecar) index.segmented.read++;
    } catch (e) {
      if (e instanceof ConversationBodyTooLargeError) { index.too_large++; continue; }
      if (!isSegmentedPage(page)) throw e;
      index.segmented.set_aside.push({ source_id: page.source_id!, slug: page.slug });
      continue;
    }
    const parsed = speakersOf(page, body);
    index.pages++;
    if (!parsed) continue;
    const day: Day = { handles: new Set(), names: new Set() };
    for (const label of parsed.labels) {
      if (NOT_A_PERSON.has(label.toLowerCase())) continue;
      const h = handleOf(label, countryCode);
      if (h) day.handles.add(h); else day.names.add(label);
    }
    const chatKey = typeof page.frontmatter?.imessage_chat === 'string' ? `${page.source_id}\timessage:${page.frontmatter.imessage_chat}` : id;
    const chat = chats.get(chatKey) ?? { oneToOne: parsed.oneToOne, size: 0, days: [] };
    chat.oneToOne &&= parsed.oneToOne;
    chat.size = Math.max(chat.size, day.handles.size + day.names.size);
    chat.days.push(day);
    chats.set(chatKey, chat);
  }
  index.chats = chats.size;
  for (const chat of chats.values()) {
    const handles = new Set(chat.days.flatMap(d => [...d.handles]));
    const names = new Set(chat.days.flatMap(d => [...d.names]));
    if (chat.oneToOne) {
      index.one_to_one++;
      for (const h of handles) for (const n of names) index.direct.set(h, (index.direct.get(h) ?? new Set()).add(n));
      continue;
    }
    if (chat.size > MAX_SMALL_GROUP) continue;
    for (const h of handles) for (const n of names) {
      if (chat.days.some(d => d.handles.has(h) && d.names.has(n))) continue;
      const byName = index.grouped.get(h) ?? new Map<string, number>();
      byName.set(n, (byName.get(n) ?? 0) + 1);
      index.grouped.set(h, byName);
    }
  }
  return index;
}

/** Names a handle is bound to: through one-to-one chats, and through enough small group chats. */
function boundNames(index: MessagingIndex, h: string): { direct: string[]; grouped: string[] } {
  return { direct: [...index.direct.get(h) ?? []], grouped: [...index.grouped.get(h) ?? []].filter(([, n]) => n >= GROUP_CHATS_FOR_M3).map(([name]) => name) };
}

const disagreeing = (names: string[]) => names.some((x, i) => names.slice(i + 1).some(y => namesAgree(x, y) === false));

export function messagingSignals(index: MessagingIndex, carriers: Map<string, string[]>, a: PersonPage, b: PersonPage): MessagingSignal[] {
  if (!index.direct.size && !index.grouped.size) return [];
  const out = new Set<MessagingSignal>();
  const tie = (holder: PersonPage, other: PersonPage) => {
    for (const h of holder.handles) {
      const { direct, grouped } = boundNames(index, h);
      if (!direct.length && !grouped.length) continue;
      if ([...direct, ...grouped].some(n => namesAgree(n, holder.title) === true)) out.add('M2');
      if (other.handles.has(h)) { if (disagreeing([...direct, ...grouped])) out.add('Mx'); continue; }
      const directTie = direct.some(n => namesAgree(n, other.title) === true);
      const groupTie = grouped.some(n => namesAgree(n, other.title) === true);
      if (!directTie && !groupTie) continue;
      if (disagreeing([...direct, ...grouped])) { out.add('Mx'); continue; }
      out.add(directTie && (carriers.get(h)?.length ?? 0) === 1 ? 'M1' : 'M3');
    }
  };
  tie(a, b);
  tie(b, a);
  return [...out].sort();
}
