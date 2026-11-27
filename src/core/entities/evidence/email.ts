/**
 * Dedupe v2 (GST-3609): email evidence, read locally from the email pages already in the brain and sent nowhere.
 *
 * Email pages are found by page type (`type: email`), wherever they live, never by source id: front matter `from`,
 * `to`, `cc` (`Name <address>` or a bare address) and `participants`, each address through identityEmailKey. For a
 * pair of person pages, using only the addresses one page holds and the other doesn't:
 *   E1  one thread has an address of each page as a participant, and each address's display name agrees with its
 *       page's name (namesAgree); strong.
 *   E3  the two addresses write to largely the same people: co-recipient Jaccard of at least 0.3, each address in at
 *       least 5 threads; supporting only.
 *   E4  an email page that links one person page lists the other page's address as its sender; strong.
 * A role mailbox (duplicates.ts ROLE_MAILBOXES) or an address more than CROWDED_LIMIT person pages hold turns email
 * evidence off for the pair. E2 (signature company) and E-x (signatures naming different employers) are not read yet.
 */
import type { BrainEngine } from '../../engine.ts';
import { CROWDED_LIMIT } from '../duplicates.ts';
import { namesAgree } from '../name-variants.ts';
import { identityEmailKey } from '../../ops/whois.ts';
import { isRoleHandle, pageKey, type PersonPage } from './people.ts';

export const E3_MIN_THREADS = 5;
export const E3_MIN_JACCARD = 0.3;
const PAGE = 2000;

export type EmailSignal = 'E1' | 'E3' | 'E4';

export interface EmailIndex {
  /** Email pages read. */
  pages: number;
  /** Address → indexes of the threads it takes part in. */
  threads: Map<string, Set<number>>;
  /** Address → display names seen beside it. */
  names: Map<string, Set<string>>;
  /** Address → every other participant of its threads. */
  coRecipients: Map<string, Set<string>>;
  /** Person page key → senders of the email pages that link it. */
  linkedSenders: Map<string, Set<string>>;
}

const values = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string');

/** `Name <address>`, `"Name" <address>` or a bare address; null when it holds no address. */
export function parseAddress(raw: string): { address: string; name: string | null } | null {
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  const address = identityEmailKey(angled ? angled[2]! : raw);
  if (!address) return null;
  const name = angled?.[1]?.trim() || null;
  return { address, name: name && !name.includes('@') ? name : null };
}

export async function readEmailIndex(engine: BrainEngine, people: Map<string, PersonPage>): Promise<EmailIndex> {
  const index: EmailIndex = { pages: 0, threads: new Map(), names: new Map(), coRecipients: new Map(), linkedSenders: new Map() };
  const add = <T>(m: Map<string, Set<T>>, k: string, v: T) => { const s = m.get(k) ?? new Set<T>(); s.add(v); m.set(k, s); };
  for (let after: { source_id: string; slug: string } | undefined; ;) {
    const rows = await engine.listEntityKeyRows({ types: ['email'], keys: ['from', 'to', 'cc', 'participants'], limit: PAGE, ...(after ? { after } : {}) });
    for (const row of rows) {
      const t = index.pages++;
      const senders = values(row.keys.from).map(parseAddress).filter((a): a is NonNullable<typeof a> => !!a);
      const listed = [...senders, ...['to', 'cc', 'participants'].flatMap(f => values(row.keys[f]).map(parseAddress))].filter((a): a is NonNullable<typeof a> => !!a);
      const all = new Set(listed.map(a => a.address));
      for (const a of listed) if (a.name) add(index.names, a.address, a.name);
      for (const address of all) {
        add(index.threads, address, t);
        for (const other of all) if (other !== address) add(index.coRecipients, address, other);
      }
      if (!senders.length) continue;
      for (const link of await engine.getLinks(row.slug, { sourceId: row.source_id })) {
        const target = pageKey({ source_id: link.to_source_id, slug: link.to_slug });
        if (people.has(target)) for (const s of senders) add(index.linkedSenders, target, s.address);
      }
    }
    if (rows.length < PAGE) return index;
    after = { source_id: rows.at(-1)!.source_id, slug: rows.at(-1)!.slug };
  }
}

const own = (p: PersonPage, other: PersonPage) => [...p.handles].filter(h => h.startsWith('e:') && !other.handles.has(h)).map(h => h.slice(2));
const named = (index: EmailIndex, address: string, title: string) => [...index.names.get(address) ?? []].some(n => namesAgree(n, title) === true);
function jaccard(x: Set<string>, y: Set<string>, drop: string[]): number {
  const a = [...x].filter(v => !drop.includes(v));
  const b = new Set([...y].filter(v => !drop.includes(v)));
  const both = a.filter(v => b.has(v)).length;
  const union = a.length + b.size - both;
  return union ? both / union : 0;
}

/** The email signals of a pair, or `disabled` with the reason when a role or crowded address turns email evidence off. */
export function emailSignals(index: EmailIndex, carriers: Map<string, string[]>, a: PersonPage, b: PersonPage): { signals: EmailSignal[]; disabled?: string } {
  const handles = [...a.handles, ...b.handles].filter(h => h.startsWith('e:'));
  if (handles.some(isRoleHandle)) return { signals: [], disabled: 'role address' };
  if (handles.some(h => (carriers.get(h)?.length ?? 0) > CROWDED_LIMIT)) return { signals: [], disabled: 'shared address' };
  if (!index.pages) return { signals: [] };
  const xs = own(a, b);
  const ys = own(b, a);
  const out = new Set<EmailSignal>();
  for (const x of xs) for (const y of ys) {
    const tx = index.threads.get(x);
    const ty = index.threads.get(y);
    if (!tx || !ty) continue;
    if ([...tx].some(t => ty.has(t)) && named(index, x, a.title) && named(index, y, b.title)) out.add('E1');
    if (tx.size >= E3_MIN_THREADS && ty.size >= E3_MIN_THREADS
      && jaccard(index.coRecipients.get(x) ?? new Set(), index.coRecipients.get(y) ?? new Set(), [x, y]) >= E3_MIN_JACCARD) out.add('E3');
  }
  const sent = (p: PersonPage, addresses: string[]) => addresses.some(s => index.linkedSenders.get(pageKey(p))?.has(s));
  if (sent(a, ys) || sent(b, xs)) out.add('E4');
  return { signals: [...out].sort() };
}
