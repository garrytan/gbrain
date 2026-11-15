/**
 * GBRA-529 (GST-2731): `gbrain setup <harness> --shape personal|company|both [--notes <dir>] [--docs <dir>] [--team]`.
 *
 * The branching install. After setup has wired the harness, it gives the brain a shape:
 *
 *   - starter pages, written create-only through `gbrain put` (the one writer door: on a source with a working
 *     tree the file is written and queued for commit before the database sees it; on a repo-less brain the
 *     database is the record). Each is an empty form marked `status: stub`; nothing about the person or the
 *     company is invented. Personal pages go to the run's source, company pages to the `company` source;
 *   - the `company` source itself, a gbrain-owned folder beside the default source's content root (never the
 *     person's docs folder), added with no federation choice so `sources add` puts it in default search only
 *     when the brain serves one person; otherwise its `source_not_in_default_search` notice asks the user;
 *   - a one-shot import of the notes folder (personal) and the docs folder (company), read only, never written.
 *     Over IMPORT_INLINE_MAX markdown files setup hands the agent the import command instead;
 *   - with --transcripts, a one-shot import of exported call transcripts (.txt, .md) as company/calls/<date>-<title>
 *     pages in the company source (gbrain import --calls: credentials redacted, keyword-only, each file once), and a
 *     line naming who can read them, read from gbrain access who-can-read; the pages carry no readers of their own;
 *   - me/facts and company/facts carry type: facts, and the block tells the agent to quote only their dated lines;
 *   - one line saying what the conversation archive is doing on this brain (on, off or offered), read from doctor;
 *   - a managed layout block beside the brain-first block, telling the agent which pages to read and to quote
 *     facts and numbers only from the facts pages. `--shape none` removes the block and keeps the pages;
 *   - a keyless check that default search finds an imported file, and one question to ask in a new session.
 *
 * `--team` with a company shape creates nothing for the company part: it prints where a shared company brain
 * lives (hosted or self-hosted) and runs nothing. Setup stays engine-free: every brain read and write is a child
 * of the absolute launcher. Nothing here reads stdin unless isInteractive() is true (two TTYs, no agent marker,
 * not CI); an agent-driven run gets the `brain_shape` decision in the first-run bundle instead, and no starter
 * page is written until it is answered.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Decision, Notice } from '../core/agent-output.ts';
import { gbrainPath } from '../core/config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../core/managed-block.ts';
import { writeUnlessChanged } from '../core/setup/brain-first.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { readLine } from '../core/interaction.ts';

export type BrainShape = 'personal' | 'company' | 'both' | 'none';

export interface LayoutFlags {
  brain?: BrainShape;
  /** An absolute notes folder; null for an explicit `--notes none`. */
  notes?: string | null;
  /** An absolute company docs folder; null for an explicit `--docs none`. */
  docs?: string | null;
  /** An absolute folder of exported call transcripts; null for an explicit `--transcripts none`. */
  transcripts?: string | null;
  /** --team: the company part belongs on a shared brain, so setup prints the route and creates nothing for it. */
  team?: boolean;
  dryRun: boolean;
}

export const IMPORT_INLINE_MAX = 500;
export const LAYOUT_VERSION = 3;
export const LAYOUT_BEGIN = '<!-- gbrain:brain-layout:begin -->';
export const LAYOUT_END = '<!-- gbrain:brain-layout:end -->';
export const COMPANY_SOURCE = 'company';
export const CALLS_PREFIX = `${COMPANY_SOURCE}/calls`;
const CALL_FILES = /\.(txt|md)$/i;

export type LayoutScope = 'user' | 'project';

const hasPersonal = (s: BrainShape | undefined): boolean => s === 'personal' || s === 'both';
const hasCompany = (s: BrainShape | undefined): boolean => s === 'company' || s === 'both';

/** The setup command that targets this run's harness, wiring scope and pinned source; every rerun, remove and option argv starts with it. */
export const setupArgv = (harness: string, scope: LayoutScope = 'user', source: string | null = null): string[] =>
  ['gbrain', 'setup', harness, ...(scope === 'project' ? ['--scope', 'project'] : []), ...(source ? ['--source', source] : [])];

const markers = (harness: string, scope: LayoutScope, source: string | null, shape: BrainShape): BlockMarkers => ({ begin: LAYOUT_BEGIN, end: LAYOUT_END, label: 'brain-layout', rerun: [...setupArgv(harness, scope, source), '--shape', shape === 'none' ? 'personal' : shape].join(' ') });

export interface StarterPage { slug: string; title: string; body: string; type?: string }

/** The personal starter pages: empty forms with one marked example line each. */
export const PERSONAL_PAGES: readonly StarterPage[] = [
  {
    slug: 'me/facts',
    title: 'Facts about me',
    type: 'facts',
    body: 'True things about me that agents may say. One dated line per fact, with where it came from. '
      + 'Never overwrite a line: when something changes, add a new dated line.\n\n'
      + '- Example (delete me): 2026-01-01: I live in example-city. Source: I said so.',
  },
  {
    slug: 'me/voice',
    title: 'My voice',
    body: 'How I write, so drafts sound like me.\n\n'
      + '## Words I never use\n\n- Example (delete me): "synergy"\n\n'
      + '## Writing I like (links)\n\n- Example (delete me): https://example.com/a-post-i-like\n\n'
      + '## Writing I dislike (links)\n\n- Example (delete me): https://example.com/a-post-i-dislike',
  },
  {
    slug: 'me/how-i-decide',
    title: 'How I decide',
    body: 'The rules of thumb I use, so agents can apply them. One line each, dated.\n\n'
      + '- Example (delete me): 2026-01-01: I say no to a meeting without an agenda.',
  },
];

