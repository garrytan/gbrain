/**
 * GST-2670 phase 2 (GBRA-502, decision B1): `gbrain repair visibility --propose [--source <id>] [--out <dir>]`, a
 * preview that proposes readers for open pages (open-pages.ts: no readable_by, no applied or pending rule) on a brain
 * that serves several people. It reads each open page's frontmatter participants, attendees, to, from and cc email
 * lists and matches every address to an enabled member by its declared email (GST-1158), exactly and case-folded,
 * never a search hit. A page whose addresses all match proposes those members plus the owner (first); a page with any
 * address that matches no enabled member is listed under unmatched, never guessed. Pages are grouped by source and
 * reader set, one slugs file per set, each with the existing preview-bound command
 * gbrain repair visibility --source <s> --slugs-file <f> --readers <set> (readers.ts), whose --apply --expect stays the
 * only way a label is written. DM, chat and mail pages with no address list are listed by folder with the
 * gbrain access rule add --prefix command instead.
 *
 * It writes only the slugs files (mode 0600) under <configDir>/visibility-proposals/ or --out, refusing a directory
 * inside a git work tree as member keys do. It never writes a label, a rule, config or a page. A one-person brain, or
 * one pinned to access.serves one, gets "nothing to propose" before any pages query (brainServes, the gate open-pages.ts
 * callers use). Everything it reads is database state, so a repo-less brain gets it unchanged.
 */
import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { configDir } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import { shellQuote } from '../core/agent-output.ts';
import { digest } from '../core/persistence/digest.ts';
import { privacyPartSql } from '../core/search/private-visibility.ts';
import { SENSITIVE_PAGE_TYPES } from '../core/grants/shared-exposure.ts';
import { assertMemberEmail, listMembers } from '../core/access/members.ts';
import { ownerView } from '../core/access/owner.ts';
import { brainServes } from '../core/access/serves.ts';
import { membersReadLineageOn } from '../core/access/lineage.ts';
import { membersReadOpen, openPageSql, withOpenScope } from '../core/access/open-pages.ts';
import { gitRootAbove } from './access-serves.ts';
import { READERS_MAX_PAGES } from '../core/repair/readers.ts';
import { callReadersFor, parseCallAttendees } from '../core/meetings/attendees.ts';
import { boundedBodyPrefixSql } from '../core/page-window/bounded-lead.ts';

export const PROPOSAL_FIELDS = ['participants', 'attendees', 'to', 'from', 'cc'] as const;
export const PROPOSAL_DIR = 'visibility-proposals';

export interface ProposedSet { source: string; readers: string[]; pages: number; file: string; command: string }
export interface UnmatchedPage {
  source: string;
  slug: string;
  /** The listed entries that name no enabled member's declared email. */
  addresses: string[];
  /** Why the page gets no proposal when its addresses are not the reason (a slug a slugs file cannot carry). */
  reason?: string;
}
export interface ProposedFolder { source: string; folder: string; pages: number; command: string }
export interface VisibilityProposal {
  /** False on a one-person brain or one pinned to access.serves one: nothing was read or written. */
  applicable: boolean;
  message: string;
  owner: string | null;
  /** The configured owner when it names no enabled member: every printed command refuses until it is fixed. */
  owner_inactive?: string;
  /** Where the slugs files were written; null when no set was proposed. */
  dir: string | null;
  sets: ProposedSet[];
  unmatched: UnmatchedPage[];
  folders: ProposedFolder[];
  members_read_lineage: boolean;
  cost: string;
}

