/**
 * GST-1113 (gaps 1+2 of the internal QM provider): scope sources. Each shared QM scope (a project, channel, team or org)
 * is its own gbrain source, marked `config.qm_scope: true`. The mark is sticky: it is set when the source first enters a
 * credential's `attest_sources` and no credential change clears it, so the scope's memory stays fenced after the scope
 * credential is revoked, rotated or narrowed. An attested memory_write may name a marked source its credential lists
 * (source_id) and lands on that source's scope page (`memory/scope`, world facts read by whoever holds read on the
 * source). Four rules keep a scope's audience exactly the credentials that list it:
 *  - perCallWriteSource / storedPerCallWriteSource: the one exception to one write source per credential, only for the
 *    scope page, live at submission and re-checked at publication (actorCoverage with the source);
 *  - assertScopeSourceGrant: no credential's read grant may name a marked source it does not list itself;
 *  - assertAttestSources: a source joins attest_sources (and is marked) only when no other credential reads it and it is
 *    not default, federated or the credential's own write source; it leaves only after the credential's read grant drops it;
 *  - a marked source is never federated (isSourceFederated reads the mark), so no connection without a grant reads it.
 * Everything is database state, so a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';
import { sqlQueryForEngine, type SqlQuery } from '../sql-query.ts';
import { GrantError, grantFromRow, grantFromTokenRow, type ClientGrant, type GrantSources } from '../grants/model.ts';
import { isScopeSourceConfig, normalizeSourceConfig, parseSourceConfig } from '../sources-load.ts';
import { SCOPE_PAGE_SLUG } from './principals.ts';

export { SCOPE_ATTEST_OPS } from './actor-model.ts';

/**
 * Whether this live write may target `sourceId` instead of the credential's own source: an attested memory_write that
 * named it, on a right listing it, and (when the slug is known) only for the scope page.
 */
export function perCallWriteSource(ctx: Pick<OperationContext, 'remote' | 'attestedOp' | 'attestedSource' | 'auth'>, sourceId: string, slug?: string): boolean {
  if (ctx.remote === false || ctx.attestedOp !== 'memory_write' || ctx.attestedSource !== sourceId) return false;
  if (slug !== undefined && slug !== SCOPE_PAGE_SLUG) return false;
  return !!currentCallerAccess().actor && !!ctx.auth?.attest?.sources?.includes(sourceId);
}

/**
 * The stored form: the scope source an attested memory_write was accepted for, when this authority writes it to the
 * scope page, else null. authorizeWrite exempts the owner's write source for it and re-checks it (actorCoverage).
 */
export function storedPerCallWriteSource(a: Pick<WriteAuthority, 'actingFor' | 'attestedOp' | 'attestedSource' | 'sourceId'>, slug: string): string | null {
  return a.actingFor && !Array.isArray(a.actingFor) && a.attestedOp === 'memory_write' && a.attestedSource === a.sourceId && slug === SCOPE_PAGE_SLUG
    ? a.attestedSource : null;
}

export function sourceNotAttested(sourceId: string): OperationError {
  return opError('permission_denied', `Source ${sourceId} is not one of this connection's scope sources, so nothing was saved.`,
    'Send source_id only for a scope source the brain operator listed for this credential with gbrain auth rescope --attest-sources, or omit it to save on the person\'s own member page.',
    { reason: 'source_not_attested', why: 'A scope source holds memory every member of that scope reads; only the sources the operator listed may receive it.' });
}

type Db = BrainEngine | SqlQuery;
const sqlOf = (db: Db): SqlQuery => typeof db === 'function' ? db : sqlQueryForEngine(db);

/**
 * The marked scope sources among `ids`. `lock` takes their rows in id order inside the caller's transaction: a grant
 * write FOR SHARE, an attest_sources change FOR UPDATE on the sources it marks, so the two serialize instead of each
 * missing the other's commit, while grant writes and publications (source FOR SHARE, then credential) never wait on
 * each other's source locks. Callers lock their credential row first.
 */
export async function markedScopeSources(db: Db, ids: readonly string[], lock?: 'share' | 'update'): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const sql = sqlOf(db);
  const list = JSON.stringify([...new Set(ids)]);
  const rows = lock === 'update'
    ? await sql`SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text(${list}::text::jsonb)) ORDER BY id FOR UPDATE`
    : lock === 'share'
      ? await sql`SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text(${list}::text::jsonb)) ORDER BY id FOR SHARE`
      : await sql`SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text(${list}::text::jsonb))`;
  return new Set(rows.filter(r => isScopeSourceConfig(r.config)).map(r => String(r.id)));
}

