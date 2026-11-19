/**
 * The reads `remember` and `forget` (src/core/persistence/memory-mutations.ts) ran through `executeRaw` before they had
 * typed members. Each function keeps the statement text its call site ran, so PGLite and Postgres answer exactly as
 * before (test/memory-mutation-reads-sql-pin.test.ts pins the Postgres text); a Rust brain answers from its store
 * (rust/crates/gbrain-store/src/facts/memory_reads.rs).
 *
 * - `readSourceWriteRow`: the source row a memory write admits against (incarnation, archived, checkout, kind, role).
 * - `readSourceLocalPath`: a source's checkout path, for the missing-entity-page notice.
 * - `readFactEntitySlug`: the entity a fact is keyed under, for a member's withdrawal of a shared fact about itself.
 * - `hasLiveFileBackedPage`: whether a live page among the struck slugs has a file, so forget must strike it there.
 * - `factReadableUnder`: whether the caller reads a fact (the member withdrawal check), under the caller's visibility,
 *   read eligibility and, optionally, the private-provenance policy.
 * - `readRemoteForgetTier`: the stored tier of the world fact a remote forget targets
 *   (guardRemoteForget, src/core/trust/supersede-handlers.ts), optionally under the remote provenance floor.
 * - `readForgetTarget`: the fact a forget names (src/core/persistence/forget-prepare.ts) under the caller's visibility,
 *   optionally under the remote provenance floor, or on a member's own page; locked FOR UPDATE with `lock`.
 */
import type { BrainEngine, FactReadableSpec, ForgetTargetRow, ForgetTargetSpec, SourceWriteRow } from '../engine.ts';
import { MEMBER_PAGE_PREFIX, factVisibilitySql } from '../access/member-facts.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { privateProvenanceFilterUnderPolicy, remoteProvenanceFloorSql } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

async function rows<T>(exec: Raw, fragment: SqlFragment): Promise<T[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<T>(text, params);
}

/** The source row a memory write admits against, or null for an unknown id. */
export async function readSourceWriteRow(exec: Raw, sourceId: string): Promise<SourceWriteRow | null> {
  const [row] = await rows<SourceWriteRow>(exec,
    sqlFragment`SELECT incarnation,archived,local_path,config->>'kind' AS kind,config->>'role' AS role FROM sources WHERE id=${sourceId}`);
  return row ?? null;
}

/** A source's checkout path; null for an unknown id or a source with none. */
export async function readSourceLocalPath(exec: Raw, sourceId: string): Promise<string | null> {
  const [row] = await rows<{ local_path: string | null }>(exec, sqlFragment`SELECT local_path FROM sources WHERE id=${sourceId}`);
  return row?.local_path ?? null;
}

/** The entity slug of fact `id` in `sourceId`; null when no such fact or it names none. */
export async function readFactEntitySlug(exec: Raw, id: number, sourceId: string): Promise<string | null> {
  const [row] = await rows<{ entity_slug: string | null }>(exec,
    sqlFragment`SELECT entity_slug FROM facts WHERE id=${id} AND source_id=${sourceId}`);
  return row?.entity_slug ?? null;
}

/** Whether a live page of `sourceId` among `slugs` has a source file. */
export async function hasLiveFileBackedPage(exec: Raw, sourceId: string, slugs: readonly string[]): Promise<boolean> {
  const found = await rows(exec,
    sqlFragment`SELECT 1 FROM pages WHERE source_id=${sourceId} AND slug=ANY(${[...slugs]}::text[]) AND deleted_at IS NULL AND source_path IS NOT NULL LIMIT 1`);
  return found.length > 0;
}

/**
 * Whether fact `id` of `sourceId` is one the caller reads: any visibility (`anyVisibility`, the brain owner) or the
 * caller's world-visibility rule (factVisibilitySql, which a member page or a grant widens), the read eligibility
 * predicate, and with `excludePrivate` the private-provenance policy. The fragments render for the caller in context.
 */
export async function factReadableUnder(exec: Raw, spec: FactReadableSpec): Promise<boolean> {
  const readable = spec.anyVisibility ? 'TRUE' : factVisibilitySql('facts', ['world']);
  const eligible = projectionEligibleSql('facts', 'facts', spec.eligibility);
  const provenance = spec.excludePrivate ? ` AND ${privateProvenanceFilterUnderPolicy('facts')}` : '';
  const found = await rows(exec, sqlFragment`SELECT 1 FROM facts WHERE id=${spec.id} AND source_id=${spec.sourceId} AND ${trustedSql(readable)} AND ${trustedSql(eligible)}${trustedSql(provenance)}`);
  return found.length > 0;
}

/**
 * The stored trust tier of fact `factId` of `sourceId` when it is a world fact, with `remoteFloor` only when it passes
 * the remote provenance floor (remoteProvenanceFloorSql, rendered for the caller in context); null otherwise.
 */
export async function readRemoteForgetTier(exec: Raw, spec: { factId: number; sourceId: string; remoteFloor: boolean }): Promise<string | null> {
  const floor = spec.remoteFloor ? ` AND ${remoteProvenanceFloorSql('facts')}` : '';
  const [row] = await rows<{ trust_tier: string }>(exec,
    sqlFragment`SELECT trust_tier FROM facts WHERE id = ${spec.factId} AND source_id = ${spec.sourceId} AND visibility = 'world'${trustedSql(floor)}`);
  return row?.trust_tier ?? null;
}

/**
 * The fact `id` of `sourceId` a forget names, or null when the caller does not see it. With `ownPage` (a member's
 * withdrawal on its own member page) only a private fact on that page while the live page names the member among its
 * readers; otherwise any fact, only a world one with `worldOnly`, and with `remoteFloor` only one that passes the
 * remote provenance floor (remoteProvenanceFloorSql, rendered for the caller in context). `lock` adds FOR UPDATE.
 * The text is the one forget-prepare.ts ran, except that the member page's slug binds twice ($3 and $4), not once.
 */
export async function readForgetTarget(exec: Raw, spec: ForgetTargetSpec): Promise<ForgetTargetRow | null> {
  const own = spec.ownPage;
  const scope = own
    ? sqlFragment`visibility='private' AND source_markdown_slug=${own} AND EXISTS (SELECT 1 FROM pages member_page\n      WHERE member_page.source_id=facts.source_id AND member_page.slug=${own} AND member_page.deleted_at IS NULL AND member_page.page_readers && ARRAY[${`member:${own.slice(MEMBER_PAGE_PREFIX.length)}`}::text])`
    : sqlFragment`(${spec.worldOnly}::boolean=false OR visibility='world')${trustedSql(spec.remoteFloor ? ` AND ${remoteProvenanceFloorSql('facts')}` : '')}`;
  const [row] = await rows<ForgetTargetRow>(exec,
    sqlFragment`SELECT id,entity_slug,source_markdown_slug,row_num,expired_at,trust_tier FROM facts\n    WHERE id=${spec.id} AND source_id=${spec.sourceId} AND ${scope}${trustedSql(spec.lock ? ' FOR UPDATE' : '')}`);
  return row ?? null;
}
