/**
 * The relational recall arm's page reads (search/relational-recall.ts). One SQL implementation for both engines; each
 * statement text is what the arm sent through `executeRaw`. The decisions (which seeds to resolve, what to hydrate)
 * stay in the arm.
 */
import type { PageReadPolicy } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import type { LegacyUnscopedRead } from './brands.ts';

/** A (source_id, slug) page reference. */
export interface PageRefRow { source_id: string; slug: string }

const REFS_JOIN = `JOIN unnest($1::text[], $2::text[]) AS refs(source_id, slug)
       ON p.source_id = refs.source_id AND p.slug = refs.slug`;

/**
 * The refs that name a live, unquarantined page of an unarchived source which `policy` admits (its source scope,
 * private-page filter and trust floor; `pageReadFilter` live), in no set order. A ref listed twice answers twice.
 */
export async function readAdmittedPageRefs(exec: LegacyUnscopedRead, refs: readonly PageRefRow[], policy: PageReadPolicy): Promise<PageRefRow[]> {
  if (!refs.length) return [];
  const params: unknown[] = [refs.map(ref => ref.source_id), refs.map(ref => ref.slug)];
  const filter = pageReadFilter('p', policy, params, true);
  return exec.executeRaw<PageRefRow>(
    `SELECT p.source_id, p.slug FROM pages p
     ${REFS_JOIN} WHERE ${filter}`, params,
  );
}
