/**
 * GST-359 C2: the all-ops member sweep's argument builder, shared by test/access-member-sweep.test.ts (dispatch, both
 * engines) and test/e2e/serve-http-member-sweep.test.ts (a real serve --http on a keyless brain). For every operation
 * it builds the arguments that would reach a member's fact if any path leaked it: the member page, the entity page,
 * the fact's id, a query that matches its words (never the canary itself, so an echoed argument is no false alarm).
 */
import type { Operation } from '../../src/core/ops/contract.ts';

export interface SweepFixture {
  sourceId: string;
  memberSlug: string;
  entitySlug: string;
  entityName: string;
  /** Words that match the member's fact; the canary itself is never sent. */
  words: string;
  factId: string;
  requestId: string;
  sessionId: string;
}

const STRING_BY_NAME: Record<string, (f: SweepFixture, slug: string) => unknown> = {
  slug: (_f, slug) => slug, from: (_f, slug) => slug, to: (f) => f.entitySlug, source_slug: (_f, slug) => slug, page: (_f, slug) => slug,
  slug_prefix: (f) => f.memberSlug.slice(0, f.memberSlug.lastIndexOf('/') + 1), prefix: (f) => f.memberSlug.slice(0, f.memberSlug.lastIndexOf('/') + 1),
  partial: (_f, slug) => slug.split('/').pop(), path: (_f, slug) => slug + '.md',
  query: (f) => f.words, q: (f) => f.words, question: (f) => f.words, phrase: (f) => f.words, prompt: (f) => f.words, text: (f) => f.words,
  topic: (f) => f.words, turn_text: (f) => f.words, content: (f) => '---\ntype: note\n---\n' + f.words, claim: (f) => f.words, summary: (f) => f.words,
  entity: (f) => f.entityName, name: (f) => f.entityName, symbol: (f) => f.entityName, entry_point: (f) => f.entityName,
  id: (f) => f.factId, fact_id: (f) => f.factId, ref: (f) => f.factId, answer_id: (f) => f.factId, upload_id: (f) => f.requestId,
  request_id: (f) => f.requestId, session_id: (f) => f.sessionId, source_id: (f) => f.sourceId,
  since: () => '2000-01-01T00:00:00Z', date: () => new Date().toISOString().slice(0, 10), until: () => '2999-01-01T00:00:00Z',
  expected_revision: () => '00000000-0000-0000-0000-000000000000', dimension: () => 'stage', value: () => 'seed', kind: () => 'fact',
};
const ARRAY_BY_NAME: Record<string, (f: SweepFixture, slug: string) => unknown[]> = {
  slugs: (f, slug) => [slug, f.entitySlug], entities: (f) => [f.entitySlug], names: (f) => [f.entityName], ids: (f) => [f.factId],
  hits: (_f, slug) => [{ slug }], paths: (_f, slug) => [slug + '.md'], window: (f) => [{ role: 'user', content: f.words }],
};

function valueFor(name: string, def: Operation['params'][string], f: SweepFixture, slug: string): unknown {
  if (def.type === 'array') return ARRAY_BY_NAME[name]?.(f, slug) ?? (def.items?.type === 'string' ? [f.words] : []);
  if (def.type === 'string') {
    const named = STRING_BY_NAME[name]?.(f, slug);
    if (named !== undefined) return def.enum && !def.enum.includes(String(named)) ? def.enum[0] : named;
    return def.enum ? def.enum[0] : f.words;
  }
  if (def.type === 'number') return name === 'limit' ? 50 : 1;
  if (def.type === 'boolean') return name.startsWith('include') || name === 'detail';
  return {};
}

const SLUG_PARAMS = new Set(['slug', 'from', 'source_slug', 'page', 'partial', 'path', 'slugs', 'hits', 'paths']);
const SENT_OPTIONAL = new Set(['query', 'question', 'entity', 'entities', 'since', 'session_id', 'id', 'slug', 'include_private', 'detail']);

/** One argument set per target page for each operation (member page and entity page when it takes a slug). */
export function sweepArgs(op: Pick<Operation, 'params'>, f: SweepFixture): Record<string, unknown>[] {
  const params = Object.entries(op.params ?? {});
  const slugs = params.some(([name]) => SLUG_PARAMS.has(name)) ? [f.memberSlug, f.entitySlug] : [f.memberSlug];
  return slugs.map(slug => Object.fromEntries(params.filter(([name, def]) => def.required || SENT_OPTIONAL.has(name)).map(([name, def]) => [name, valueFor(name, def, f, slug)])));
}
