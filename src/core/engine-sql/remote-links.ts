/**
 * The statements a remote page write's `links` effect (persistence/effect-links.ts) and the batch re-arm
 * (persistence/effect-journal.ts queueLinksReconcile) sent through `executeRaw`: the effect transaction's settings,
 * the edges the producer owns from a page, their removal, the link targets a writer may read, and the re-arm of a
 * batch's `links` effects. One SQL implementation for both engines. Each text is the one its caller has always sent,
 * except that the removal also names the origin page and the producer (the same rows in that caller); the decisions
 * (which targets get an edge, when a batch re-arms) stay with the callers.
 *
 * The batch re-arm writes the protocol predicate out, as persistence-effect-worker.ts does (`PROTOCOL_PREDICATE_SQL`).
 *
 * The writer's read policy is gathered by persistence/page-visibility.ts (writerReadPolicy) and rendered here
 * (renderWriterReadPolicy), so an engine that cannot run the rendered text can judge the gathered inputs instead.
 */
import { labelledOnlyForSql, privacyPartSql, readPolicyFragment, withCallerAccess, type FolderCoverage } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { EffectExec } from './persistence-effect-worker.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/** The settings the links effect's transaction opens with: synchronous commit, a 1s lock wait and a 5s statement limit. */
export const EFFECT_TRANSACTION_LIMITS_SQL = "SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)";

/** setEffectTransactionLimits: sends EFFECT_TRANSACTION_LIMITS_SQL on the transaction's connection. */
export async function setEffectTransactionLimits(exec: EffectExec): Promise<void> {
  await exec.executeRaw(EFFECT_TRANSACTION_LIMITS_SQL);
}

/** One edge a producer owns from a page: the link id and its target's slug. */
export interface OwnedLink { id: number; slug: string }

/** readOwnedLinks: the edges of `linkSource` whose origin is page `originPageId`, with each target's slug. */
export async function readOwnedLinks(exec: LegacyUnscopedRead, linkSource: string, originPageId: number | string): Promise<OwnedLink[]> {
  return exec.executeRaw<OwnedLink>(`SELECT l.id,t.slug FROM links l JOIN pages t ON t.id=l.to_page_id
    WHERE l.link_source=$1 AND l.origin_page_id=$2`, [linkSource, originPageId]);
}

/**
 * deleteOwnedLinks: removes the edges among `ids` that `linkSource` owns from page `originPageId`; returns how many.
 * The caller passes ids it read with readOwnedLinks in the same locked transaction, so the origin and source terms
 * match every id; they keep the statement to the producer's own edges.
 */
export async function deleteOwnedLinks(exec: EffectExec, originPageId: number | string, linkSource: string, ids: readonly (number | string)[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await exec.executeRaw(`DELETE FROM links WHERE id=ANY($1::bigint[]) AND origin_page_id=$2 AND link_source=$3 RETURNING id`,
    [[...ids], originPageId, linkSource]);
  return rows.length;
}

/**
 * The read policy a stored remote write's writer is held to, as gathered inputs: the identities it reads as (every one
 * must meet a page's readers), the folder rules they satisfy, the folder coverage, whether it is the owner speaking
 * for itself, and whether it is held to pages that name it (labelled-only).
 */
export interface WriterReadPolicy {
  identities: readonly (readonly string[])[];
  satisfiedRuleIds: readonly string[];
  folderCoverage: readonly FolderCoverage[];
  owner: boolean;
  labelledOnly: boolean;
}

/** The SQL text of `policy` over page alias `pageAlias`: member access, then privacy when `hidePrivate`. */
export function renderWriterReadPolicy(policy: WriterReadPolicy, pageAlias: string, hidePrivate: boolean): string {
  const fragment = withCallerAccess({ folderCoverage: policy.folderCoverage, ...(policy.owner ? { owner: true } : {}) },
    () => readPolicyFragment(pageAlias, { all: policy.identities }, hidePrivate, policy.satisfiedRuleIds));
  return policy.labelledOnly ? `(${fragment} AND ${labelledOnlyForSql(pageAlias, policy.identities, policy.satisfiedRuleIds)})` : fragment;
}

/** One live link target: whether the writer may read it (member access) and whether the privacy part shows it. */
export interface LinkTargetPage { slug: string; readable: boolean; visible: boolean }

/**
 * readLinkTargetPages: the live pages of `sourceId` among `slugs`, each with whether `policy` (the writer's read
 * policy, member access alone) passes it and whether the privacy part shows it. A null policy is a trusted writer:
 * every page is readable.
 */
export async function readLinkTargetPages(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], policy: WriterReadPolicy | null): Promise<LinkTargetPage[]> {
  if (!slugs.length) return [];
  const { rows } = await exec.run<LinkTargetPage>(sqlFragment`SELECT p.slug,(${trustedSql(policy ? renderWriterReadPolicy(policy, 'p', false) : 'TRUE')}) AS readable,
    (${trustedSql(privacyPartSql('p'))}) AS visible
    FROM pages p WHERE p.source_id=${sourceId} AND p.slug=ANY(${[...slugs]}::text[]) AND p.deleted_at IS NULL`);
  return rows;
}
