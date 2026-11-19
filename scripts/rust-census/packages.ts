/**
 * Turns census rows into work packages of about one day each, ranked by user impact.
 *
 * A failing row is filed under the refusal it ended on (else the first refusal the run built, else its command):
 *  - raw SQL (`executeRaw`, `executeRawDirect`, `withReservedConnection`, `keywordBoundedRead`): one package per caller
 *    file. The work is a typed store member for the statement and a caller that uses it.
 *  - a served member that refuses an option (`getTags (option excludePrivate)`): one package per option and store
 *    file, because the option is decoded in that member's store-members file.
 *  - a member Rust does not serve: one package per capability.
 *  - no refusal (a wrong answer, a crash): one package per command.
 * A package larger than about one day (more than MAX_UNITS distinct member and call-site pairs) is split.
 *
 * Ownership: rules below mark packages that an in-flight lane already owns, so a new lane does not start them.
 * Conflicts: two packages conflict when they change the same file, excluding the append-only registries every
 * package touches (engine.ts, members.ts, store-members/index.ts, the Rust store crate's lib.rs and the addon codec).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CensusRow {
  surface: 'cli' | 'mcp';
  name: string;
  invocation: string;
  status: 'equal' | 'differs' | 'refused' | 'crash' | 'skipped';
  decisive?: string;
  endSite?: string;
  first?: { capability: string; member: string; site: string };
  sites?: string[];
  raw?: Array<{ member: string; sql: string; site: string }>;
  note: string;
}

export interface WorkPackage {
  id: string;
  title: string;
  kind: 'raw_sql' | 'option' | 'capability' | 'behaviour';
  score: number;
  hot: string[];          // hot commands and tools it blocks
  cases: string[];        // surface:name, distinct
  units: string[];        // distinct member @ site pairs
  files: string[];        // files the package changes (registries excluded)
  owner?: string;         // in-flight lane that owns it
  conflicts: string[];    // ids of packages that share a file
}

const RAW = new Set(['executeRaw', 'executeRawDirect', 'withReservedConnection', 'keywordBoundedRead', 'runMigration']);
const MAX_UNITS = 6;

/** Put, import, sync, search, query, get and links first, then the MCP hot tools (weight 10; everything else 1). */
const HOT_CLI = new Set(['put', 'import', 'sync', 'search', 'search-exact', 'query', 'get', 'links', 'backlinks', 'link', 'unlink', 'link-add', 'link-rm', 'get_links', 'list', 'find', 'graph', 'delete', 'restore', 'tag', 'untag', 'timeline']);
const HOT_MCP = new Set(['put_page', 'get_page', 'search', 'query', 'search_exact', 'get_links', 'get_backlinks', 'add_link', 'remove_link', 'list_pages', 'find_pages', 'traverse_graph', 'sync_brain', 'resolve_slugs', 'get_tags', 'add_tag', 'remove_tag', 'get_timeline', 'delete_page', 'restore_page', 'remember', 'recall', 'entity', 'context_pack', 'delta', 'forget', 'synthesize']);
const weight = (r: CensusRow) => ((r.surface === 'cli' ? HOT_CLI : HOT_MCP).has(r.name) ? 10 : 1);