const LINEAGE_COST = 'Labelling a page also hides its derived atoms, facts and chronicle events from every remote caller except the owner, unless access.members_read_lineage is on (gbrain access members-read-lineage on lets the members a page lists read them too).';
const CALL_PARTIAL = 'an imported call: proposed above with the owner and its matched attendees; these names match no enabled member, so add any who should read it by hand';
const CALL_NO_OWNER = 'an imported call, and no owner is set, so no reader set can name the owner (gbrain access owner set <member>)';
const UNCARRIED_SLUG = 'the slug starts with # or has surrounding spaces or a line break, so a slugs file cannot carry it; label it with --slug';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The address entries a frontmatter value lists: a list or one string (comma or semicolon separated), each "Name <a@b>" read as a@b. */
function entries(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return items.flatMap(item => typeof item === 'string' ? item.split(/[,;]/) : item && typeof item === 'object' && typeof (item as { email?: unknown }).email === 'string'
    ? [(item as { email: string }).email] : [JSON.stringify(item)])
    .map(entry => entry.trim()).filter(Boolean).map(entry => entry.match(/<([^<>]+)>$/)?.[1]?.trim() ?? entry);
}

const canonical = (entry: string): string | null => { try { return assertMemberEmail(entry); } catch { return null; } };

/** Writes one slugs file (0600) through a new exclusive temp file renamed over the name, so a planted file or symlink there is replaced, never followed. */
function writeSlugs(file: string, slugs: string[]): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${slugs.join('\n')}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/** Refuses a proposals directory inside a git work tree, as member keys are refused (access-serves.ts). */
function assertOutsideGit(dir: string): void {
  const root = gitRootAbove(dir);
  if (!root) return;
  throw opError('repair_propose_dir_in_git', `Proposal files go to ${dir}, which is inside the git work tree at ${root}; a file there could be committed, so nothing was written.`,
    'Pass --out <dir> outside any git checkout, or leave --out off to use the gbrain config directory (with GBRAIN_HOME outside any checkout).',
    { why: 'Proposal files list page slugs and who reads them; a commit could publish them.' });
}