export interface CredentialRef { kind: 'token' | 'client'; id: string }
interface CredentialSources { ref: CredentialRef; reads: string[]; write: string | null; attest: string[]; privatePages: boolean; label: string }

const same = (a: CredentialRef, b: CredentialRef | null | undefined) => !!b && a.kind === b.kind && a.id === b.id;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/** The sources an OAuth client's grant reads: none, or its write source (default when unset) and federated_read. */
export function clientGrantReads(g: Pick<ClientGrant, 'sourcesNone' | 'sourceId' | 'federatedRead'>): string[] {
  return g.sourcesNone === true ? [] : [...new Set([g.sourceId ?? 'default', ...g.federatedRead])];
}

/** A principal grant's read sources and write source. */
export function sourcesOf(s: GrantSources): { reads: string[]; write: string | null } {
  if (s.kind === 'default') return { reads: ['default'], write: 'default' };
  if (s.kind === 'scalar') return { reads: [s.writeSource], write: s.writeSource };
  if (s.kind === 'federated') return { reads: [...new Set([s.writeSource, ...s.readSources])], write: s.writeSource };
  return { reads: [], write: null };
}

/** Every live credential's read sources, write source and attest_sources, read through the canonical grant model. */
async function credentialSources(sql: SqlQuery): Promise<CredentialSources[]> {
  const clients = await sql`SELECT * FROM oauth_clients WHERE (to_jsonb(oauth_clients)->>'deleted_at') IS NULL`;
  const tokens = await sql`SELECT * FROM access_tokens WHERE revoked_at IS NULL`;
  return [
    ...clients.map(row => {
      const g = grantFromRow(row);
      return { ref: { kind: 'client' as const, id: g.clientId }, reads: clientGrantReads(g), write: g.sourcesNone === true ? null : g.sourceId ?? 'default',
        attest: strings(row.attest_sources), privatePages: row.private_pages === 'granted_sources', label: `OAuth client ${g.clientId}` };
    }),
    ...tokens.map(row => ({ ref: { kind: 'token' as const, id: String(row.id) }, ...sourcesOf(grantFromTokenRow(row).sources),
      attest: strings(row.attest_sources), privatePages: row.private_pages === 'granted_sources', label: `token ${String(row.name ?? row.id)}` })),
  ];
}

/**
 * Refuses a grant whose read sources name a marked scope source this credential does not list. `self` is the credential
 * being written (null for one not inserted yet), whose stored attest_sources are honoured. `default` is never a scope
 * source (applyAttestSources refuses it), so a default-only grant reads nothing.
 */
export async function assertScopeSourceGrant(db: Db, self: CredentialRef | null, reads: readonly string[], opts: { privatePages?: boolean; writeSource?: string | null } = {}): Promise<void> {
  const sql = sqlOf(db);
  const attest = self && (opts.privatePages || opts.writeSource) ? (await credentialSources(sql)).find(c => same(c.ref, self))?.attest ?? [] : [];
  if (opts.privatePages && attest.length) {
    throw new GrantError('invalid_grant', 'This credential lists scope sources (--attest-sources), so it cannot hold the private-pages grant; nothing changed. '
      + 'A scope credential reads only shared memory: use a separate credential for private pages.');
  }
  if (opts.writeSource && attest.includes(opts.writeSource)) {
    throw new GrantError('invalid_grant', `Source ${opts.writeSource} is in this credential's --attest-sources, so it cannot be its write source (where member pages live); nothing changed. `
      + 'Keep member pages and each scope in separate sources: pick another write source.');
  }
  const candidates = reads.filter(s => s !== 'default');
  if (!candidates.length) return;
  const marked = await markedScopeSources(sql, candidates, 'share');
  if (!marked.size) return;
  const own = self ? (await credentialSources(sql)).find(c => same(c.ref, self))?.attest ?? [] : [];
  const reserved = [...marked].filter(s => !own.includes(s)).sort();
  if (!reserved.length) return;
  throw new GrantError('invalid_grant', `Source ${reserved.join(', ')} is a QM scope source, so only the scope credential may read it; nothing changed. `
    + 'A scope\'s memory is read only through the credential that lists it in --attest-sources. Grant another source instead.');
}

