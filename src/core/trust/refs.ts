/**
 * Typed refs of `gbrain trust` (#5575 DX-7): `f<id>` fact, `t<id>` take,
 * `h<id>` write-gate hold, `tp<id>` trust proposal, `a<id>` allow rule, and
 * `p:<source>/<slug>` page. A bare slug names a page too: it resolves to its
 * source through `--source`, or to the only source holding it; a slug that
 * lives in several sources refuses and lists them (like `quarantine clear`).
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';

export type TrustRef =
  | { kind: 'fact'; id: number }
  | { kind: 'take'; id: number }
  | { kind: 'hold'; id: number }
  | { kind: 'proposal'; id: number }
  | { kind: 'allow_rule'; id: number }
  | { kind: 'page'; sourceId: string | null; slug: string };

const ID = '(\\d{1,18})';
const PATTERNS: Array<[RegExp, TrustRef['kind']]> = [
  [new RegExp(`^tp${ID}$`), 'proposal'],
  [new RegExp(`^f${ID}$`), 'fact'],
  [new RegExp(`^t${ID}$`), 'take'],
  [new RegExp(`^h${ID}$`), 'hold'],
  [new RegExp(`^a${ID}$`), 'allow_rule'],
];

const refHelp = 'Use f<id> (fact), t<id> (take), h<id> (held write), tp<id> (trust proposal), p:<source>/<slug> or a page slug; gbrain trust review lists them.';

/** Parses one ref. A page ref without a source keeps `sourceId: null` for `resolvePageRef`. */
export function parseTrustRef(raw: string): TrustRef {
  const ref = raw.trim();
  for (const [pattern, kind] of PATTERNS) {
    const m = pattern.exec(ref);
    if (m) return { kind, id: Number(m[1]) } as TrustRef;
  }
  if (ref.startsWith('p:')) {
    const body = ref.slice(2);
    const slash = body.indexOf('/');
    const sourceId = slash > 0 ? body.slice(0, slash) : '';
    const slug = slash > 0 ? body.slice(slash + 1) : '';
    if (!isValidSourceId(sourceId) || !slug) {
      throw opError('invalid_params', `Page ref ${JSON.stringify(ref)} must be p:<source>/<slug>.`, `Write the page with its source, e.g. p:default/notes/alice-example. ${refHelp}`);
    }
    return { kind: 'page', sourceId, slug };
  }
  if (!ref || ref.startsWith('-') || /\s/.test(ref)) throw opError('invalid_params', `Not a trust ref: ${JSON.stringify(raw)}.`, refHelp);
  return { kind: 'page', sourceId: null, slug: ref };
}

/** The canonical ref text of a page. */
export const pageRef = (sourceId: string, slug: string): string => `p:${sourceId}/${slug}`;

/** The canonical text of any ref (pages need their resolved source). */
export function formatTrustRef(ref: TrustRef): string {
  switch (ref.kind) {
    case 'fact': return `f${ref.id}`;
    case 'take': return `t${ref.id}`;
    case 'hold': return `h${ref.id}`;
    case 'proposal': return `tp${ref.id}`;
    case 'allow_rule': return `a${ref.id}`;
    case 'page': return ref.sourceId ? pageRef(ref.sourceId, ref.slug) : ref.slug;
  }
}

/**
 * Resolves a page ref to its source: an explicit `--source` must agree with a
 * `p:` ref's source; a bare slug takes `--source`, else the one source that
 * holds the slug. Refuses an ambiguous slug instead of picking a source.
 */
export async function resolvePageRef(engine: Pick<BrainEngine, 'executeRaw'>, ref: Extract<TrustRef, { kind: 'page' }>, explicitSource?: string | null): Promise<{ sourceId: string; slug: string }> {
  if (ref.sourceId && explicitSource && ref.sourceId !== explicitSource) {
    throw opError('invalid_params', `${pageRef(ref.sourceId, ref.slug)} names source ${ref.sourceId}, but --source is ${explicitSource}.`,
      'Drop --source, or pass the page ref with the source you mean.');
  }
  const sourceId = ref.sourceId ?? explicitSource ?? null;
  if (sourceId) return { sourceId, slug: ref.slug };
  const rows = await engine.executeRaw<{ source_id: string }>(
    'SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id', [ref.slug]);
  if (rows.length > 1) {
    throw opError('invalid_params', `Slug "${ref.slug}" exists in ${rows.length} sources: ${rows.map(r => r.source_id).join(', ')}.`,
      `Pick one with --source ${rows[0]!.source_id} (or another listed source), or write the page as ${pageRef(rows[0]!.source_id, ref.slug)}.`);
  }
  if (rows.length === 0) throw opError('page_not_found', `No page "${ref.slug}" in any source.`, 'Check the slug; gbrain trust review lists pages waiting for you.');
  return { sourceId: rows[0]!.source_id, slug: ref.slug };
}
