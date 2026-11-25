/**
 * #7161: names that only appear in page text. Entity resolution reads pages,
 * aliases and the mention index; while mention extraction is behind, a name
 * that only sits in notes, calendar pages or transcripts resolves to nothing,
 * and a thin stub page hides the fresh mention in a recent note. This probe
 * is one bounded keyword read of the exact name as a phrase, under the same
 * read policy as search (source grant, private pages, safe chunks for
 * untrusted callers, quarantined pages left out), verified against the chunk
 * text, so every listed page really contains the name. The result is
 * labelled as unlinked text matches: it says the name appears there, not
 * that those pages are waiting for extraction.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { isQuarantined } from '../quarantine.ts';
import { nameWords } from '../entities/name-variants.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';

/** Keyword rows read for one name; a full read reports the total as a floor (`capped`). */
export const TEXT_MENTION_POOL = 50;
/** Pages listed, newest first. */
export const TEXT_MENTION_SHOWN = 5;
/** The probe's wall-clock budget; past it the card reports `unread: 'deadline'` instead of waiting. */
export const TEXT_MENTION_DEADLINE_MS = 1500;
const MAX_NAME_WORDS = 5;

export interface TextMentionPage { slug: string; title: string; type: string | null; source_id: string; date: string | null }

export interface TextMentions {
  /** Pages whose text contains the name, newest first. */
  pages: TextMentionPage[];
  /** Distinct pages found; a floor when `capped`. */
  total: number;
  capped: boolean;
  /** The probe could not finish (TEXT_MENTION_DEADLINE_MS) or failed: the name was not checked, which is not "no matches". */
  unread?: 'deadline' | 'read_failed';
}

/** Whether `name` is worth a text probe: one to five words with a letter, not a slug. */
export function textProbeApplies(name: string): boolean {
  const words = nameWords(name);
  return !name.includes('/') && words.length >= 1 && words.length <= MAX_NAME_WORDS && words.some(w => /\p{L}/u.test(w) && w.length >= 2);
}

const containsName = (text: string, words: string[]) => {
  const hay = ` ${nameWords(text).join(' ')} `;
  return hay.includes(` ${words.join(' ')} `);
};

/**
 * Pages in `sources` whose text contains `name` as a phrase (null when
 * the probe does not apply or the read failed). `exclude` drops pages the
 * caller already shows (the card's own page).
 */
export async function readTextMentions(
  engine: BrainEngine,
  sources: readonly string[],
  name: string,
  opts: { remote: boolean; excludePrivate: boolean; omitQuarantined?: boolean; exclude?: readonly string[] },
): Promise<TextMentions | null> {
  if (!textProbeApplies(name) || !sources.length) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<TextMentions>(resolve => {
    timer = setTimeout(() => resolve({ pages: [], total: 0, capped: false, unread: 'deadline' }), TEXT_MENTION_DEADLINE_MS);
  });
  try {
    return await Promise.race([probe(engine, sources, name, opts), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(
  engine: BrainEngine,
  sources: readonly string[],
  name: string,
  opts: { remote: boolean; excludePrivate: boolean; omitQuarantined?: boolean; exclude?: readonly string[] },
): Promise<TextMentions> {
  const words = nameWords(name);
  let rows: SearchResult[];
  try {
    rows = await engine.searchKeyword(`"${name.replace(/"/g, ' ').trim()}"`, {
      limit: TEXT_MENTION_POOL,
      ...(sources.length === 1 ? { sourceId: sources[0] } : { sourceIds: [...sources] }),
      excludePrivate: opts.excludePrivate,
      requireSafeChunks: opts.remote,
    });
  } catch (e) {
    // A capability refusal is not a failed read: the engine cannot serve the probe at all.
    rethrowCapabilityRefusal(e);
    return { pages: [], total: 0, capped: false, unread: 'read_failed' };
  }
  const exclude = new Set(opts.exclude ?? []);
  const capped = rows.length >= TEXT_MENTION_POOL;
  const hits = new Map<string, SearchResult>();
  for (const r of rows) {
    const key = `${r.source_id ?? ''}:${r.slug}`;
    if (r.keyword_relaxed || exclude.has(r.slug) || hits.has(key) || !containsName(r.chunk_text ?? '', words)) continue;
    hits.set(key, r);
  }
  if (!hits.size) return { pages: [], total: 0, capped: false };
  const meta = await engine.readTextMentionPages(sources, [...new Set([...hits.values()].map(h => h.slug))]).catch((err: unknown) => {
    // A capability refusal is not "no pages": the engine cannot serve the read at all.
    rethrowCapabilityRefusal(err);
    return [];
  });
  const pages = meta
    .filter(m => hits.has(`${m.source_id}:${m.slug}`) && !(opts.omitQuarantined && isQuarantined(m.frontmatter)))
    .map(m => ({ slug: m.slug, title: m.title ?? m.slug, type: m.type, source_id: m.source_id,
      date: m.date == null ? null : new Date(m.date as string).toISOString().slice(0, 10) }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.slug.localeCompare(b.slug));
  return { pages: pages.slice(0, TEXT_MENTION_SHOWN), total: pages.length, capped };
}