/** In-flight lanes (Ember, Nov 18). Order matters: the first match wins. */
const OWNERS: Array<{ lane: string; test: (member: string, site: string, sql: string) => boolean }> = [
  { lane: 'lane 7 (put write path, a22a4d34)', test: (m, s) => /claimNextWrite|queuePublicationEffects|completeWrite|poolCapacity|pool capacity/.test(m) || /^src\/core\/persistence\/(consumer-heartbeat|effect-journal|journal|service|page-state)/.test(s) },
  { lane: 'interfaces a9fd5b22 (recovery scan, probeQuery, deferred writes, worktree refresh, admit-write 4-7)', test: (m, s) => /recoveryScan|recovery_scan|probeQuery|expireDeferredWrites|resumeWorktreeRefreshes/.test(m) || /recovery-scan|admit-write|deferred-write|worktree-refresh/.test(s) },
  { lane: 'lane 6 (vector search)', test: (m) => /searchVector/.test(m) },
  { lane: 'lane 3 (valid-time reads)', test: (m, _s, sql) => /getPageAsOf|asOf|validAt|valid_time/.test(m) || /valid_from|valid_to/.test(sql) },
  { lane: 'lane 4 (COLLATE reads)', test: (m, _s, sql) => /collat/i.test(m) || /COLLATE/i.test(sql) },
  { lane: 'lane 5 (spend tables)', test: (m, s, sql) => /spend/i.test(m) || /spend|budget-ledger/.test(s) || /\bspend_|_spend\b|budget_ledger/i.test(sql) },
  { lane: 'lane 1 (facts maintenance)', test: (m, s) => /^src\/core\/(facts|cycle)\//.test(s) && !/meta-hook/.test(s) || /^(consolidate|purgeFacts|repairFacts|factsCycle)/.test(m) },
];

const fileOf = (site: string) => site.replace(/:\d+(:\d+)?$/, '');

/** The store-members file that exports each served member, read from the source. */
function storeMemberFiles(root: string): Map<string, string> {
  const dir = join(root, 'src', 'core', 'rust-engine', 'store-members');
  const out = new Map<string, string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/export (?:const|async function|function) (\w+)/g)) if (!out.has(m[1]!)) out.set(m[1]!, `src/core/rust-engine/store-members/${f}`);
  }
  return out;
}

/** member -> capability from members.ts. */
function memberCapabilities(root: string): Map<string, string> {
  const text = readFileSync(join(root, 'src', 'core', 'rust-engine', 'members.ts'), 'utf8');
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^\s+(\w+): '(\w+)',/gm)) out.set(m[1]!, m[2]!);
  return out;
}

