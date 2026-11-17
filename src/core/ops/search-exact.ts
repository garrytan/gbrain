/**
 * #7191 ask 2: the `search_exact` op (CLI `gbrain search --exact "<phrase>"`).
 * The scan, its visibility predicate and its completeness contract live in
 * src/core/search/exact-scan.ts; this file validates params and resolves the
 * caller's scope the way `search` does.
 */
import type { Operation, OperationContext } from './contract.ts';
import { invalidParam } from './op-fix.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam } from './context.ts';
import { MIN_TRUST_PARAM, resolveReadEligibility } from '../eligibility/policy.ts';
import {
  EXACT_DEFAULT_LIMIT, EXACT_DEFAULT_SECONDS, EXACT_MAX_LIMIT, EXACT_MAX_PHRASE_CHARS, EXACT_MAX_SECONDS, phrasePattern, runExactScan,
} from '../search/exact-scan.ts';
import type { ExactMatch } from '../search/exact-scan.ts';
import type { BrainEngine } from '../engine.ts';
import { heldFenceLines } from '../eligibility/stamp.ts';
import { chunkVisibleFilter } from '../search/safe-chunks.ts';

const TYPE_NAME = /^[A-Za-z0-9_.:/-]+$/;

/**
 * GST-2891: a caller whose fact reads are world-only gets no snippet text from a fence row held from it (heldFenceLines,
 * read on the stored chunk the snippet was cut from, so a snippet that starts or stops inside a row is placed). A snippet
 * left without the phrase matched held text, so it goes, and a match left without snippets goes too: its presence alone
 * would confirm the phrase. A snippet whose chunk is no longer found goes (fail closed).
 */
async function withoutHeldSnippets<M extends ExactMatch>(engine: BrainEngine, matches: M[], holdsPhrase: (text: string) => boolean): Promise<M[]> {
  const keys = matches.flatMap(m => m.snippets.map(s => ({ m, s })));
  if (!keys.length) return matches;
  const found = await engine.executeRaw<{ i: number; chunk_text: string }>(
    `SELECT k.i, cc.chunk_text FROM unnest($1::int[], $2::int[], $3::text[]) WITH ORDINALITY AS k(page_id, chunk_index, snippet, i)
      JOIN pages p ON p.id = k.page_id JOIN content_chunks cc ON cc.page_id = k.page_id AND cc.chunk_index = k.chunk_index
      WHERE ${chunkVisibleFilter('p', 'cc')} AND strpos(cc.chunk_text, k.snippet) > 0`,
    [keys.map(k => k.m.page_id), keys.map(k => k.s.chunk_index), keys.map(k => k.s.text)]);
  const chunks = found.map(f => ({ key: keys[Number(f.i) - 1]!, text: f.chunk_text }));
  const held = await heldFenceLines(engine, chunks.map(c => ({ source_id: c.key.m.source_id, slug: c.key.m.slug, chunk_text: c.text })));
  const shown = new Map<ExactMatch['snippets'][number], string[]>();
  chunks.forEach((c, n) => {
    const ranges: Array<[number, number]> = [];
    let at = 0;
    c.text.split('\n').forEach((line, l) => { if (held[n]!.has(l)) ranges.push([at, at + line.length + 1]); at += line.length + 1; });
    for (let o = c.text.indexOf(c.key.s.text); o !== -1; o = c.text.indexOf(c.key.s.text, o + 1)) {
      let text = '';
      for (let x = o; x < o + c.key.s.text.length; x++) if (!ranges.some(([a, b]) => x >= a && x < b)) text += c.text[x];
      shown.set(c.key.s, [...(shown.get(c.key.s) ?? []), text]);
    }
  });
  const out: M[] = [];
  for (const m of matches) {
    const snippets = m.snippets.flatMap(s => {
      const texts = shown.get(s) ?? [];
      return texts.length && texts.every(holdsPhrase) ? [{ ...s, text: texts.reduce((a, b) => (b.length < a.length ? b : a)) }] : [];
    });
    if (snippets.length) out.push({ ...m, matching_chunks: m.matching_chunks - (m.snippets.length - snippets.length), snippets });
  }
  return out;
}

function parseParams(ctx: OperationContext, p: Record<string, unknown>) {
  const bad = (param: string, message: string, example: unknown) =>
    invalidParam(ctx, 'search_exact', param, 'search_exact: ' + message, { def: search_exact.params[param], example });
  const phrase = typeof p.phrase === 'string' ? p.phrase.trim() : '';
  if (!phrase) throw bad('phrase', 'phrase must be the literal text to find', 'invoice INV-2024-0042');
  if (phrase.length > EXACT_MAX_PHRASE_CHARS) throw bad('phrase', 'phrase must be at most ' + EXACT_MAX_PHRASE_CHARS + ' characters', 'invoice INV-2024-0042');
  if (p.case_sensitive !== undefined && typeof p.case_sensitive !== 'boolean') throw bad('case_sensitive', 'case_sensitive must be true or false', true);
  const limit = p.limit ?? EXACT_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > EXACT_MAX_LIMIT) {
    throw bad('limit', 'limit must be an integer from 1 to ' + EXACT_MAX_LIMIT, EXACT_DEFAULT_LIMIT);
  }
  const after = p.after;
  if (after !== undefined && (typeof after !== 'number' || !Number.isInteger(after) || after < 0)) throw bad('after', 'after must be the resume_after value of an earlier call', 1200);
  const seconds = p.max_seconds ?? EXACT_DEFAULT_SECONDS;
  if (typeof seconds !== 'number' || !(seconds > 0) || seconds > EXACT_MAX_SECONDS) {
    throw bad('max_seconds', 'max_seconds must be a number above 0 and at most ' + EXACT_MAX_SECONDS, EXACT_DEFAULT_SECONDS);
  }
  let types: string[] | undefined;
  if (p.types !== undefined) {
    const ok = Array.isArray(p.types) && p.types.length >= 1 && p.types.length <= 50 && p.types.every(t => typeof t === 'string' && TYPE_NAME.test(t));
    if (!ok) throw bad('types', 'types must be a list of page type names', ['meeting']);
    types = [...new Set(p.types as string[])];
  }
  const slugPrefix = p.slug_prefix;
  if (slugPrefix !== undefined && (typeof slugPrefix !== 'string' || slugPrefix.trim() === '')) throw bad('slug_prefix', 'slug_prefix must be a slug prefix', 'meetings/');
  return { phrase, caseSensitive: p.case_sensitive === true, limit, after: after as number | undefined, seconds, types, slugPrefix: slugPrefix as string | undefined };
}

