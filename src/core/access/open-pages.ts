/**
 * GST-2670 (GBRA-502): the pages every member's key can read on a brain that serves several people. A page is open
 * when no readable_by names readers and no applied or pending folder or page rule covers it: a key bound to a member
 * reads it like an unbound one (requester-scope.ts gates who may ask; only labels decide what a member reads). The
 * count is the read path's own floor (accessAllowedSql with an empty identity, built outside any caller record, so it
 * never depends on who asks), split into the pages members read and the visibility: private pages they do not
 * (unless this process sees remote privacy relaxed, or a reading member's grant opens that source's private pages). "Members" are the enabled members other than the owner;
 * a labelled-only member reads no open page, and each other member reads the sources its bound tokens and OAuth
 * clients read. Read-only and best effort everywhere it is shown: access serves several (preview and receipt),
 * gbrain access serves, doctor open_shared_pages and post-upgrade. Callers gate on brainServes first, so a
 * one-person brain, or one pinned to access.serves one, never runs it. Everything is database state, so a repo-less
 * brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { accessAllowedSql, privacyPartSql, readHonorAliases, remotePrivacyRelaxed, withoutCallerAccess } from '../search/private-visibility.ts';
import { credentialReadSources, SENSITIVE_PAGE_TYPES, stdioReadSources } from '../grants/shared-exposure.ts';
import { grantFromClient, grantFromRow, grantFromTokenRow, privatePagesSources, type PrincipalGrant } from '../grants/model.ts';
import { stdioMemberId } from './caller.ts';
import { localFederatedSourceIds } from '../source-resolver.ts';
import { isStatementTimeout } from '../persistence/bounded-reads.ts';
import { agentBlock } from '../agent-markers.ts';
import { ownerMemberId } from './owner.ts';
import { brainServes } from './serves.ts';

export const OPEN_PAGES_TOP = 10;
export const OPEN_PAGES_TIMEOUT_MS = 30_000;
const RETRY = 'gbrain doctor --only open_shared_pages --json';

export interface OpenFolder { source: string; folder: string; pages: number; sensitive: number }
export interface OpenPages {
  /** The brain owner (access.owner_member), whom every printed reader list starts with; null when none is set. */
  owner: string | null;
  /** reading: members other than the owner, not labelled-only, whose keys (or config mcp.stdio_member binding) read a source; counted: members other than the owner. */
  members: { reading: number; counted: number };
  /** The sources counted: those the reading members read, or every source when no member reads one. */
  sources: string[];
  total: number;
  /** Open pages of a DM, chat, conversation or mail type (SENSITIVE_PAGE_TYPES). */
  sensitive: number;
  /** Open pages that visibility: private (or a privacy alias) keeps from members; counted in total instead where remote privacy is relaxed or a reading member's grant opens private pages. */
  private: number;
  folders: OpenFolder[];
  other: { folders: number; pages: number; sensitive: number };
  top_sensitive: { source: string; type: string; pages: number } | null;
}
export interface OpenPagesError { code: string; message: string; retry: string }
export interface OpenPagesRead { open_pages: OpenPages | null; open_pages_error?: OpenPagesError }

export interface OpenPagesOptions {
  /** Members a run is about to add or keep, the source their new keys write (access serves several), and whether it marks them labelled-only. */
  planned?: { members: readonly string[]; source: string; labelledOnly: boolean };
  /** Prefixes a rule the run adds will cover, left out of the count. */
  exclude?: ReadonlyArray<{ source: string; prefix: string }>;
}

/** The sources a key minted for `source` reads: that source, or for default the default source and every federated one. */
async function mintedReadSources(engine: BrainEngine, source: string): Promise<string[]> {
  if (source !== 'default') return [source];
  return await localFederatedSourceIds(engine, 'default', 'seed_default').catch(() => undefined) ?? ['default'];
}

/**
 * Each counted member (enabled, not the owner) with the sources its keys and a config mcp.stdio_member binding read
 * (empty for a labelled-only member), and the sources whose private pages some reading member's grant opens. A harness
 * entry's serve --stdio-member is not in the database, so it is not seen here.
 */