/** The proposal; writes only the slugs files. `out`: their directory (default <configDir>/visibility-proposals). */
export async function proposeVisibility(engine: BrainEngine, opts: { source?: string; out?: string } = {}): Promise<VisibilityProposal> {
  const lineage = await membersReadLineageOn(engine);
  const serves = await brainServes(engine);
  if (serves.serves === 'one') {
    const why = serves.from === 'config' ? 'access.serves is one' : plural(serves.enabled_members.length, 'enabled member');
    return { applicable: false, message: `Nothing to propose: this brain serves one person (${why}), so no page needs readers for members.`,
      owner: null, dir: null, sets: [], unmatched: [], folders: [], members_read_lineage: lineage, cost: LINEAGE_COST };
  }
  const dir = resolve(opts.out ?? join(configDir(), PROPOSAL_DIR));
  assertOutsideGit(dir);
  const view = await ownerView(engine);
  const owner = view.owner;
  const allMembers = await listMembers(engine);
  const byEmail = new Map(allMembers.filter(m => m.status === 'enabled' && m.email).map(m => [m.email!, m.id]));
  const rows = await withOpenScope(engine, {}, async (scope, bounded) => {
    const sources = opts.source ? [opts.source] : scope.sources;
    if (!sources.length) return [];
    const found = await bounded(e => e.executeRaw<{ source: string; slug: string; type: string | null; visible: unknown; fields: Record<string, unknown> | null; call_head: string | null }>(
      `SELECT p.source_id AS source, p.slug, p.type, (${privacyPartSql('p')}) AS visible,
              jsonb_strip_nulls(jsonb_build_object(${PROPOSAL_FIELDS.map(f => `'${f}', p.frontmatter->'${f}'`).join(', ')})) AS fields,
              CASE WHEN p.frontmatter ? 'call_import' AND NOT (p.frontmatter ?| $2::text[]) THEN left(${boundedBodyPrefixSql('p')}, 8192) END AS call_head
         FROM pages p
        WHERE ${openPageSql('p')} AND p.source_id = ANY($1::text[])
          AND (p.frontmatter ?| $2::text[] OR p.type = ANY($3::text[]) OR p.frontmatter ? 'call_import')
        ORDER BY p.source_id, p.slug`, [sources, [...PROPOSAL_FIELDS], [...SENSITIVE_PAGE_TYPES]]));
    return found.filter(row => membersReadOpen(scope, row.source, row.visible));
  });
  const groups = new Map<string, { source: string; readers: string[]; slugs: string[] }>();
  const unmatched: UnmatchedPage[] = [];
  const folders = new Map<string, ProposedFolder>();
  let considered = 0;
  const ownerFirst = owner ? `${owner},` : '';
  for (const row of rows) {
    if (row.call_head !== null && row.call_head !== undefined) {
      considered++;
      if (row.slug.trim() !== row.slug || row.slug.startsWith('#') || /[\r\n]/.test(row.slug)) { unmatched.push({ source: row.source, slug: row.slug, addresses: [], reason: UNCARRIED_SLUG }); continue; }
      const call = callReadersFor(parseCallAttendees(row.call_head), owner ?? '', allMembers);
      if (!owner) { unmatched.push({ source: row.source, slug: row.slug, addresses: call.unmatched, reason: CALL_NO_OWNER }); continue; }
      const readers = [owner, ...call.readers.slice(1).sort()];
      const key = JSON.stringify([row.source, readers]);
      const g = groups.get(key) ?? { source: row.source, readers, slugs: [] };
      groups.set(key, g);
      g.slugs.push(row.slug);
      if (call.unmatched.length) unmatched.push({ source: row.source, slug: row.slug, addresses: call.unmatched, reason: CALL_PARTIAL });
      continue;
    }
    const listed = PROPOSAL_FIELDS.flatMap(f => entries(row.fields?.[f]));
    if (!listed.length) {
      if (!row.type || !SENSITIVE_PAGE_TYPES.includes(row.type)) continue;
      const cut = row.slug.lastIndexOf('/');
      const folder = cut > 0 ? row.slug.slice(0, cut + 1) : '(root)';
      const key = JSON.stringify([row.source, folder]);
      const f = folders.get(key) ?? { source: row.source, folder, pages: 0, command: folder === '(root)'
        ? shellQuote(['gbrain', 'repair', 'visibility', '--source', row.source, '--slug', '<slug>', '--readers', `${ownerFirst}<list>`])
        : shellQuote(['gbrain', 'access', 'rule', 'add', '--prefix', folder, '--readers', `${ownerFirst}<list>`, '--source', row.source]) };
      folders.set(key, f);
      f.pages++;
      continue;
    }
    considered++;
    if (row.slug.trim() !== row.slug || row.slug.startsWith('#') || /[\r\n]/.test(row.slug)) {
      unmatched.push({ source: row.source, slug: row.slug, addresses: [], reason: UNCARRIED_SLUG });
      continue;
    }
    const members = new Set<string>();
    const missing: string[] = [];
    for (const entry of listed) {
      const email = canonical(entry);
      const id = email ? byEmail.get(email) : undefined;
      if (id) members.add(id);
      else if (!missing.includes(entry)) missing.push(entry);
    }
    if (missing.length) { unmatched.push({ source: row.source, slug: row.slug, addresses: missing }); continue; }
    if (owner) members.delete(owner);
    const readers = [...(owner ? [owner] : []), ...[...members].sort()];
    const key = JSON.stringify([row.source, readers]);
    const g = groups.get(key) ?? { source: row.source, readers, slugs: [] };
    groups.set(key, g);
    g.slugs.push(row.slug);
  }
  const sets: ProposedSet[] = [];
  if (groups.size) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const g of [...groups.values()].sort((a, b) => a.source.localeCompare(b.source) || b.slugs.length - a.slugs.length || a.readers.join(',').localeCompare(b.readers.join(',')))) {
    const parts = Math.ceil(g.slugs.length / READERS_MAX_PAGES);
    for (let i = 0; i < parts; i++) {
      const slugs = g.slugs.slice(i * READERS_MAX_PAGES, (i + 1) * READERS_MAX_PAGES);
      const file = join(dir, `${g.source}-${digest([g.source, g.readers]).slice(0, 12)}${parts > 1 ? `-${i + 1}` : ''}.txt`);
      writeSlugs(file, slugs);
      sets.push({ source: g.source, readers: g.readers, pages: slugs.length, file,
        command: shellQuote(['gbrain', 'repair', 'visibility', '--source', g.source, '--slugs-file', file, '--readers', g.readers.join(',')]) });
    }
  }
  const sorted = [...folders.values()].sort((a, b) => a.source.localeCompare(b.source) || b.pages - a.pages || a.folder.localeCompare(b.folder));
  const proposed = sets.reduce((n, s) => n + s.pages, 0);
  const chats = sorted.reduce((n, f) => n + f.pages, 0);
  return { applicable: true, owner, ...(view.inactive ? { owner_inactive: view.inactive.value } : {}), dir: sets.length ? dir : null, sets, unmatched, folders: sorted,
    members_read_lineage: lineage, cost: LINEAGE_COST,
    message: `${proposed} of ${plural(considered, 'open page')} with an address list in ${plural(sets.length, 'reader set')}, ${unmatched.length} unmatched; ${plural(chats, 'DM, chat or mail page')} with no address list.` };
}

