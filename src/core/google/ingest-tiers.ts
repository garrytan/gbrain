/**
 * google/ingest-tiers: how much of a Gmail thread becomes memory.
 *
 * A source with ingest tiers on sorts every thread into one of four tiers
 * before it is written:
 *  - full: the owner wrote in it, a message is starred or marked important,
 *    or someone else in it already has a person page. Rendered as today.
 *  - record: everything else that is not bulk. The page is kept and
 *    searchable, but no model reads it: 'facts_backstop: false' and
 *    'extract_atoms: false' in its frontmatter, and no open-loop extraction.
 *  - none: the owner never wrote and every other message is bulk (a bulk
 *    category, mail gbrain.io calls automated, a noise sender, or a message
 *    to more than five people from a sender with no person page). No page.
 *  - private: a participant is on the source's private-senders list. The
 *    page is 'visibility: private' (owner-only), is embedded like other
 *    private pages and is never read by a model, as for record.
 *
 * The private-senders file holds one address or '@domain' per line; '#'
 * starts a comment. A configured file that is missing, unreadable or empty
 * stops the sync before any write, so a lost list never lets private mail
 * land as an ordinary page.
 */

import { createHash } from 'node:crypto';

import type { BrainEngine } from '../engine.ts';
import { CredentialError } from '../creds/errors.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { hasBulkCategory } from './gmail-categories.ts';
import { isNoiseSender, withPrivateVisibility } from './google-render.ts';
import type { GmailMessageMeta, GmailThreadData } from './types.ts';

export type IngestTier = 'full' | 'record' | 'none' | 'private';

export interface PrivateSenders {
  addresses: Set<string>;
  domains: Set<string>;
  /** Short hashes of every entry, so state can tell when the list grew without storing it. */
  hashes: string[];
}

const WIDE_RECIPIENTS = 5;

export function entryHash(entry: string): string {
  return createHash('sha256').update(entry).digest('hex').slice(0, 16);
}

/** Parses the private-senders file's text; an empty list throws private_senders_unreadable rather than run without it. */
export function parsePrivateSenders(text: string): PrivateSenders {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim().toLowerCase();
    if (!line) continue;
    if (line.startsWith('@') && line.length > 1 && !line.slice(1).includes('@')) domains.add(line.slice(1));
    else if (/^[^@\s]+@[^@\s]+$/.test(line)) addresses.add(line);
  }
  if (addresses.size === 0 && domains.size === 0) throw new CredentialError('private_senders_unreadable', ' (no entries)');
  const hashes = [...[...addresses].map((a) => entryHash(a)), ...[...domains].map((d) => entryHash('@' + d))].sort();
  return { addresses, domains, hashes };
}

export function isPrivateAddress(address: string, list: PrivateSenders): boolean {
  const a = address.toLowerCase();
  if (list.addresses.has(a)) return true;
  const at = a.lastIndexOf('@');
  return at > 0 && list.domains.has(a.slice(at + 1));
}

function participantsOf(thread: GmailThreadData): Set<string> {
  const out = new Set<string>();
  for (const m of thread.messages) {
    if (m.fromAddress) out.add(m.fromAddress.toLowerCase());
    for (const a of [...m.to, ...m.cc]) out.add(a.toLowerCase());
  }
  return out;
}

/** Any participant (author or recipient) on the private-senders list. */
export function isPrivateThread(thread: GmailThreadData, list: PrivateSenders): boolean {
  for (const a of participantsOf(thread)) if (isPrivateAddress(a, list)) return true;
  return false;
}

/** The addresses among these that a live person page in any source declares as an alias. */
async function addressesWithPersonPage(engine: BrainEngine, addresses: string[]): Promise<Set<string>> {
  const byNorm = new Map<string, string>();
  for (const a of addresses) {
    const norm = normalizeAlias(a);
    if (norm && norm.includes('@')) byNorm.set(norm, a);
  }
  if (byNorm.size === 0) return new Set();
  try {
    const rows = await engine.executeRaw<{ alias_norm: string }>(
      'SELECT DISTINCT pa.alias_norm FROM page_aliases pa ' +
        'JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id AND p.deleted_at IS NULL ' +
        "WHERE pa.alias_norm = ANY($1::text[]) AND p.type = 'person'",
      [[...byNorm.keys()]],
    );
    return new Set(rows.map((r) => byNorm.get(r.alias_norm) ?? r.alias_norm));
  } catch (err) {
    rethrowCapabilityRefusal(err);
    if (isMissingSchemaObject(err, 'table', 'page_aliases')) return new Set();
    throw err;
  }
}

function ownerWrote(m: GmailMessageMeta, mine: Set<string>): boolean {
  return m.labelIds.includes('SENT') || mine.has(m.fromAddress.toLowerCase());
}

/**
 * The tier for one thread. 'private' is decided first by the list, even for
 * bulk mail, so re-tiering always rewrites an earlier page as private.
 */
export async function classifyThreadTier(
  engine: BrainEngine,
  thread: GmailThreadData,
  mine: Set<string>,
  privateSenders: PrivateSenders | null,
): Promise<IngestTier> {
  if (privateSenders && isPrivateThread(thread, privateSenders)) return 'private';
  const others = [...participantsOf(thread)].filter((a) => a && !mine.has(a));
  const known = await addressesWithPersonPage(engine, others);
  const wrote = thread.messages.some((m) => ownerWrote(m, mine));
  const flagged = thread.messages.some((m) => m.labelIds.includes('STARRED') || m.labelIds.includes('IMPORTANT'));
  const isBulk = (m: GmailMessageMeta): boolean =>
    hasBulkCategory(m.labelIds)
    || m.precedence === 'bulk'
    || isNoiseSender(m.fromAddress)
    || (m.to.length + m.cc.length > WIDE_RECIPIENTS && !known.has(m.fromAddress.toLowerCase()));
  const otherMessages = thread.messages.filter((m) => !ownerWrote(m, mine));
  const bulkOnly = !wrote && !flagged && otherMessages.length > 0 && otherMessages.every(isBulk);
  if (bulkOnly && known.size === 0) return 'none';
  if (wrote || flagged || known.size > 0) return 'full';
  return 'record';
}

/** Adds the tier's frontmatter lines; record and private pages opt out of every model read. */
export function applyTierFrontmatter(markdown: string, tier: Exclude<IngestTier, 'none'>): string {
  const match = /^---\n([\s\S]*?)\n---(\n|$)/.exec(markdown);
  if (!match) return markdown;
  const drop = /^(ingest_tier|facts_backstop|extract_atoms|conversation_parseable)\s*:/;
  const lines = match[1]!.split('\n').filter((line) => !drop.test(line));
  lines.push('ingest_tier: ' + tier);
  if (tier !== 'full') lines.push('facts_backstop: false', 'extract_atoms: false', 'conversation_parseable: false');
  const out = '---\n' + lines.join('\n') + '\n---' + markdown.slice(match[0].length - match[2]!.length);
  return tier === 'private' ? withPrivateVisibility(out) : out;
}