async function memberReads(engine: BrainEngine, owner: string | null, planned: OpenPagesOptions['planned']): Promise<{ reads: Map<string, Set<string>>; privateSources: Set<string> }> {
  const reads = new Map<string, Set<string>>();
  const privateOf = new Map<string, Set<string>>();
  const labelledOnly = new Set<string>();
  for (const m of await engine.executeRaw<{ id: string; labelled_only: unknown }>(
    'SELECT id, labelled_only FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id')) {
    if (m.id === owner) continue;
    reads.set(m.id, new Set());
    if (m.labelled_only === true) labelledOnly.add(m.id);
  }
  const memo = new Map<string, Promise<string[]>>();
  const sourcesOf = (grant: PrincipalGrant) => {
    const key = JSON.stringify([grant.principal.kind, grant.scopes, grant.sources]);
    if (!memo.has(key)) memo.set(key, credentialReadSources(engine, grant));
    return memo.get(key)!;
  };
  const credentials: Array<{ member: string; grant: PrincipalGrant }> = [
    ...(await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL'))
      .map(row => ({ member: String(row.member_id), grant: grantFromTokenRow(row as never) })),
    ...(await engine.executeRaw<Record<string, unknown>>('SELECT * FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NOT NULL'))
      .map(row => ({ member: String(row.member_id), grant: grantFromClient(grantFromRow(row)) })),
  ];
  for (const { member, grant } of credentials) {
    const set = reads.get(member);
    if (!set) continue;
    for (const s of await sourcesOf(grant)) set.add(s);
    const priv = privateOf.get(member) ?? new Set<string>();
    privateOf.set(member, priv);
    for (const s of privatePagesSources(grant)) priv.add(s);
  }
  const stdio = await stdioMemberId(engine);
  const stdioSet = stdio ? reads.get(stdio) : undefined;
  if (stdioSet) for (const s of await stdioReadSources(engine)) stdioSet.add(s);
  if (planned) {
    const minted = await mintedReadSources(engine, planned.source);
    for (const id of planned.members) {
      if (id === owner) continue;
      const set = reads.get(id) ?? new Set<string>();
      reads.set(id, set);
      for (const s of minted) set.add(s);
      if (planned.labelledOnly) labelledOnly.add(id);
    }
  }
  for (const id of labelledOnly) reads.get(id)?.clear();
  const privateSources = new Set<string>();
  for (const [id, set] of reads) if (set.size) for (const s of privateOf.get(id) ?? []) privateSources.add(s);
  return { reads, privateSources };
}

async function bounded<T>(engine: BrainEngine, fn: (e: BrainEngine) => Promise<T>): Promise<T> {
  if (engine.kind !== 'postgres') return fn(engine);
  return engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL statement_timeout = ${OPEN_PAGES_TIMEOUT_MS}`);
    return fn(tx);
  }, { readOnly: true });
}

/** The open pages the counted members' keys read (OpenPages); throws when the access state cannot be read. */
export async function openPages(engine: BrainEngine, opts: OpenPagesOptions = {}): Promise<OpenPages> {
  return withoutCallerAccess(async () => {
    const [state] = await engine.executeRaw<{ unreadable: unknown }>('SELECT gbrain_access_state_unreadable() AS unreadable');
    if (state?.unreadable === true) {
      throw Object.assign(new Error('the folder-rule state cannot be read, so every page reads as covered and a count would say 0'), { code: 'open_pages_unknown' });
    }
    const owner = await ownerMemberId(engine);
    const { reads, privateSources } = await memberReads(engine, owner, opts.planned);
    const reading = [...reads.values()].filter(s => s.size > 0);
    const read = [...new Set(reading.flatMap(s => [...s]))].sort();
    const sources = read.length ? read : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')).map(s => s.id);
    const result: OpenPages = { owner, members: { reading: reading.length, counted: reads.size }, sources, total: 0, sensitive: 0, private: 0,
      folders: [], other: { folders: 0, pages: 0, sensitive: 0 }, top_sensitive: null };
    if (!sources.length) return result;
    await readHonorAliases(engine);
    const relaxed = await remotePrivacyRelaxed(engine);
    const params: unknown[] = [sources];
    const exclude = (opts.exclude ?? []).map(x => {
      params.push(x.source, x.prefix);
      return ` AND NOT (p.source_id = $${params.length - 1} AND starts_with(p.slug, $${params.length}))`;
    }).join('');
    const rows = await bounded(engine, e => e.executeRaw<{ source: string; folder: string; type: string | null; visible: unknown; pages: number | string }>(
      `SELECT p.source_id AS source, CASE WHEN strpos(p.slug, '/') > 0 THEN split_part(p.slug, '/', 1) ELSE '(root)' END AS folder,
              p.type AS type, (${privacyPartSql('p')}) AS visible, count(*)::int AS pages
         FROM pages p
        WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND ${accessAllowedSql('p', [], [])}${exclude}
        GROUP BY 1, 2, 3, 4`, params));
    const folders = new Map<string, OpenFolder>();
    const byType = new Map<string, { source: string; type: string; pages: number }>();
    for (const row of rows) {
      const n = Number(row.pages);
      if (row.visible !== true && !relaxed && !privateSources.has(row.source)) { result.private += n; continue; }
      const key = `${row.source}/${row.folder}`;
      const f = folders.get(key) ?? { source: row.source, folder: row.folder, pages: 0, sensitive: 0 };
      folders.set(key, f);
      f.pages += n;
      result.total += n;
      if (!row.type || !SENSITIVE_PAGE_TYPES.includes(row.type)) continue;
      f.sensitive += n;
      result.sensitive += n;
      const t = byType.get(`${row.source}/${row.type}`) ?? { source: row.source, type: row.type, pages: 0 };
      byType.set(`${row.source}/${row.type}`, t);
      t.pages += n;
    }
    const sorted = [...folders.values()].sort((a, b) => b.pages - a.pages || a.source.localeCompare(b.source) || a.folder.localeCompare(b.folder));
    result.folders = sorted.slice(0, OPEN_PAGES_TOP);
    for (const f of sorted.slice(OPEN_PAGES_TOP)) { result.other.folders++; result.other.pages += f.pages; result.other.sensitive += f.sensitive; }
    result.top_sensitive = [...byType.values()].sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type))[0] ?? null;
    return result;
  });
}

/** openPages that never throws: the count, or null with what went wrong and the command that retries it. */
export async function readOpenPages(engine: BrainEngine, opts: OpenPagesOptions = {}): Promise<OpenPagesRead> {
  try {
    return { open_pages: await openPages(engine, opts) };
  } catch (e) {
    const code = (e as { code?: string }).code === 'open_pages_unknown' ? 'open_pages_unknown' : isStatementTimeout(e) ? 'open_pages_timeout' : 'open_pages_failed';
    return { open_pages: null, open_pages_error: { code, message: e instanceof Error ? e.message : String(e), retry: RETRY } };
  }
}

const folderName = (f: OpenFolder) => f.folder === '(root)' ? `${f.source}:(root)` : `${f.source}:${f.folder}/`;

/** The headline: whose keys read how many open pages. */
export function openPagesHeadline(o: OpenPages): string {
  if (!o.total) return "Every page the members' keys read names its readers (readable_by or a rule).";
  const pages = `${o.total} ${o.total === 1 ? 'page' : 'pages'}, and the facts drawn from them, that no rule or readable_by restricts`;
  const sensitive = o.sensitive ? `, ${o.sensitive} of them DMs, chat or mail` : '';
  return o.members.reading
    ? `The keys of ${o.members.reading} of ${o.members.counted} members can read ${pages}${sensitive}.`
    : `No member's key reads the ${pages}${sensitive}: every member other than the owner is labelled-only or has no key.`;
}

/**
 * The lines that show the open pages and the commands that label them, the owner first in every reader list.
 * labelledOnly: the command that keeps members to labelled pages where the lines are shown.
 */
export function openPagesLines(read: OpenPagesRead, opts: { prefix?: string; labelledOnly?: string } = {}): string[] {
  const head = opts.prefix ?? '  open pages ';
  const pad = ' '.repeat(head.length);
  const o = read.open_pages;
  if (!o) return [`${head}count unknown (${read.open_pages_error?.message ?? 'not read'}); retry with ${read.open_pages_error?.retry ?? RETRY}`];
  if (!o.total) return [head + openPagesHeadline(o)];
  const readers = `${o.owner ? `${o.owner},` : ''}<list>`;
  const shared = o.folders.find(f => !f.sensitive && f.folder !== '(root)' && f.folder !== 'people');
  const where = [...o.folders.map(f => `${folderName(f)} ${f.pages}${f.sensitive ? ` (${f.sensitive} of them DMs, chat or mail)` : ''}`),
    ...(o.other.folders ? [`${o.other.folders} more ${o.other.folders === 1 ? 'folder' : 'folders'} ${o.other.pages}`] : [])].join(', ');
  return [
    head + openPagesHeadline(o),
    `${pad}${where}.`,
    ...(o.top_sensitive ? [`${pad}DMs, chat and mail: keep members to pages labelled for them (${opts.labelledOnly ?? 'gbrain access member labelled-only <member> on'}), then name each page set's readers: gbrain repair visibility --source ${o.top_sensitive.source} --slugs-file <file> --readers ${readers} (preview, then --apply --expect <hash>).`] : []),
    ...(shared ? [`${pad}A folder its readers share: gbrain access rule add --prefix ${shared.folder}/ --readers ${readers} --source ${shared.source} (preview, then --yes).`] : []),
    `${pad}New pages: put readable_by: [${o.owner ? `${o.owner}, ` : ''}<list>] in their frontmatter.`,
  ];
}

/** gbrain post-upgrade: the open DM, chat and mail pages on a brain that serves several people. Best effort; prints nothing otherwise. */
export async function printOpenPagesUpgradeNotice(engine: BrainEngine): Promise<void> {
  try {
    if ((await brainServes(engine)).serves !== 'several') return;
    const read = await readOpenPages(engine);
    if (!read.open_pages?.sensitive || !read.open_pages.members.reading) return;
    console.log('');
    console.log(agentBlock({
      why: `This brain serves several people. ${openPagesHeadline(read.open_pages)} A key bound to a member reads a page with no readers like any other key.`,
      actor: 'user',
      next: 'Relay the list below to the user and ask who should read each folder. Nothing was changed; each command previews first.',
      verify: RETRY,
    }).trimEnd());
    for (const line of openPagesLines(read, { prefix: '  ' })) console.log(line);
  } catch { /* cosmetic; never blocks the upgrade */ }
}