/** The company starter pages, in the company source: empty forms with one marked example line each. */
export const COMPANY_PAGES: readonly StarterPage[] = [
  {
    slug: 'company/facts',
    title: 'Company facts',
    type: 'facts',
    body: 'Numbers and facts agents may quote. One line each, with a date and where it came from. '
      + 'Never overwrite a line: when a number changes, add a new dated line.\n\n'
      + '- Example (delete me): 2026-01-01: 12 paying customers. Source: billing export.',
  },
  {
    slug: 'company/decisions',
    title: 'Decisions',
    body: 'A dated log of decisions: what we decided, why, who decided, and what would make us revisit it. '
      + 'Add new entries at the bottom; never rewrite an old one.\n\n'
      + '- Example (delete me): 2026-01-01: Decision: annual plans only. Why: churn. Who: founders. Revisit if: churn drops below 2%.',
  },
  {
    slug: 'company/pricing',
    title: 'Pricing',
    body: 'Current prices and plans, each with the date it took effect.\n\n'
      + '- Example (delete me): 2026-01-01: Team plan, $20 per seat per month.',
  },
  {
    slug: 'company/customers',
    title: 'Customers',
    body: 'An index of customer pages: one line per customer, linking its page.\n\n'
      + '- Example (delete me): acme-example, customer since 2026-01.',
  },
  {
    slug: 'company/calls',
    title: 'Calls',
    body: 'An index of call notes: one line per call, with its date, who was on it and a link to its page.\n\n'
      + '- Example (delete me): 2026-01-01, acme-example renewal call.',
  },
  {
    slug: 'company/playbooks',
    title: 'Playbooks',
    body: 'An index of how we do recurring work: one line per playbook, linking its page.\n\n'
      + '- Example (delete me): onboarding a new customer.',
  },
];

export function renderStarterPage(p: StarterPage): string {
  return `---\ntitle: ${p.title}\n${p.type ? `type: ${p.type}\n` : ''}status: stub\n---\n# ${p.title}\n\n${p.body}\n\n`
    + '_This page is an empty form (status: stub). It holds no facts until you add your own lines; then remove the stub line from the frontmatter._\n';
}

/** The shape the block describes: the company part only when setup made it locally (not --team). */
const blockShape = (shape: BrainShape, team: boolean): BrainShape =>
  !team || !hasCompany(shape) ? shape : shape === 'both' ? 'personal' : 'none';

export function renderLayoutBlock(harness: string, scope: LayoutScope = 'user', source: string | null = null, shape: BrainShape = 'personal'): string {
  const lines = [
    `<!-- gbrain brain-layout v${LAYOUT_VERSION}: managed by gbrain setup and replaced on upgrade; edit outside these markers. Remove: ${[...setupArgv(harness, scope, source), '--shape', 'none'].join(' ')} -->`,
    '## My brain layout (gbrain)',
  ];
  if (hasPersonal(shape)) {
    lines.push('- Before a task that needs my context, read the gbrain pages me/facts, me/voice and me/how-i-decide.',
      '- State facts about me only from me/facts, and say they came from there.');
  }
  if (hasCompany(shape)) {
    lines.push(`- Before a task that needs the company's context, read company/facts, company/decisions and company/pricing (source ${COMPANY_SOURCE}).`,
      '- Quote company numbers only from company/facts, and name it.',
      '- Add a new decision to company/decisions as a dated entry with why, who and what would make us revisit it.',
      `- Save company facts and decisions with --source ${COMPANY_SOURCE}; personal ones go to the default source.`);
  }
  lines.push('- A page with type: facts holds one dated line per fact: quote only its dated lines, and add a new fact as a new dated line.',
    '- Never overwrite a page: add a new dated line. Save facts I tell you with remember, naming where they came from.',
    '- A page whose frontmatter says status: stub is an empty form: it holds no facts yet.');
  return lines.join('\n');
}

/** Markdown files (or files matching `files`) under `dir` (dot folders skipped), counted up to `cap` + 1, with the first one found. */
export function countNotes(dir: string, cap = IMPORT_INLINE_MAX, files = /\.(md|markdown)$/i): { count: number; first: string | null } {
  let count = 0;
  let first: string | null = null;
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (count > cap) return;
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (files.test(name)) { count++; first ??= p; }
    }
  };
  walk(dir);
  return { count, first };
}

/** The title search should find for a note: its first heading, else its file name. */
export function noteTitle(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    const fm = /^---\n[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/.exec(text)?.[1]?.trim();
    if (fm) return fm;
    const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (h) return h;
  } catch { /* fall through */ }
  return basename(path).replace(/\.(md|markdown)$/i, '');
}

