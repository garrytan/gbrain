/**
 * Zero-LLM fact subject inference (#5836).
 *
 * A fact saved without an entity is invisible to everything that groups facts
 * by entity: the `## Facts` fence, entity-scoped recall and the System One
 * conflict sweep. This module names the entity a fact is about using identity
 * evidence only, so the write paths (remember, the facts backstop) and the
 * `gbrain facts relink` repair share one rule:
 *
 *   - page: the fact came from a live fact-entity page (the page being written,
 *     or a recorded page provenance for relink), and the text names no other
 *     entity.
 *   - mention: the text names exactly one live fact-entity page by exact slug,
 *     unique slug basename or unique alias (relink also accepts the same-name
 *     trigram arm), and no other real name competes with it.
 *
 * A competing name vetoes the link even when it has no page ("Northstar
 * Example copied Acme Example's pricing" names two companies; only one has a
 * page, so the subject is unknown, not Acme). Bare first names are never
 * guessed. Every lookup is source-scoped; `excludePrivate` keeps a remote
 * caller from inferring (or detecting) pages it cannot read.
 */

import type { BrainEngine } from '../engine.ts';
import { extractCandidates, isCommonCapitalizedWord } from '../context/entity-salience.ts';
import { isFactEntityPage, resolveStrictEntityReference, type StrictResolution } from '../entities/resolve.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

export type InferredVia = 'page' | 'mention';
export type InferMissReason = 'ambiguous' | 'unverified_match' | 'no_mention' | 'no_page';
/** A miss carries the distinct entities the text did resolve to, so a later tier can stay within them. */
export type InferResult = { slug: string; via: InferredVia } | { slug: null; reason: InferMissReason; resolved: string[] };

export interface InferSubjectInput {
  fact: string;
  /** A trusted page the fact came from: the page being written, or relink's recorded page provenance. */
  pageSlug?: string | null;
  /** `write` (remember, backstop) accepts identity arms only; `relink` also accepts the same-name trigram arm. */
  mode: 'write' | 'relink';
  /** Remote callers: private pages never resolve and never count toward uniqueness. */
  excludePrivate?: boolean;
}

/** The note separator every fact context annotation uses ("<page slug> — <note>"). */
export const CONTEXT_NOTE_SEPARATOR = ' — ';

/** Append a provenance note to a fact context cell, keeping any page slug prefix parseable. */
export function appendContextNote(context: string | null | undefined, note: string): string {
  return context ? `${context}${CONTEXT_NOTE_SEPARATOR}${note}` : note;
}

/** The context cell with every appended note removed (the original page slug or free text). */
export function contextHead(context: string | null | undefined): string | null {
  if (!context) return null;
  const head = context.split(CONTEXT_NOTE_SEPARATOR, 1)[0]!.trim();
  return head || null;
}

/** facts.source values written by page-extraction paths, whose context head is the source page slug. */
const PAGE_EXTRACTION_SOURCES = new Set(['mcp:put_page', 'sync:import', 'file_upload', 'code_import']);

/**
 * The page a stored fact was extracted from, when its row records one: a
 * page-extraction source and a context head that is a path-shaped slug.
 * Liveness and entity type are checked by inferFactSubject. Free-text
 * provenance (remember's "chat 2026-06-12") is never page provenance.
 */
export function recordedPageSlug(context: string | null | undefined, source: string | null | undefined): string | null {
  if (!source || !PAGE_EXTRACTION_SOURCES.has(source)) return null;
  const head = contextHead(context);
  return head && head.includes('/') && !/\s/.test(head) ? head : null;
}

/** `facts.entity_inference` off values disable write-time inference (relink is unaffected). */
export async function isEntityInferenceEnabled(engine: BrainEngine): Promise<boolean> {
  const raw = await engine.getConfig('facts.entity_inference');
  return !/^(off|false|0|no|disabled)$/i.test((raw ?? '').trim());
}

/**
 * Capitalized role and business terms that are not names, so they never veto
 * ("Acme Example hired a CFO"). Real acronym names (a company called IBM) are
 * not here and still compete.
 */
const ROLE_AND_TERM_TOKENS = new Set([
  'ceo', 'cfo', 'cto', 'coo', 'cmo', 'cpo', 'cro', 'vp', 'svp', 'evp', 'gm', 'pm', 'hr', 'qa', 'ops',
  'api', 'sdk', 'ai', 'ml', 'mvp', 'kpi', 'okr', 'okrs', 'arr', 'mrr', 'ipo', 'loi', 'nda', 'saas', 'b2b', 'b2c',
  'pr', 'ui', 'ux', 'q1', 'q2', 'q3', 'q4', 'h1', 'h2', 'fy', 'eod', 'eow', 'asap', 'faq', 'tbd', 'n/a',
]);

/**
 * Words that commonly open a note or memory line without naming anyone. Only
 * these may be ignored at the start of a sentence; any other unresolved
 * capitalized opener ("Blake joined Acme Example") is treated as a name that
 * competes with the match.
 */