const search_exact: Operation = {
  name: 'search_exact',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  scope: 'read',
  description: 'Find every page containing a literal phrase or identifier, exhaustively: use instead of grep. Unranked; returns every match in page order with snippets, '
    + 'and complete: true only when every page you can read was scanned. Literal: words in order with any whitespace between them, case-insensitive unless case_sensitive; '
    + 'no stemming, punctuation literal (ranked search treats quotes as a stemmed phrase). When complete is false, incomplete_reasons says why: deadline or limit '
    + '(call again with after: resume_after), or unreadable_pages (pages whose text is not indexed yet, listed under unreadable).',
  params: {
    phrase: { type: 'string', required: true, description: "The literal text, e.g. 'INV-2024-0042' or 'quarterly board pack'." },
    case_sensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
    source_id: { type: 'string', description: "Only this source; '__all__' spans every source you can read." },
    types: { type: 'array', minItems: 1, items: { type: 'string' }, description: "Only these page types, e.g. ['meeting']." },
    slug_prefix: { type: 'string', description: "Only slugs starting with this, e.g. 'meetings/'." },
    limit: { type: 'number', minimum: 1, description: 'Matching pages to return (default ' + EXACT_DEFAULT_LIMIT + ', max ' + EXACT_MAX_LIMIT + ').' },
    after: { type: 'number', description: 'Resume a bounded scan: the resume_after of the previous call.' },
    max_seconds: { type: 'number', exclusiveMinimum: 0, description: 'Scan budget in seconds (default ' + EXACT_DEFAULT_SECONDS + ', max ' + EXACT_MAX_SECONDS + ').' },
    min_trust: MIN_TRUST_PARAM,
  },
  handler: async (ctx, p) => {
    const params = parseParams(ctx, p);
    const startedAt = Date.now();
    const sourceIdParam = parseSourceIdParam(p.source_id, 'search_exact', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    const { floor } = await resolveReadEligibility(ctx, { minTrust: p.min_trust });
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const { resolveExcludePrivatePages, worldOnlyFacts } = await import('../search/private-visibility.ts');
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const { resolveHardExcludes } = await import('../search/source-boost.ts');
    const excludeSlugPrefixes = resolveHardExcludes();
    const result = await runExactScan(ctx.engine, {
      phrase: params.phrase,
      caseSensitive: params.caseSensitive,
      ...scope,
      ...(params.types ? { types: params.types } : {}),
      ...(params.slugPrefix ? { slugPrefix: params.slugPrefix } : {}),
      excludeSlugPrefixes,
      excludePrivate,
      remote: ctx.remote !== false,
      ...(floor ? { minTrust: floor } : {}),
      limit: params.limit,
      ...(params.after !== undefined ? { afterPageId: params.after } : {}),
      deadlineMs: startedAt + params.seconds * 1000,
    });
    const { stampPageTrust } = await import('../eligibility/stamp.ts');
    const pattern = phrasePattern(params.phrase);
    const fold = (t: string) => (params.caseSensitive ? t : t.toLowerCase()).replace(/\s+/g, ' ');
    const needle = fold(params.phrase.trim());
    const visible = worldOnlyFacts(ctx.remote)
      ? pattern ? await withoutHeldSnippets(ctx.engine, result.matches, text => fold(text).includes(needle)) : []
      : result.matches;
    const matches = await stampPageTrust(ctx.engine, visible.map(m => ({ ...m, chunk_text: m.snippets.map(s => s.text).join('\n') })), floor);
    // GST-687: an untrusted reader gets a chat page's snippets, or snippets below the owner's tier, quoted (tool calls summarized on a chat page).
    const { quotePageText, quotesStored } = await import('../search/transcript-quote.ts');
    const quoted = <M extends Omit<(typeof matches)[number], 'chunk_text'>>(m: M) => ctx.remote !== false && quotesStored(m.type, (m as { trust_tier?: unknown }).trust_tier)
      ? { ...m, snippets: m.snippets.map(s => ({ ...s, text: quotePageText(s.text, m.slug, m.type) })), quoted: 'transcript' as const } : m;
    return {
      phrase: params.phrase,
      case_sensitive: params.caseSensitive,
      matches: matches.map(({ chunk_text: _text, ...m }) => quoted(m)),
      complete: result.complete,
      incomplete_reasons: result.incomplete_reasons,
      resume_after: result.resume_after,
      pages_scanned: result.pages_scanned,
      unreadable: result.unreadable,
      excluded_slug_prefixes: excludeSlugPrefixes,
      latency_ms: Date.now() - startedAt,
    };
  },
  cliHints: { name: 'search-exact', positional: ['phrase'] },
};

export const searchExactOperations: Operation[] = [search_exact];