/** The human preview: the sets and their commands, the unmatched pages, the folders and what labelling costs. */
export function proposalLines(p: VisibilityProposal, limit = 20): string[] {
  if (!p.applicable) return [p.message];
  const lines = [`Proposed readers (preview only; nothing was labelled): ${p.message}`];
  if (p.owner_inactive) lines.push(`  WARNING: access.owner_member is "${p.owner_inactive}", which names no enabled member, so each command below refuses until the owner is fixed (gbrain access owner set <member>).`);
  else if (!p.owner) lines.push('  No owner is set (gbrain access owner set <member>), so each reader set names only the matched members.');
  if (p.sets.length) lines.push('', `Reader sets (slugs files in ${p.dir}). Preview each, then run the --apply --expect <hash> it prints:`);
  for (const s of p.sets) lines.push(`  ${s.source}: ${plural(s.pages, 'page')} -> ${s.readers.join(', ')}`, `    ${s.command}`);
  const partial = p.unmatched.filter(u => u.reason === CALL_PARTIAL);
  const unproposed = p.unmatched.filter(u => u.reason !== CALL_PARTIAL);
  if (partial.length) {
    lines.push('', `Proposed with names left out (${partial.length}): these calls are in a reader set above, and these names match no enabled member. Declare the right member's email (gbrain access member set <id> --email <address>) and preview again, or add who should read the call by hand:`);
    for (const u of partial.slice(0, limit)) lines.push(`  ${u.source}:${JSON.stringify(u.slug)} (${u.addresses.join(', ')})`);
    if (partial.length > limit) lines.push(`  ... and ${partial.length - limit} more (--json lists every one)`);
  }
  if (unproposed.length) {
    lines.push('', `Unmatched (${unproposed.length}): nothing is proposed for these. Where an address names no enabled member's declared email, declare it on the right member (gbrain access member set <id> --email <address>) and preview again; otherwise label these by hand:`);
    for (const u of unproposed.slice(0, limit)) lines.push(u.reason ? `  ${u.source}:${JSON.stringify(u.slug)} (${u.reason}${u.addresses.length ? `: ${u.addresses.join(', ')}` : ''})` : `  ${u.source}:${u.slug} (${u.addresses.join(', ')})`);
    if (unproposed.length > limit) lines.push(`  ... and ${unproposed.length - limit} more (--json lists every one)`);
  }
  if (p.folders.length) {
    lines.push('', 'DM, chat and mail pages with no address list, by folder. Name who reads each folder (each command previews; --yes applies):');
    for (const f of p.folders) lines.push(`  ${f.source}:${f.folder} ${plural(f.pages, 'page')}`, `    ${f.command}`);
  }
  lines.push('', `Cost: ${p.cost} It is ${p.members_read_lineage ? 'on' : 'off'} on this brain.`);
  return lines;
}