const SENTENCE_OPENERS = new Set([
  'met', 'meeting', 'talked', 'spoke', 'called', 'emailed', 'texted', 'messaged', 'asked', 'told', 'said', 'says', 'heard',
  'raised', 'closed', 'signed', 'hired', 'fired', 'lost', 'won', 'launched', 'shipped', 'released', 'announced', 'opened',
  'moved', 'booked', 'bought', 'sold', 'sent', 'paid', 'got', 'had', 'has', 'have', 'went', 'came', 'saw', 'ate', 'ran', 'slept',
  'started', 'finished', 'stopped', 'decided', 'agreed', 'declined', 'approved', 'rejected', 'scheduled', 'cancelled', 'canceled',
  'need', 'needs', 'want', 'wants', 'prefer', 'prefers', 'likes', 'loves', 'hates', 'dislikes', 'thinks', 'believes', 'plans',
  'remember', 'remind', 'reminder', 'note', 'todo', 'follow', 'followup', 'introduced', 'intro', 'invested', 'joined', 'left',
  'currently', 'recently', 'previously', 'usually', 'always', 'never', 'often', 'sometimes', 'probably', 'apparently',
  'not', 'no', 'yes', 'after', 'before', 'during', 'since', 'until', 'while', 'per', 'via', 're', 'fyi', 'update', 'updated',
  'lunch', 'dinner', 'breakfast', 'coffee', 'drinks', 'call', 'sync', 'standup', 'interview', 'demo', 'pitch', 'board',
  'favorite', 'favourite', 'birthday', 'anniversary', 'allergic', 'vegetarian', 'vegan', 'lives', 'lived', 'works', 'worked',
]);

/** Slugs written verbatim in the fact text ("people/alice-example owns the checklist"). */
const SLUG_IN_TEXT_RE = /(?<![\w/-])[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+(?![\w/-])/g;

/** Two distinct entities already make the subject unknown; more resolution is wasted work. */
const DISTINCT_ENTITY_LIMIT = 2;

export async function inferFactSubject(engine: BrainEngine, sourceId: string, input: InferSubjectInput): Promise<InferResult> {
  const candidates: Array<{ query: string; sentenceStart?: true }> = [
    ...[...new Set(input.fact.match(SLUG_IN_TEXT_RE) ?? [])].map(query => ({ query })),
    ...extractCandidates(input.fact).filter(c => !c.weak).map(shedOpener),
  ];
  const resolved = new Set<string>();
  const misses: Array<Exclude<StrictResolution, { slug: string }>['miss']> = [];
  let vetoed = false;
  const memo = new Map<string, StrictResolution>();
  for (const candidate of candidates) {
    const key = candidate.query.toLowerCase();
    let r = memo.get(key);
    if (!r) {
      r = await resolveStrictEntityReference(engine, sourceId, candidate.query,
        { sameName: input.mode === 'relink', excludePrivate: input.excludePrivate });
      memo.set(key, r);
    }
    if (r.slug !== null) {
      resolved.add(r.slug);
      if (resolved.size >= DISTINCT_ENTITY_LIMIT) return { slug: null, reason: 'ambiguous', resolved: [...resolved] };
      continue;
    }
    misses.push(r.miss);
    // A name that is not an entity page (a meeting title) does not compete. A
    // capitalized sentence opener with no page ("Met", "Raised") is no name
    // evidence; anything else unresolved is a real competing reference.
    if (r.miss === 'not_entity') continue;
    if (r.miss === 'no_page' && (isNonName(candidate.query) || (candidate.sentenceStart && SENTENCE_OPENERS.has(candidate.query.toLowerCase())))) continue;
    vetoed = true;
  }

  const page = input.pageSlug ? await liveFactEntityPage(engine, sourceId, input.pageSlug, input.excludePrivate) : null;
  if (page) {
    if (vetoed || (resolved.size === 1 && !resolved.has(page))) return { slug: null, reason: 'ambiguous', resolved: [...resolved] };
    return { slug: page, via: 'page' };
  }
  if (resolved.size === 1 && !vetoed) return { slug: [...resolved][0]!, via: 'mention' };
  const miss = (reason: InferMissReason): InferResult => ({ slug: null, reason, resolved: [...resolved] });
  if (resolved.size > 0 || misses.includes('ambiguous')) return miss('ambiguous');
  if (misses.includes('unverified')) return miss('unverified_match');
  if (misses.some(m => m === 'no_page')) return miss(vetoed ? 'no_page' : 'no_mention');
  return miss('no_mention');
}

/** "Joined Acme Example" glues the opener into the name run; resolve the name without it. */
function shedOpener<T extends { query: string }>(c: T): T {
  const [first, ...rest] = c.query.split(/\s+/);
  return rest.length && SENTENCE_OPENERS.has(first!.toLowerCase()) ? { ...c, query: rest.join(' ') } : c;
}

function isNonName(query: string): boolean {
  if (/\s/.test(query)) return false;
  return isCommonCapitalizedWord(query) || ROLE_AND_TERM_TOKENS.has(query.toLowerCase());
}

async function liveFactEntityPage(engine: BrainEngine, sourceId: string, slug: string, excludePrivate?: boolean): Promise<string | null> {
  const privacy = excludePrivate ? `AND ${privatePagesFilterFragment('p')}` : '';
  const [row] = await engine.executeRaw<{ slug: string; type: string | null }>(
    `SELECT p.slug, p.type FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL ${privacy} LIMIT 1`,
    [sourceId, slug],
  );
  return row && isFactEntityPage(row.slug, row.type) ? row.slug : null;
}