function attestInvalid(message: string, suggestion: string): OperationError {
  return opError('invalid_params', message, suggestion, { reason: 'scope_source_reserved',
    why: 'A scope source holds memory every member of that scope reads: only credentials that list it may read it, so it must not already be readable by anyone else.' });
}

/**
 * Checks an attest_sources change for one credential (gbrain auth rescope --attest-sources) and marks each newly listed
 * source, and each listed source that lost its mark (a restore), inside the caller's transaction. The mark is never
 * cleared here. Returns whether anything was checked.
 */
export async function applyAttestSources(db: Db, self: CredentialRef, next: readonly string[] | null, before: readonly string[] | null, opts: { dryRun?: boolean } = {}): Promise<boolean> {
  const sql = sqlOf(db);
  const marked = await markedScopeSources(sql, next ?? []);
  const added = (next ?? []).filter(s => !(before ?? []).includes(s) || !marked.has(s));
  const dropped = (before ?? []).filter(s => !(next ?? []).includes(s));
  if (!added.length && !dropped.length) return false;
  // The caller holds this credential's row FOR UPDATE; the sources it marks are locked before the other grants are read.
  await markedScopeSources(sql, added, 'update');
  const all = await credentialSources(sql);
  const mine = all.find(c => same(c.ref, self));
  const stillRead = dropped.filter(s => mine?.reads.includes(s));
  if (stillRead.length) {
    throw attestInvalid(`This credential still reads ${stillRead.join(', ')}, so it cannot leave --attest-sources; nothing changed.`,
      'Remove it from the read grant first (gbrain auth rescope ... --federated-read <list without it>), then from --attest-sources.');
  }
  if (added.length && mine?.privatePages) {
    throw attestInvalid('This credential holds the private-pages grant, so it cannot list scope sources; nothing changed.', 'Clear it first (gbrain auth rescope ... --private-pages none): a scope credential reads only shared memory.');
  }
  for (const s of added) {
    const [row] = await sql`SELECT archived, config FROM sources WHERE id = ${s}`;
    if (!row || row.archived === true) throw attestInvalid(`--attest-sources names ${s}, which is not an active source.`, 'Add a dedicated source for the scope first (gbrain sources add <id>: with a path on a repo brain, without one on a repo-less brain), then list it.');
    if (s === 'default' || parseSourceConfig(row.config).federated === true) throw attestInvalid(`--attest-sources names ${s}, which every connection without a source grant reads (${s === 'default' ? 'the default source' : 'a federated source'}).`, 'Use a dedicated, unfederated source per scope.');
    if (mine?.write === s) throw attestInvalid(`--attest-sources names ${s}, this credential's own write source (where member pages live).`, 'Keep member pages and each scope in separate sources: list only scope sources.');
    const readers = all.filter(c => !same(c.ref, self) && c.reads.includes(s) && !c.attest.includes(s));
    if (readers.length) {
      throw attestInvalid(`--attest-sources names ${s}, which ${readers.slice(0, 3).map(c => c.label).join(', ')}${readers.length > 3 ? ` and ${readers.length - 3} more` : ''} can already read.`,
        `Remove ${s} from those credentials' read grants first, or use a new source for the scope.`);
    }
  }
  if (opts.dryRun) return true;
  for (const s of added) {
    const [row] = await sql`SELECT config FROM sources WHERE id = ${s}`;
    await sql`UPDATE sources SET config = ${JSON.stringify({ ...normalizeSourceConfig(row!.config), qm_scope: true, federated: false })}::text::jsonb WHERE id = ${s}`;
  }
  return true;
}

/** A remote memory_recall that names no source reads no scope source: a scope is read only by naming it. */
export async function withoutScopeSources(ctx: Pick<OperationContext, 'remote' | 'engine'>, sources: string[]): Promise<string[]> {
  if (ctx.remote === false) return sources;
  const marked = await markedScopeSources(ctx.engine, sources);
  return marked.size ? sources.filter(s => !marked.has(s)) : sources;
}

/** Refuses `gbrain sources federate` on a scope source: federation would let every connection without a source grant read it. */
export async function assertNotScopeSource(db: Db, sourceId: string): Promise<void> {
  if ((await markedScopeSources(db, [sourceId])).size) {
    throw attestInvalid(`Source ${sourceId} is a QM scope source, so it cannot be federated.`, 'Leave it unfederated; the scope credential reads it by grant.');
  }
}