/** Notes folders a person commonly has, for the agent to offer; never imported unless picked. */
export function candidateNoteFolders(home: string = homedir()): string[] {
  const fixed = ['notes', 'Notes', 'Documents/notes', 'Documents/Notes', 'Obsidian', 'Documents/Obsidian'].map(p => join(home, p));
  const vaults: string[] = [];
  for (const base of [home, join(home, 'Documents'), join(home, 'Library/Mobile Documents/iCloud~md~obsidian/Documents')]) {
    let names: string[] = [];
    try { names = readdirSync(base); } catch { continue; }
    for (const n of names) if (!n.startsWith('.') && existsSync(join(base, n, '.obsidian'))) vaults.push(join(base, n));
  }
  return [...new Set([...vaults, ...fixed])].filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** --shape / --notes / --docs / --transcripts / --team validation; a string is the refusal (nothing written). */
export function parseLayoutFlags(value: (flag: string) => string | undefined, has: (flag: string) => boolean, harness: string | undefined): { brain?: BrainShape; notes?: string | null; docs?: string | null; transcripts?: string | null; team?: boolean } | string {
  const brain = value('--shape') as BrainShape | undefined;
  if (brain !== undefined && !['personal', 'company', 'both', 'none'].includes(brain)) return `unknown --shape '${brain}'; pass personal, company, both or none`;
  const out: { brain?: BrainShape; notes?: string | null; docs?: string | null; transcripts?: string | null; team?: boolean } = brain ? { brain } : {};
  const folders = [['--notes', 'notes', hasPersonal, 'personal or both'], ['--docs', 'docs', hasCompany, 'company or both'], ['--transcripts', 'transcripts', hasCompany, 'company or both']] as const;
  for (const [flag, key, needs, shapes] of folders) {
    const raw = value(flag);
    if (raw === undefined) continue;
    if (!needs(brain)) return `${flag} needs --shape ${shapes}`;
    if (raw === 'none') { out[key] = null; continue; }
    const abs = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    if (!abs.startsWith('/')) return `${flag} needs an absolute path (or ~/...)`;
    try { if (!statSync(abs).isDirectory()) return `${flag} ${raw} is not a folder`; } catch { return `${flag} ${raw} does not exist`; }
    if (has('--remove')) return `${flag} and --remove do not go together`;
    out[key] = resolve(abs);
  }
  if (has('--team') && has('--solo')) return '--team and --solo do not go together';
  if ((has('--team') || has('--solo')) && !hasCompany(brain)) return '--team and --solo need --shape company or both';
  if (has('--team')) {
    for (const flag of ['docs', 'transcripts'] as const) {
      if (out[flag]) return `--${flag} imports into this machine's company source, and with --team the company part lives on a shared brain; drop --${flag} or use --solo (gbrain setup ${harness ?? '<harness>'} --shape ${brain} --solo)`;
    }
    out.team = true;
  }
  return out;
}

export interface ImportOutcome { dir: string; files: number; action: 'imported' | 'deferred' | 'failed'; argv: string[]; detail?: string }

/** The call-transcript import: counts from gbrain import --calls, and who can read the pages (gbrain access who-can-read). */
export interface TranscriptsOutcome extends ImportOutcome {
  imported?: number;
  unchanged?: number;
  kept?: number;
  redactions?: number;
  readers?: { members: 'every_source_reader' | string[] | null; serves: 'one' | 'several' | null; detail: string };
  /** What can send call text off this machine, from doctor's auto_chronicle and extract_atoms_backlog checks. */
  egress?: { leaves: boolean; detail: string };
}

export interface LayoutOutcome {
  shape: BrainShape;
  pages: Array<{ slug: string; source: string | null; action: 'write' | 'keep' | 'failed'; detail?: string }>;
  notes: ImportOutcome | null;
  docs: ImportOutcome | null;
  transcripts: TranscriptsOutcome | null;
  company: { source: string; action: 'created' | 'kept' | 'team' | 'failed'; federated: boolean | null; root: string | null; detail?: string } | null;
  block: { path: string; action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve'; detail: string } | null;
  check: { ok: boolean; query: string | null; detail: string };
  next_question: string | null;
  /** What the conversation archive is doing on this brain, read from doctor's transcript_archive_freshness check. */
  archive: { state: 'on' | 'off' | 'offered' | 'unknown'; detail: string } | null;
}

/** A gbrain child; `source` pins it to one source through GBRAIN_SOURCE (null: the caller's environment as it is). */
type Run = (argv: string[], stdin?: string, source?: string | null) => { code: number; stdout: string; stderr: string };
const run: Run = (argv, stdin, source) => {
  const env = source ? { ...process.env, GBRAIN_SOURCE: source } : process.env;
  const child = bunSpawnSync(argv, { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', env });
  return { code: child.exitCode ?? 1, stdout: child.stdout?.toString() ?? '', stderr: child.stderr?.toString() ?? '' };
};

function syncLayoutBlock(path: string | null, harness: string, scope: LayoutScope, source: string | null, shape: BrainShape, dryRun: boolean): LayoutOutcome['block'] {
  if (!path) return null;
  const m = markers(harness, scope, source, shape);
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, 'utf8') : '';
  const probe = probeBlock(m, text);
  if (probe.state === 'damaged') return { path, action: 'preserve', detail: `the brain-layout markers in ${path} were hand-edited; fix or delete them, then re-run` };
  if (shape === 'none') {
    if (probe.state === 'absent') return { path, action: 'skip', detail: `no brain-layout block in ${path}` };
    if (!dryRun) writeUnlessChanged(path, text, false, removeBlock(m, text).text);
    return { path, action: 'remove', detail: `brain-layout block removed from ${path}; the pages stay` };
  }
  const body = renderLayoutBlock(harness, scope, source, shape);
  if (probe.state === 'present' && probe.interior?.trim() === body.trim()) return { path, action: 'keep', detail: `brain-layout block in ${path} is current` };
  if (!dryRun) writeUnlessChanged(path, text, !exists, spliceBlock(m, text, body));
  return { path, action: 'write', detail: `brain-layout block ${probe.state === 'present' ? 'upgraded in' : 'appended to'} ${path}` };
}

/** Each page create-only: written only when `get` says page_not_found, so a read error never becomes an overwrite. */
function writePages(exec: Run, launcher: string, pages: readonly StarterPage[], source: string | null, dryRun: boolean): LayoutOutcome['pages'] {
  return pages.map((page) => {
    if (dryRun) return { slug: page.slug, source, action: 'write', detail: 'would write if missing' };
    const got = exec([launcher, 'get', page.slug, '--json'], undefined, source);
    if (got.code === 0) return { slug: page.slug, source, action: 'keep' };
    if (errorCode(got.stdout) !== 'page_not_found') return { slug: page.slug, source, action: 'failed', detail: lastLine(got.stderr || got.stdout) };
    const put = exec([launcher, 'put', page.slug, '--json'], renderStarterPage(page), source);
    return put.code === 0 ? { slug: page.slug, source, action: 'write' } : { slug: page.slug, source, action: 'failed', detail: lastLine(put.stderr) };
  });
}

/** One read-only import of `dir` into `source`, deferred to the agent above IMPORT_INLINE_MAX; returns the first file's title to search for. */
function importFolder(exec: Run, launcher: string, dir: string, source: string | null, dryRun: boolean): { outcome: ImportOutcome; title: string | null } {
  const { count, first } = countNotes(dir);
  const argv = ['gbrain', 'import', dir, '--no-embed', ...(source ? ['--source', source] : [])];
  if (count > IMPORT_INLINE_MAX) return { outcome: { dir, files: count, action: 'deferred', argv, detail: `more than ${IMPORT_INLINE_MAX} markdown files; run the import as its own step` }, title: null };
  if (dryRun) return { outcome: { dir, files: count, action: 'imported', argv, detail: 'would import (read only)' }, title: null };
  const imp = exec([launcher, 'import', dir, '--no-embed', '--json'], undefined, source);
  if (imp.code !== 0) return { outcome: { dir, files: count, action: 'failed', argv, detail: lastLine(imp.stderr) }, title: null };
  return { outcome: { dir, files: count, action: 'imported', argv }, title: first ? noteTitle(first) : null };
}

/** Who can read the call pages, from gbrain access who-can-read on one of them and gbrain access serves; read only. */
function readersOf(exec: Run, launcher: string, slug: string): NonNullable<TranscriptsOutcome['readers']> {
  const unknown = { members: null, serves: null, detail: `unknown; run gbrain access who-can-read ${slug} --source ${COMPANY_SOURCE}` };
  let page: { readers: string[] | null; members: 'every_source_reader' | string[] } | undefined;
  let serves: { serves?: 'one' | 'several'; enabled_members?: string[] } = {};
  try { page = (JSON.parse(exec([launcher, 'access', 'who-can-read', slug, '--source', COMPANY_SOURCE, '--json'], undefined, null).stdout) as { pages?: Array<NonNullable<typeof page>> }).pages?.[0]; } catch { return unknown; }
  try { serves = JSON.parse(exec([launcher, 'access', 'serves', '--json', '--no-open-pages'], undefined, null).stdout) as typeof serves; } catch { /* the serves clause is left out */ }
  if (!page) return unknown;
  const who = serves.serves === 'several' ? `this brain serves several people: ${(serves.enabled_members ?? []).join(', ') || 'none enabled'}`
    : serves.serves === 'one' ? 'this brain serves one person' : null;
  const members = page.members;
  const clauses = [...(members === 'every_source_reader' ? [] : [`access rules on source ${COMPANY_SOURCE} cover ${CALLS_PREFIX}/`]), ...(who ? [who] : [])];
  const detail = `${members === 'every_source_reader' ? `everyone who can read source ${COMPANY_SOURCE}` : `${members.join(', ') || 'no member'} only`}${clauses.length ? ` (${clauses.join('; ')})` : ''}`;
  return { members, serves: serves.serves ?? null, detail };
}

/** One read-only import of a call-transcript folder into the company source, deferred to the agent above IMPORT_INLINE_MAX files. */
function importCalls(exec: Run, launcher: string, dir: string, dryRun: boolean): TranscriptsOutcome {
  const { count } = countNotes(dir, IMPORT_INLINE_MAX, CALL_FILES);
  const args = ['import', dir, '--calls', '--prefix', CALLS_PREFIX, '--no-embed'];
  const argv = ['gbrain', ...args, '--source', COMPANY_SOURCE];
  if (count > IMPORT_INLINE_MAX) return { dir, files: count, action: 'deferred', argv, detail: `more than ${IMPORT_INLINE_MAX} call files; run the import as its own step` };
  if (dryRun) return { dir, files: count, action: 'imported', argv, detail: 'would import (read only)' };
  const imp = exec([launcher, ...args, '--json'], undefined, COMPANY_SOURCE);
  let doc: { imported?: number; unchanged?: number; kept?: number; errors?: number; redactions?: number; pages?: Array<{ slug: string; status: string; error?: string }> };
  try { doc = JSON.parse(imp.stdout) as typeof doc; } catch { return { dir, files: count, action: 'failed', argv, detail: lastLine(imp.stderr || imp.stdout) }; }
  const landed = (doc.pages ?? []).filter(p => p.status !== 'error');
  const failed = (doc.pages ?? []).find(p => p.status === 'error');
  const counts = { imported: doc.imported ?? 0, unchanged: doc.unchanged ?? 0, kept: doc.kept ?? 0, redactions: doc.redactions ?? 0 };
  if (!landed.length && (failed || imp.code !== 0)) return { dir, files: count, action: 'failed', argv, ...counts, detail: failed?.error ?? lastLine(imp.stderr) };
  return { dir, files: count, action: 'imported', argv, ...counts, ...(failed ? { detail: `${doc.errors} file(s) not imported: ${failed.error}` } : {}),
    ...(landed[0] ? { readers: readersOf(exec, launcher, landed[0].slug) } : {}) };
}

type DoctorChecks = Array<{ name: string; details?: Record<string, unknown> }>;

/** Whether scheduled extraction can send imported call text to a chat provider; embedding stays held either way. */
export function callEgress(checks: DoctorChecks): NonNullable<TranscriptsOutcome['egress']> {
  const details = (name: string) => checks.find(c => c.name === name)?.details;
  const chronicle = details('auto_chronicle');
  const chat = chronicle?.chat_available;
  const readers: string[] = [];
  if (chronicle?.enabled === true && chat === true) readers.push(`event extraction (auto_chronicle, at most ${chronicle.daily_limit} page(s) a day)`);
  if (details('extract_atoms_backlog')?.pack_declares_phase === true && chat !== false) readers.push('atom extraction (within cycle.extract_atoms.budget_usd)');
  const held = 'embedding waits for your approval';
  return readers.length
    ? { leaves: true, detail: `with a chat model key set, ${readers.join(' and ')} can send call text to your chat provider, within the limits you set; ${held}` }
    : { leaves: false, detail: `nothing; no extraction reads call pages here, and ${held}` };
}

/** What the conversation archive is doing here, from doctor's transcript_archive_freshness check; its first-run notice is not repeated. With `calls`, the same doctor run also reads what can send call text off this machine. */
function archiveState(exec: Run, launcher: string, calls: TranscriptsOutcome | null): NonNullable<LayoutOutcome['archive']> {
  const only = ['transcript_archive_freshness', ...(calls ? ['auto_chronicle', 'extract_atoms_backlog'] : [])];
  const out = exec([launcher, 'doctor', '--only', only.join(','), '--json'], undefined, null);
  let checks: DoctorChecks = [];
  try { checks = (JSON.parse(out.stdout) as { checks?: DoctorChecks }).checks ?? []; } catch { /* unknown below */ }
  if (calls) calls.egress = callEgress(checks);
  const details = checks.find(c => c.name === 'transcript_archive_freshness')?.details as { enabled?: boolean; offered?: boolean } | undefined;
  if (!details) return { state: 'unknown', detail: 'could not be read; gbrain transcripts archive status shows it' };
  if (details.enabled) return { state: 'on', detail: 'on: your agent conversations are kept, redacted, under conversations/; call transcripts are separate (gbrain transcripts archive off turns it off)' };
  if (details.offered) return { state: 'offered', detail: 'offered, not on: this brain may serve more than one person (gbrain transcripts archive on turns it on)' };
  return { state: 'off', detail: 'off (gbrain transcripts archive on turns it on)' };
}

/** Whether keyless search (scoped to `source`, or default search for null) puts `title` in its top 5. */
function searchFinds(exec: Run, launcher: string, title: string, source: string | null): boolean {
  const hits = exec([launcher, 'search', title, '--json'], undefined, source);
  try { return (JSON.parse(hits.stdout) as Array<{ title?: string }>).slice(0, 5).some(h => (h.title ?? '').trim().toLowerCase() === title.toLowerCase()); } catch { return false; }
}

/** The company source: kept when it exists, else added on a gbrain-owned folder beside the default source's content root. */
function ensureCompanySource(exec: Run, launcher: string, dryRun: boolean): NonNullable<LayoutOutcome['company']> {
  const failed = (detail: string) => ({ source: COMPANY_SOURCE, action: 'failed' as const, federated: null, root: null, detail });
  const listed = exec([launcher, 'sources', 'list', '--json'], undefined, null);
  let sources: Array<{ id: string; local_path: string | null; federated: boolean }> = [];
  try { sources = (JSON.parse(listed.stdout) as { sources?: typeof sources }).sources ?? []; } catch { return failed(lastLine(listed.stderr || listed.stdout)); }
  const existing = sources.find(s => s.id === COMPANY_SOURCE);
  if (existing) return { source: COMPANY_SOURCE, action: 'kept', federated: existing.federated, root: existing.local_path };
  const defaultRoot = sources.find(s => s.id === 'default')?.local_path;
  const root = defaultRoot ? join(dirname(defaultRoot), COMPANY_SOURCE) : gbrainPath('content', COMPANY_SOURCE);
  if (dryRun) return { source: COMPANY_SOURCE, action: 'created', federated: null, root, detail: 'would add' };
  const st = lstatSync(root, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || readdirSync(root).length > 0)) return failed(`${root} already exists and is not an empty folder; move it or add a folder yourself with gbrain sources add ${COMPANY_SOURCE} --path <folder>`);
  mkdirSync(root, { recursive: true });
  const add = exec([launcher, 'sources', 'add', COMPANY_SOURCE, '--path', root, '--json'], undefined, null);
  if (add.code !== 0) return failed(lastLine(add.stderr || add.stdout));
  let federated = false;
  try { const doc = JSON.parse(add.stdout) as { federated?: unknown; config?: { federated?: unknown } }; federated = doc.federated === true || doc.config?.federated === true; } catch { /* unreadable: not federated */ }
  return { source: COMPANY_SOURCE, action: 'created', federated, root };
}

/**
 * The layout for this run. `instructionsPath` is the file the brain-first block lives in (null when the harness has
 * none); the layout block goes there too, and comes out of it when the person declined instructions. `source` is
 * the run's pinned source, where personal pages and notes go; company pages and docs always go to COMPANY_SOURCE.
 */
export function applyBrainLayout(opts: { harness: string; scope?: LayoutScope; source?: string | null; launcher: string; flags: LayoutFlags; instructionsPath: string | null; instructionsDeclined?: boolean; run?: Run }): LayoutOutcome | null {
  const { flags, launcher, harness } = opts;
  const source = opts.source ?? null;
  const scope = opts.scope ?? 'user';
  const team = !!flags.team;
  const empty = (shape: BrainShape, block: LayoutOutcome['block']): LayoutOutcome => ({ shape, pages: [], notes: null, docs: null, transcripts: null, company: null, block, check: { ok: true, query: null, detail: 'nothing to check' }, next_question: null, archive: null });
  const written = flags.brain ? blockShape(flags.brain, team) : undefined;
  const removed = opts.instructionsDeclined ? syncLayoutBlock(opts.instructionsPath, harness, scope, source, 'none', flags.dryRun) : null;
  const block = opts.instructionsDeclined ? (removed?.action === 'skip' ? null : removed)
    : written && written !== 'none' ? syncLayoutBlock(opts.instructionsPath, harness, scope, source, written, flags.dryRun)
    : flags.brain === 'none' ? syncLayoutBlock(opts.instructionsPath, harness, scope, source, 'none', flags.dryRun) : null;
  if (!flags.brain) return block && opts.instructionsDeclined ? empty('none', block) : null;
  const exec = opts.run ?? run;
  const outcome = empty(flags.brain, block);
  if (flags.brain === 'none') return outcome;

  if (hasPersonal(flags.brain)) {
    outcome.pages.push(...writePages(exec, launcher, PERSONAL_PAGES, source, flags.dryRun));
    if (flags.notes) {
      const { outcome: notes, title } = importFolder(exec, launcher, flags.notes, source, flags.dryRun);
      outcome.notes = notes;
      if (title) {
        const found = searchFinds(exec, launcher, title, source);
        outcome.check = found
          ? { ok: true, query: title, detail: `keyless search found "${title}" from your notes` }
          : { ok: false, query: title, detail: `keyless search did not find "${title}" in its top 5; run gbrain search "${title}" to see what it returns` };
        if (found) outcome.next_question = `In a new session, ask: "what do my notes say about ${title}?"`;
      }
    }
  }

  if (hasCompany(flags.brain)) {
    if (team) {
      outcome.company = { source: COMPANY_SOURCE, action: 'team', federated: null, root: null, detail: 'a shared company brain is set up on its own; nothing was created here' };
    } else {
      const company = outcome.company = ensureCompanySource(exec, launcher, flags.dryRun);
      if (company.action === 'failed' && !opts.instructionsDeclined) outcome.block = syncLayoutBlock(opts.instructionsPath, harness, scope, source, blockShape(flags.brain, true), flags.dryRun);
      if (company.action !== 'failed') {
        outcome.pages.push(...writePages(exec, launcher, COMPANY_PAGES, COMPANY_SOURCE, flags.dryRun));
        if (flags.docs) {
          const { outcome: docs, title } = importFolder(exec, launcher, flags.docs, COMPANY_SOURCE, flags.dryRun);
          outcome.docs = docs;
          if (title) {
            const inDefault = company.federated === true;
            const found = searchFinds(exec, launcher, title, inDefault ? null : COMPANY_SOURCE);
            const where = inDefault ? 'default search' : `search of the ${COMPANY_SOURCE} source`;
            outcome.check = found
              ? { ok: outcome.check.ok, query: title, detail: `keyless ${where} found "${title}" from your company docs` }
              : { ok: false, query: title, detail: `keyless ${where} did not find "${title}" in its top 5; run gbrain search "${title}"${inDefault ? '' : ` --source ${COMPANY_SOURCE}`} to see what it returns` };
            if (found) outcome.next_question = `In a new session, ask: "what did we decide about ${title}, and why?"`;
          }
        }
        if (flags.transcripts) outcome.transcripts = importCalls(exec, launcher, flags.transcripts, flags.dryRun);
        if (!outcome.next_question && !flags.dryRun && !hasPersonal(flags.brain)) {
          outcome.next_question = 'Run gbrain sources demo company-brain to see how a company brain answers, then add one dated line to company/decisions and ask about it in a new session.';
        }
      }
    }
  }

  if (!outcome.next_question && !flags.dryRun && hasPersonal(flags.brain)) {
    const facts = exec([launcher, 'get', 'me/facts', '--json'], undefined, source);
    outcome.check = facts.code === 0 ? { ...outcome.check, detail: outcome.check.query ? outcome.check.detail : 'me/facts is readable' }
      : { ok: false, query: null, detail: 'me/facts could not be read back' };
    outcome.next_question = 'Add one dated line to me/facts, then in a new session ask: "what does my brain say about me?"';
  }
  if (!flags.dryRun) outcome.archive = archiveState(exec, launcher, outcome.transcripts?.action === 'imported' ? outcome.transcripts : null);
  return outcome;
}

/** The `code` of a gbrain --json error document, or null when stdout is not one. */
function errorCode(stdout: string): string | null {
  try { const doc = JSON.parse(stdout) as { code?: unknown }; return typeof doc.code === 'string' ? doc.code : null; } catch { return null; }
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'no output';
}

/** Lines for the human report. */
export function describeLayout(o: LayoutOutcome, dryRun: boolean): string[] {
  const would = dryRun ? 'would ' : '';
  const lines = [`Brain layout: ${o.shape}`];
  if (o.block) lines.push(`  instructions  ${o.block.detail}`);
  if (o.company) {
    const c = o.company;
    lines.push(c.action === 'team' ? `  company  team: ${c.detail}`
      : c.action === 'failed' ? `  company  failed: ${c.detail}`
      : `  company  ${would}${c.action === 'kept' ? 'keep' : 'add'} source ${c.source}${c.root ? ` at ${c.root}` : ''}${c.federated === null ? '' : c.federated ? ' (in default search)' : ' (not in default search)'}`);
  }
  for (const p of o.pages) lines.push(`  page     ${p.action.padEnd(7)} ${p.slug}${p.source === COMPANY_SOURCE ? ` (source ${COMPANY_SOURCE})` : ''}${p.detail ? ` (${p.detail})` : ''}`);
  for (const [label, i] of [['notes', o.notes], ['docs', o.docs]] as const) {
    if (i) lines.push(`  ${label.padEnd(8)} ${i.action === 'imported' ? `${would}import ${i.files} file(s) from ${i.dir} (read only)` : `${i.action}: ${i.detail ?? ''} (${i.argv.join(' ')})`}`);
  }
  const t = o.transcripts;
  if (t) {
    lines.push(t.action !== 'imported' ? `  calls    ${t.action}: ${t.detail ?? ''} (${t.argv.join(' ')})`
      : `  calls    ${would}import ${t.files} call file(s) from ${t.dir} as ${CALLS_PREFIX}/<date>-<title> (read only, credentials redacted)`
        + (t.imported === undefined ? '' : `: ${t.imported} new, ${t.unchanged} unchanged, ${t.kept} kept, ${t.redactions} credential(s) redacted${t.detail ? `; ${t.detail}` : ''}`));
    if (t.readers) lines.push(`           readable by: ${t.readers.detail}`);
    if (t.egress) lines.push(`           what leaves this machine: ${t.egress.detail}`);
  }
  if (o.archive) lines.push(`  archive  conversation archive ${o.archive.detail}`);
  if (!dryRun && o.shape !== 'none' && o.check.detail !== 'nothing to check') lines.push(`  check    ${o.check.ok ? 'ok' : 'not verified'}: ${o.check.detail}`);
  if (o.next_question) lines.push(`Next question: ${o.next_question}`);
  return lines;
}

/** Notices for what the agent still has to do: a deferred or failed import, a failed page, the company source left out of search, the team route. */
export function layoutNotices(o: LayoutOutcome | null, harness: string, scope: LayoutScope = 'user', source: string | null = null): Notice[] {
  if (!o) return [];
  const out: Notice[] = [];
  for (const i of [o.notes, o.docs, o.transcripts]) {
    if (!i || i.action === 'imported') continue;
    out.push({
      code: 'brain_layout_import_pending', kind: 'coaching',
      why: i.action === 'deferred' ? `${i.dir} holds more than ${IMPORT_INLINE_MAX} ${i === o.transcripts ? 'call' : 'markdown'} files, so setup did not import it inline.`
        : `The import of ${i.dir} did not finish (${i.detail ?? 'unknown error'}); nothing else changed.`,
      fix: { argv: i.argv, consent: [], actor: 'agent', requires_exclusive: true, why: 'Imports the folder (read only) into the brain; run it as its own step.' },
    });
  }
  const failed = o.pages.filter(p => p.action === 'failed');
  if (failed.length || o.company?.action === 'failed') {
    const what = [...failed.map(p => p.slug), ...(o.company?.action === 'failed' ? [`the ${COMPANY_SOURCE} source`] : [])];
    const companyFailed = o.company?.action === 'failed';
    const detail = companyFailed ? o.company!.detail : failed[0]!.detail;
    const argv = [...setupArgv(harness, scope, source), '--shape', o.shape, ...(o.company?.action === 'team' ? ['--team'] : [])];
    out.push({
      code: 'brain_layout_pages_pending', kind: 'coaching',
      why: `Setup could not write ${what.join(', ')} (${detail}); the rest of the install finished.`,
      fix: companyFailed
        ? { ask_user: true, argv, consent: [], actor: 'agent', requires_exclusive: true, why: 'The company source needs the user to fix its folder first; existing pages are kept.',
          user_message: `Setup could not add the ${COMPANY_SOURCE} source: ${detail}. Once that is fixed, rerun ${argv.join(' ')}` }
        : { argv, consent: [], actor: 'agent', requires_exclusive: true, why: 'Rerun once the brain is free; existing pages are kept.' },
    });
  }
  if (o.company && o.company.federated === false) {
    out.push({
      code: 'source_not_in_default_search', kind: 'info',
      why: `The ${COMPANY_SOURCE} source is not in default search: this brain does not read as serving one person, so searches that name no source skip the company pages until the user federates it.`,
      fix: { ask_user: true, argv: ['gbrain', 'sources', 'federate', COMPANY_SOURCE], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Puts the company pages in default search; on a brain more than one person reads, that is the user\'s call.',
        user_message: `Your company pages are kept out of default search because this brain may serve more than one person. Should searches include them? (gbrain sources federate ${COMPANY_SOURCE})` },
    });
  }
  if (o.company?.action === 'team') {
    out.push({
      code: 'brain_layout_team_next', kind: 'coaching',
      why: 'A company brain a team shares lives on its own brain, so teammates never reach this machine\'s personal pages. Setup created nothing for the company part.',
      user_message: 'For a team company brain: create a hosted workspace at https://gbrain.io (gbrainio workspace new), or self-host on Postgres and run gbrain access serves several. Then connect this harness to it too. Guide: docs/guides/brain-layout.md#a-team-company-brain.',
    });
  }
  return out;
}

/**
 * The `brain_shape` decision for a brand-new brain set up without --shape. Nothing is written until it is
 * answered (default none); each option is the exact command that applies it.
 */
export function brainShapeDecision(harness: string, folders: string[] = candidateNoteFolders(), scope: LayoutScope = 'user', source: string | null = null): Decision {
  const shape = (s: BrainShape) => [...setupArgv(harness, scope, source), '--shape', s];
  return {
    id: 'brain_shape',
    question: 'Give this brain a shape? A personal brain gets three empty starter pages (facts about you, your voice, how you decide) and '
      + 'a notes folder you pick, imported read only. A company brain gets empty pages for company facts, decisions, pricing, customers, '
      + 'calls and playbooks in a company source, and a docs folder you pick. Setup tells the agent to read them. Nothing is invented.',
    options: [
      ...folders.slice(0, 3).map((f, i) => ({ id: `personal_notes_${i + 1}`, label: `Personal brain, importing ${f}`, argv: [...shape('personal'), '--notes', f] })),
      { id: 'personal', label: 'Personal brain, no notes folder yet', argv: shape('personal') },
      { id: 'company', label: 'Company brain, just me (add --docs <folder> for company docs, --transcripts <folder> for call transcripts)', argv: shape('company') },
      { id: 'both', label: 'Personal and company brain, just me', argv: shape('both') },
      { id: 'company_team', label: 'Company brain shared with a team (prints where it lives; creates nothing)', argv: [...shape('company'), '--team'] },
      { id: 'none', label: 'No starter pages (memory works as it is)' },
    ],
    default: 'none',
    default_reason: 'Nothing is written until the user picks; memory already works without it.',
  };
}

/** The inline brain_shape questions; readLine answers eof (decline) unless isInteractive(). */
export async function askBrainShape(folders: string[] = candidateNoteFolders(), read: typeof readLine = readLine): Promise<{ brain?: BrainShape; notes?: string | null; docs?: string | null; transcripts?: string | null; team?: boolean }> {
  const line = async (prompt: string): Promise<string | null> => { const r = await read({ prompt }); return r.kind === 'line' ? r.text.trim() : null; };
  const pick = await line('What are you making?  1) a personal brain  2) a company brain  3) both  4) skip  [4]: ');
  const brain = ({ '1': 'personal', '2': 'company', '3': 'both' } as Record<string, BrainShape>)[pick ?? ''];
  if (!brain) return {};
  const folder = async (prompt: string, hint?: string): Promise<string | null> => {
    const raw = (await line(`${prompt} (Enter ${hint ? 'for the one shown' : 'to skip'}, "none" to skip)${hint ? ` [${hint}]` : ''}: `)) ?? 'none';
    const picked = raw === 'none' ? null : raw || hint || null;
    if (!picked) return null;
    const abs = resolve(picked.startsWith('~/') ? join(homedir(), picked.slice(2)) : picked);
    try { if (statSync(abs).isDirectory()) return abs; } catch { /* below */ }
    process.stderr.write(`${picked} is not a folder; skipping that import (run gbrain import <dir> --no-embed later)\n`);
    return null;
  };
  const out: { brain: BrainShape; notes?: string | null; docs?: string | null; transcripts?: string | null; team?: boolean } = { brain };
  if (hasPersonal(brain)) out.notes = await folder('Notes folder to import, read only', folders[0]);
  if (hasCompany(brain)) {
    out.team = (await line('Just you, or a team?  1) just me  2) a team  [1]: ')) === '2';
    if (!out.team) {
      out.docs = await folder('Company docs folder to import, read only');
      out.transcripts = await folder('Folder of call transcripts (.txt or .md exports) to import, read only');
    }
  }
  return out;
}

/** Add brain_shape to setup's first-run bundle (one bundle, never a second notice). */
export function withBrainShape(notices: Notice[], decision: Decision): Notice[] {
  const i = notices.findIndex(n => n.code === 'first_run_decisions');
  const line = ' Want a personal or company brain? I can add starter pages (facts, voice and decisions) and import a notes or docs folder you pick.';
  if (i < 0) {
    return [{ code: 'first_run_decisions', kind: 'ask', why: 'Setup is complete and memory works now. One optional choice remains; nothing is written until the user answers.',
      user_message: `gbrain is set up, so memory works now.${line}`, decisions: [decision] }, ...notices];
  }
  const n = notices[i]!;
  const next = [...notices];
  next[i] = { ...n, user_message: `${n.user_message ?? ''}${line}`, decisions: [...(n.decisions ?? []), decision] };
  return next;
}