export function buildPackages(rows: CensusRow[], root: string): WorkPackage[] {
  const served = storeMemberFiles(root);
  const caps = memberCapabilities(root);
  const capFile = new Map<string, string>();
  for (const [member, cap] of caps) { const f = served.get(member); if (f && !capFile.has(cap)) capFile.set(cap, f); }

  interface Bucket { key: string; title: string; kind: WorkPackage['kind']; files: Set<string>; units: Map<string, CensusRow[]>; owner?: string }
  const buckets = new Map<string, Bucket>();
  const add = (key: string, init: () => Omit<Bucket, 'units'>, row: CensusRow, unit: string) => {
    let b = buckets.get(key);
    if (!b) { b = { ...init(), units: new Map() }; buckets.set(key, b); }
    const rs = b.units.get(unit) ?? [];
    if (!rs.includes(row)) rs.push(row);
    b.units.set(unit, rs);
  };

  // A refusal that also happens in a case whose output equals the reference is caught and harmless there (the
  // fact-cache watermark in every MCP call, for one): it cannot explain a different answer, so skip it below.
  const ambient = new Set<string>();
  for (const r of rows) if (r.status === 'equal') for (const s of r.sites ?? []) ambient.add(`${r.surface}:${s}`);
  const suspect = (r: CensusRow): { member: string; site: string } | undefined => {
    const hit = (r.sites ?? []).find((s) => !ambient.has(`${r.surface}:${s}`));
    if (hit) { const at = hit.lastIndexOf('@'); return { member: hit.slice(0, at), site: hit.slice(at + 1) }; }
    if (r.sites) return undefined;
    return r.first;
  };

  for (const r of rows) {
    if (r.status === 'equal' || r.status === 'skipped') continue;
    // The refusal the output names wins; else (a wrapped refusal, or a different answer) the first refusal that is
    // not ambient, which a fail-soft path caught on the way to the different answer.
    const named = r.decisive && r.decisive !== 'unknown' ? { member: r.decisive, site: r.endSite ?? '' } : undefined;
    const pick = named ?? suspect(r);
    const member = pick?.member;
    const site = pick?.site || r.first?.site || '';
    const sql = (r.raw ?? []).find((x) => x.site === site)?.sql ?? (r.raw ?? [])[0]?.sql ?? '';
    if (!member || member === 'unknown') {
      add(`behaviour:${r.surface}:${r.name}`, () => ({ key: '', title: `${r.surface === 'cli' ? 'gbrain ' : 'MCP '}${r.name}: ${r.status} with no capability refusal (${r.note.slice(0, 90)})`, kind: 'behaviour', files: new Set() }), r, `${r.surface}:${r.name}`);
      continue;
    }
    const base = member.replace(/ \(option .*\)$/, '');
    const option = /\(option (.+)\)$/.exec(member)?.[1];
    const owner = OWNERS.find((o) => o.test(member, site, sql))?.lane;
    if (RAW.has(base)) {
      const f = fileOf(site) || 'unknown caller';
      add(`raw:${f}`, () => ({ key: '', title: `Typed store member(s) for the raw SQL in ${f}`, kind: 'raw_sql', files: new Set([f]), owner }), r, `${base} @ ${site}`);
    } else if (option) {
      const f = served.get(base) ?? capFile.get(caps.get(base) ?? '') ?? 'src/core/rust-engine/store-members/(new)';
      const opt = option.replace(/ for a caller.*$/, '').replace(/^remote\./, '');
      add(`option:${opt}:${f}`, () => ({ key: '', title: `Serve the ${opt} option on the members in ${f.split('/').pop()}`, kind: 'option', files: new Set([f]), owner }), r, `${member}${site ? ` @ ${site}` : ''}`);
    } else {
      const cap = caps.get(base) ?? r.first?.capability ?? 'unknown';
      const f = capFile.get(cap) ?? `src/core/rust-engine/store-members/${cap.replace(/_/g, '-')}.ts`;
      add(`cap:${cap}`, () => ({ key: '', title: `Serve the ${cap} members Rust does not serve yet`, kind: 'capability', files: new Set([f]), owner }), r, `${base}${site ? ` @ ${site}` : ''}`);
    }
    // a raw-SQL statement that names a table often shows the store file too; keep the caller file as the anchor
  }

  // split oversized buckets into ~1-day parts
  const pkgs: WorkPackage[] = [];
  for (const b of buckets.values()) {
    const units = [...b.units.keys()].sort();
    const parts = Math.max(1, Math.ceil(units.length / MAX_UNITS));
    for (let p = 0; p < parts; p++) {
      const u = units.slice(p * MAX_UNITS, (p + 1) * MAX_UNITS);
      const rs = [...new Set(u.flatMap((x) => b.units.get(x)!))];
      // Serving a member or an option changes the store file (and its Rust module), not the caller.
      const files = new Set(b.files);
      const cases = [...new Set(rs.map((r) => `${r.surface}:${r.name}`))];
      const hot = [...new Set(rs.filter((r) => weight(r) > 1).map((r) => `${r.surface}:${r.name}`))];
      pkgs.push({ id: '', title: parts > 1 ? `${b.title} (part ${p + 1} of ${parts})` : b.title, kind: b.kind,
        score: [...new Map(rs.map((r) => [`${r.surface}:${r.name}`, weight(r)])).values()].reduce((a, c) => a + c, 0),
        hot, cases, units: u, files: [...files].sort(), owner: b.owner ?? ownerOfUnits(u), conflicts: [] });
    }
  }
  pkgs.sort((a, b) => Number(!!a.owner) - Number(!!b.owner) || b.score - a.score || b.cases.length - a.cases.length || a.title.localeCompare(b.title));
  pkgs.forEach((p, i) => { p.id = `P${String(i + 1).padStart(2, '0')}`; });
  for (const a of pkgs) for (const b of pkgs) if (a !== b && a.files.some((f) => b.files.includes(f))) a.conflicts.push(b.id);
  return pkgs;
}

function ownerOfUnits(units: string[]): string | undefined {
  for (const u of units) {
    const [member, site = ''] = u.split(' @ ');
    const o = OWNERS.find((x) => x.test(member!, site, ''));
    if (o) return o.lane;
  }
  return undefined;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderPackages(pkgs: WorkPackage[]): string {
  const lines = ['## Work packages (about one day each, ranked by user impact)', '',
    'Score: 10 for each hot command or tool it blocks (put, import, sync, search, query, get, links and the MCP hot tools), 1 for any other. Owned packages are listed last: do not start them. "Conflicts" names packages that change the same file; do not run those in parallel lanes.', '',
    '| id | package | score | hot cases blocked | cases | owner | files | conflicts |', '|---|---|---|---|---|---|---|---|'];
  for (const p of pkgs) {
    lines.push(`| ${p.id} | ${esc(p.title)}<br>units: ${esc(p.units.join('; '))} | ${p.score} | ${esc(p.hot.join(', '))} | ${p.cases.length} | ${esc(p.owner ?? '')} | ${esc(p.files.join(', '))} | ${p.conflicts.join(', ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
