import { opError } from '../ops/contract.ts';
import { callerAccessAllowedSql, callerIdentity, currentCallerAccess, readPolicyFragment, readRemotePolicyNow, withCallerAccess } from '../search/private-visibility.ts';
import { parseMarkdown } from '../markdown.ts';
import { folderAccessFor, memberIdentityFor } from '../access/caller.ts';
import { hasReaders, normalizePrincipal, normalizeReaders, readersAllow, NOBODY } from '../access/principals.ts';
import { catalogueError } from '../error-catalogue.ts';
import type { SqlEngine, WriteAuthority } from './model.ts';

/** Publication uses fresh policy, independent of the read-side telemetry cache (read through the resolver). */
export async function excludesPrivateWrites(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote) return false;
  return !(await readRemotePolicyNow(engine)).privacyRelaxed;
}

/**
 * excludesPrivateWrites for a write's admission: reuses the fresh policy this remote request read when it started
 * (remoteCallerAccess) instead of reading it again. A false result is rechecked fresh at publication.
 */
export async function excludesPrivateWritesAtAdmission(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote) return false;
  return !(currentCallerAccess().remotePolicy ?? await readRemotePolicyNow(engine)).privacyRelaxed;
}

/**
 * Recheck after page guards at publication; also hide inaccessible receipt targets. GBRA-218: on a brain with
 * member-access restrictions the writer's identity is re-resolved from the stored principal on every check, so a
 * member disabled or unbound after submission (a queued job, a replay) loses the page before commit, and the
 * member-access part applies even when an operator relaxed privacy.
 */
export async function authorizePageVisibility(engine: SqlEngine, authority: WriteAuthority, slug: string): Promise<void> {
  if (!authority.remote) return;
  if (authority.excludePrivate ?? true) {
    // Privacy is hidden whatever the policy says, and an empty identity is the strictest reading (an identity only
    // opens a page that names readers), so a page visible with none needs no policy read or member lookup.
    const [hidden] = await engine.executeRaw<{ names_readers: boolean }>(`SELECT page_readers IS NOT NULL AS names_readers FROM pages
      WHERE source_id=$1 AND slug=$2 AND NOT (${readPolicyFragment('pages', [], true)}) LIMIT 1`, [authority.sourceId, slug]);
    if (!hidden) return;
    if (!hidden.names_readers) throw pageNotVisibleError();
  }
  const policy = await readRemotePolicyNow(engine);
  const hidePrivate = (authority.excludePrivate ?? true) || !policy.privacyRelaxed;
  if (!hidePrivate && !policy.restricted) return;
  const identity = policy.restricted ? await memberIdentityFor(engine, authority) : [];
  const folder = policy.restricted ? await folderAccessFor(engine, identity) : { satisfiedRuleIds: [], folderCoverage: [] };
  const fragment = withCallerAccess({ folderCoverage: folder.folderCoverage }, () => readPolicyFragment('pages', identity, hidePrivate, folder.satisfiedRuleIds));
  const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2
    AND NOT (${fragment}) LIMIT 1`, [authority.sourceId, slug]);
  if (rows.length) throw pageNotVisibleError();
}

/**
 * GBRA-218: a remote write that touches an existing page outside the durable write path (graph edges, raw data)
 * must be able to read it under the member-access part; privacy keeps the rule each operation already had.
 */
export async function assertRemoteTargetReadable(engine: SqlEngine, remote: boolean | undefined, sourceId: string, slug: string): Promise<void> {
  if (await remoteTargetHidden(engine, remote, sourceId, slug)) throw pageNotVisibleError();
}

/** Whether an existing page is hidden from the current remote caller by the member-access part (never for a trusted local caller). */
export async function remoteTargetHidden(engine: SqlEngine, remote: boolean | undefined, sourceId: string, slug: string): Promise<boolean> {
  if (remote === false) return false;
  const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND NOT ${callerAccessAllowedSql('pages')} LIMIT 1`, [sourceId, slug]);
  return rows.length > 0;
}

/**
 * GBRA-218: a remote write's `readable_by` is well formed (readable_by_invalid names the bad entry and the corrected
 * YAML form) and keeps the page readable by the writer's `identity`. Checked at submission with the request's
 * identity and again at preparation with the identity re-resolved from the stored principal.
 */
export function assertRemoteReadersValid(frontmatter: unknown, identity: readonly string[]): void {
  if (!hasReaders(frontmatter)) return;
  const value = (frontmatter as Record<string, unknown>).readable_by;
  if (normalizeReaders(frontmatter)?.[0] === NOBODY) {
    const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    const bad = entries.find(e => typeof e !== 'string' || normalizePrincipal(e) === null);
    const kept = entries.filter((e): e is string => typeof e === 'string' && normalizePrincipal(e) !== null).map(e => e.trim().toLowerCase());
    const example = `readable_by: [${(kept.length ? kept : ['alice-example', 'group:team-a']).join(', ')}]`;
    const what = bad !== undefined ? `the entry ${JSON.stringify(bad)} is not a member id or group:<id>`
      : entries.length === 0 ? 'it names no reader' : 'it is not a string or a list of strings (at most 256)';
    throw catalogueError('readable_by_invalid', `readable_by is invalid: ${what}.`,
      `Nothing was written. Member and group ids are lower-case letters, digits, '.', '_' and '-' (1-64 characters); write the field as ${example} and submit again with a new request_id.`);
  }
  if (!readersAllow(frontmatter, identity)) {
    throw catalogueError('readable_by_invalid', 'readable_by would leave this page unreadable by this connection.',
      `Nothing was written. Keep this connection's member${identity.length ? ` (${identity.join(', ')})` : ' (this connection is bound to none)'} or one of its groups in readable_by, or ask the user to change the readers on the brain host.`);
  }
}

/** A remote put_page's readable_by, checked with the request's identity before anything is admitted (preparation checks it again). */
export function assertSubmittedReaders(remote: boolean | undefined, slug: unknown, content: unknown): void {
  if (remote === false || typeof content !== 'string' || !content.includes('readable_by')) return;
  assertRemoteReadersValid(parseMarkdown(content, typeof slug === 'string' ? slug : 'page').frontmatter, callerIdentity());
}

/**
 * The preparation-time check, returning the prepared import it was given: the stored principal's live identity, and a
 * remote write never drops readable_by from a page that names readers.
 */
export async function remoteReadersChecked<T extends { parsedPage: { frontmatter: unknown } }>(engine: SqlEngine, authority: WriteAuthority, before: unknown, prepared: T): Promise<T> {
  const after = prepared.parsedPage.frontmatter;
  if (!authority.remote || (!hasReaders(before) && !hasReaders(after))) return prepared;
  if (!hasReaders(after)) {
    throw catalogueError('readable_by_invalid', 'This write removes readable_by from a page that names readers.',
      'Nothing was written. A remote write keeps the readable_by line: read the page with get_page include_content:true and keep its frontmatter, or ask the user to widen the page on the brain host.');
  }
  assertRemoteReadersValid(after, await memberIdentityFor(engine, authority));
  return prepared;
}

/** The one refusal a remote writer gets for a target it may not see; other visibility refusals reuse it verbatim. */
export function pageNotVisibleError() {
  return opError('page_not_found', 'Page not found.', 'This page does not exist or is not visible to this connection, so nothing was written. Do not retry this slug as a create; ask the user whether the page exists and who can read it, or write to a different slug.');
}
