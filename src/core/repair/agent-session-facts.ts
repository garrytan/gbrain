/**
 * `gbrain repair agent-session-facts` (#8064): re-attribute facts the capture
 * lanes (`hook:writeback`, `hook:compact`, `sweep:corpus`) saved as the
 * owner's own from sessions an orchestrator launched (headless workers on the
 * owner's account), and retire the takes consolidate promoted from them. The
 * capture fix stops new damage (agent sessions get a speaker sidecar and their
 * facts `attributed_to: other`); this kind repairs the facts already stored.
 *
 * Candidates are active capture-lane facts of the scoped sources whose
 * `attributed_to` is `user` or unset. Each is classified from its session
 * (`source_session`; corpus rows resolve with `corpusFileSessionId`):
 *   - evidenced: the session has a speaker sidecar (`<sid>.speaker.json` in
 *     the corpus dir, its spool dir or beside the session's corpus files);
 *     the operator listed it with `--session <id>`; or its `<sid>.source.json`
 *     records a cwd under an operator `--cwd <prefix>` (realpath-normalized,
 *     compared on path boundaries).
 *   - ambiguous: the session's first user turn (whitespace-normalized,
 *     lowercased, at least 40 characters) shares its first 160 characters with
 *     the first user turn of at least 3 other retained sessions (a template
 *     brief). Listed fact by fact; re-attributed only with
 *     `--include-ambiguous` and the hash of that preview.
 *   - excluded: an evidenced or ambiguous row whose claim and entity also have
 *     an active user-attributed row from a session that is not suspect (the
 *     owner said it too); kept.
 * Rows of sessions with no retained corpus file, sidecar or source record are
 * counted `unclassifiable` and never touched.
 *
 * The apply (`--apply --expect <hash> --yes`) never deletes. Each approved
 * fact still exactly as previewed gets `attributed_to: other` and the speaker
 * note (`speakerContextNote`) in its context: a fenced row (`row_num` on its
 * page) in the page's `## Facts` fence by one revision-bound `put_page` per
 * page, so the canonical projection rewrites the row in place; database-only
 * rows by one maintenance request on a managed brain (one transaction on an
 * unmanaged brain). Then each `kind: fact`, `holder: self` take that is still
 * active and unresolved and whose every contributing fact (`consolidated_into`)
 * is now non-user is retired (`active = false`): struck in the page's takes
 * fence by a revision-bound `put_page` when the fence holds it, otherwise in
 * the database by the same kind of request or transaction. A fact or take that
 * changed since the preview is reported `changed_since_preview` and kept.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { parseTakesFence } from '../takes-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { CONTEXT_NOTE_SEPARATOR } from '../facts/subject-infer.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { corpusFileSessionId, corpusSpoolDir, parseWbFileName, speakerFileName } from '../context/corpus-segments.ts';
import { readSessionSource } from '../context/corpus-source.ts';
import { parseCorpusTurns } from '../context/corpus-turns.ts';
import { DETECTED_PRINCIPAL, readSpeakerSidecar, speakerContextNote } from '../context/session-speaker.ts';
import { stripPastedContent } from '../transcripts/pasted-content.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { shellQuote } from '../shell-quote.ts';
import { pruneDir } from '../sync.ts';
import { CAPTURE_LANES, captureSessionId } from './captured-facts.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairPlanOptions,
  type RepairScope } from './core.ts';

export const AGENT_SESSION_FACTS_INTENT = 'managed_maintenance_agent_session_facts';
const COMMAND = 'agent-session-facts';
const CORPUS_KEY = 'dream.synthesize.session_corpus_dir';
const OPENING_CHARS = 160;
const OPENING_MIN_CHARS = 40;
const OPENING_MIN_OTHERS = 3;
const HEAD_BYTES = 64 * 1024;
const NOTE_SEPARATOR = CONTEXT_NOTE_SEPARATOR;
const NOTE_MARK = 'speaker: agent ';

export type AgentSessionFactClass = 'evidenced' | 'ambiguous' | 'excluded';

/** The operator's evidence flags: `--cwd <prefix>`, `--session <id>` (both repeatable) and `--principal <label>`. */
export interface AgentSessionOptions { cwdPrefixes?: string[]; sessions?: string[]; principal?: string }

export interface AgentSessionFactCandidate {
  id: number;
  source_id: string;
  /** The page the fact lives on (fenced rows) or its entity key (database-only rows). */
  slug: string;
  row_num: number | null;
  class: AgentSessionFactClass;
  /** `speaker_sidecar`, `operator_session`, `operator_cwd`, `repeated_opening` or `excluded:owner_also_said`. */
  reason: string;
  session: string;
  evidence: string;
  /** The agent the speaker note names. */
  principal: string;
  /** Digest of the row's claim, visibility, entity, fence position, attribution and context, so an edited row is not rewritten. */
  fact_hash: string;
}

export interface AgentSessionTake { id: number; source_id: string; slug: string; row_num: number; claim: string; fact_ids: number[]; take_hash: string }

export interface AgentSessionFactsClassification {
  candidates: AgentSessionFactCandidate[];
  unclassifiable: number;
  not_suspect: number;
  /** Corpus directories and session files the classification could not read (relative to the corpus dir). */
  unreadable_corpus_files: string[];
}

interface ApprovedPage {
  source_id: string;
  slug: string;
  include_ambiguous: boolean;
  scope: string[];
  /** The normalized evidence flags of the preview; an apply with other flags refuses. */
  options: string;
  facts?: AgentSessionFactCandidate[];
  takes?: AgentSessionTake[];
}

interface PageItem extends RepairItem { page: ApprovedPage; hash: string; last: boolean; options: AgentSessionOptions }

interface FactRow {
  id: number | string; source_id: string; source_session: string | null; fact: string; visibility: string; entity_slug: string | null;
  row_num: number | null; source_markdown_slug: string | null; attributed_to: string | null; context: string | null;
  owner_twin: boolean; twin_sessions: Array<string | null> | null;
}

type Verdict = { klass: 'evidenced' | 'ambiguous'; reason: string; evidence: string; principal: string } | 'not_suspect' | 'unclassifiable';

interface CorpusIndex {
  corpusDir: string | null;
  files: Map<string, string[]>;
  openings: Map<string, string>;
  openingSessions: Map<string, Set<string>>;
  unreadSessions: Set<string>;
  unreadable: string[];
}

/** Sorted, deduplicated flags: the form the hash, the commands and the approved set carry. */
export function normalizeAgentSessionOptions(opts: AgentSessionOptions): AgentSessionOptions & { cwdPrefixes: string[]; sessions: string[] } {
  return { cwdPrefixes: [...new Set(opts.cwdPrefixes ?? [])].sort(), sessions: [...new Set(opts.sessions ?? [])].sort(), ...(opts.principal ? { principal: opts.principal } : {}) };
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString('utf8');
  } finally { closeSync(fd); }
}

/** The session's first user turn, normalized; null when no retained file holds one long enough to compare, 'unread' when its files could not be read. */
function openingKey(paths: string[], unreadable: string[]): string | null {
  const ranked = paths.map(path => {
    let mtime = Number.POSITIVE_INFINITY;
    try { mtime = statSync(path).mtimeMs; } catch { /* ranked last */ }
    return { path, wb: parseWbFileName(basename(path)) !== null, mtime };
  }).sort((a, b) => Number(a.wb) - Number(b.wb) || a.mtime - b.mtime || a.path.localeCompare(b.path));
  let unread = false;
  for (const { path, wb } of ranked) {
    let head: string;
    try { head = readHead(path); } catch { unreadable.push(path); unread = true; continue; }
    const turn = wb ? stripPastedContent(head).text : parseCorpusTurns(head).find(t => t.role === 'user')?.body;
    const key = turn?.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, OPENING_CHARS);
    if (key) return key.length >= OPENING_MIN_CHARS ? key : null;
  }
  return unread ? 'unread' : null;
}

/** Every corpus `.txt` (dream discovery's pruning, the spool dir included) by session, and each session's opening. */
function corpusIndex(corpusDir: string | null): CorpusIndex {
  const index: CorpusIndex = { corpusDir, files: new Map(), openings: new Map(), openingSessions: new Map(), unreadSessions: new Set(), unreadable: [] };
  if (!corpusDir || !existsSync(corpusDir)) return index;
  const walk = (dir: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { index.unreadable.push(dir); return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (pruneDir(entry.name, dir)) walk(full); }
      else if (entry.isFile() && entry.name.endsWith('.txt')) {
        const session = corpusFileSessionId(entry.name);
        index.files.set(session, [...(index.files.get(session) ?? []), full]);
      }
    }
  };
  walk(corpusDir);
  for (const [session, paths] of index.files) {
    const key = openingKey(paths, index.unreadable);
    if (key === 'unread') { index.unreadSessions.add(session); continue; }
    if (!key) continue;
    index.openings.set(session, key);
    index.openingSessions.set(key, (index.openingSessions.get(key) ?? new Set<string>()).add(session));
  }
  return index;
}

function sessionVerdict(session: string, index: CorpusIndex, opts: AgentSessionOptions, cwdPrefixes: string[]): Verdict {
  const fallbackPrincipal = opts.principal ?? DETECTED_PRINCIPAL;
  const corpusDir = index.corpusDir;
  const dirs = corpusDir ? [...new Set([corpusDir, corpusSpoolDir(corpusDir), ...(index.files.get(session) ?? []).map(path => dirname(path))])] : [];
  for (const dir of dirs) {
    const sidecar = readSpeakerSidecar(dir, session);
    if (sidecar) {
      return { klass: 'evidenced', reason: 'speaker_sidecar', principal: sidecar.principal,
        evidence: `${relative(corpusDir!, join(dir, speakerFileName(session)))} (principal ${sidecar.principal})` };
    }
  }
  if (opts.sessions?.includes(session)) return { klass: 'evidenced', reason: 'operator_session', principal: fallbackPrincipal, evidence: `--session ${session}` };
  const record = corpusDir ? readSessionSource(corpusSpoolDir(corpusDir), session) : null;
  if (record?.cwd) {
    const cwd = canonicalPath(record.cwd);
    const prefix = cwdPrefixes.find(p => under(cwd, p));
    if (prefix) return { klass: 'evidenced', reason: 'operator_cwd', principal: fallbackPrincipal, evidence: `cwd ${record.cwd} under --cwd ${prefix}` };
  }
  const key = index.openings.get(session);
  const others = key ? index.openingSessions.get(key)!.size - 1 : 0;
  if (others >= OPENING_MIN_OTHERS) {
    return { klass: 'ambiguous', reason: 'repeated_opening', principal: fallbackPrincipal, evidence: `first user turn shared with ${others} other session(s)` };
  }
  return !index.unreadSessions.has(session) && (index.files.has(session) || record) ? 'not_suspect' : 'unclassifiable';
}

const factHash = (row: FactRow) => digest(['agent-session-fact-v1', row.fact, row.visibility, row.entity_slug, row.row_num, row.source_markdown_slug,
  row.attributed_to, row.context]);
const targetSlug = (row: Pick<FactRow, 'source_markdown_slug' | 'entity_slug'>) => row.source_markdown_slug ?? row.entity_slug ?? 'memory/unattributed';

/** Read-only: every user-attributed (or unattributed) capture-lane fact of these sources from a suspect session, classified, in (source, page, id) order. */
export async function classifyAgentSessionFacts(db: BrainEngine, sourceIds: string[],
  opts: AgentSessionOptions & { corpusDir?: string | null; ids?: number[] } = {}): Promise<AgentSessionFactsClassification> {
  const rows = await db.executeRaw<FactRow>(`
    SELECT f.id, f.source_id, f.source_session, f.fact, f.visibility, f.entity_slug, f.row_num, f.source_markdown_slug, f.attributed_to, f.context,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id=f.source_id AND a.id<>f.id AND a.expired_at IS NULL AND a.superseded_by IS NULL
             AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug AND gbrain_fact_fingerprint(a.fact)=gbrain_fact_fingerprint(f.fact)
             AND (a.attributed_to IS NULL OR a.attributed_to='user') AND COALESCE(a.source,'') <> ALL($2::text[])) AS owner_twin,
           ARRAY(SELECT DISTINCT COALESCE(a.source_session,'') FROM facts a WHERE a.source_id=f.source_id AND a.id<>f.id AND a.expired_at IS NULL
             AND a.superseded_by IS NULL AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug AND gbrain_fact_fingerprint(a.fact)=gbrain_fact_fingerprint(f.fact)
             AND (a.attributed_to IS NULL OR a.attributed_to='user') AND a.source=ANY($2::text[])) AS twin_sessions
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.source=ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
       AND (f.attributed_to IS NULL OR f.attributed_to='user') AND ($3::bigint[] IS NULL OR f.id=ANY($3::bigint[]))
     ORDER BY f.source_id, f.id`, [sourceIds, [...CAPTURE_LANES], opts.ids ?? null]);
  if (!rows.length) return { candidates: [], unclassifiable: 0, not_suspect: 0, unreadable_corpus_files: [] };
  const corpusDir = opts.corpusDir === undefined ? await db.getConfig(CORPUS_KEY) : opts.corpusDir;
  const index = corpusIndex(corpusDir ?? null);
  const cwdPrefixes = (opts.cwdPrefixes ?? []).map(canonicalPath);
  const verdicts = new Map<string, Verdict>();
  const verdict = (sourceSession: string | null): Verdict => {
    const session = captureSessionId(sourceSession || null);
    if (!session) return 'unclassifiable';
    if (!verdicts.has(session)) verdicts.set(session, sessionVerdict(session, index, opts, cwdPrefixes));
    return verdicts.get(session)!;
  };
  const candidates: AgentSessionFactCandidate[] = [];
  let unclassifiable = 0;
  let notSuspect = 0;
  for (const row of rows) {
    const hit = verdict(row.source_session);
    if (hit === 'unclassifiable') { unclassifiable++; continue; }
    if (hit === 'not_suspect') { notSuspect++; continue; }
    const owner = row.owner_twin || (row.twin_sessions ?? []).some(s => typeof verdict(s) === 'string');
    candidates.push({ id: Number(row.id), source_id: row.source_id, slug: targetSlug(row), row_num: row.row_num === null ? null : Number(row.row_num),
      class: owner ? 'excluded' : hit.klass, reason: owner ? 'excluded:owner_also_said' : hit.reason, session: captureSessionId(row.source_session)!,
      evidence: hit.evidence, principal: hit.principal, fact_hash: factHash(row) });
  }
  candidates.sort((a, b) => a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug) || a.id - b.id);
  return { candidates, unclassifiable, not_suspect: notSuspect,
    unreadable_corpus_files: index.unreadable.map(path => !corpusDir ? path : relative(corpusDir, path) || basename(path)) };
}

/**
 * Active, unresolved `kind: fact` / `holder: self` takes whose every contributing fact is non-user once the facts in
 * `reattributed` are: at least one of them must be in that set or already carry a speaker note, so takes this repair
 * has nothing to do with are never listed.
 */
export async function agentSessionTakes(db: BrainEngine, sourceIds: string[], reattributed: ReadonlySet<number>, ids?: number[]): Promise<AgentSessionTake[]> {
  const rows = await db.executeRaw<{ id: number | string; source_id: string; slug: string; row_num: number | string; claim: string;
    fact_ids: Array<number | string>; user_fact_ids: Array<number | string>; noted: boolean }>(`
    SELECT t.id, p.source_id, p.slug, t.row_num, t.claim,
           ARRAY(SELECT f.id FROM facts f WHERE f.consolidated_into=t.id ORDER BY f.id) AS fact_ids,
           ARRAY(SELECT f.id FROM facts f WHERE f.consolidated_into=t.id AND (f.attributed_to IS NULL OR f.attributed_to='user') ORDER BY f.id) AS user_fact_ids,
           EXISTS (SELECT 1 FROM facts f WHERE f.consolidated_into=t.id AND f.attributed_to='other' AND position($3::text in COALESCE(f.context,''))>0) AS noted
      FROM takes t JOIN pages p ON p.id=t.page_id
     WHERE p.source_id=ANY($1::text[]) AND t.kind='fact' AND t.holder='self' AND t.active AND t.resolved_at IS NULL
       AND ($2::bigint[] IS NULL OR t.id=ANY($2::bigint[])) AND EXISTS (SELECT 1 FROM facts f WHERE f.consolidated_into=t.id)
       AND t.created_at >= (SELECT min(f.consolidated_at) FROM facts f WHERE f.consolidated_into=t.id) - interval '1 second'
     ORDER BY p.source_id, p.slug, t.id`, [sourceIds, ids ?? null, NOTE_MARK]);
  return rows.filter(row => row.user_fact_ids.every(id => reattributed.has(Number(id))) && (row.noted || row.user_fact_ids.length > 0))
    .map(row => {
      const factIds = row.fact_ids.map(Number);
      return { id: Number(row.id), source_id: row.source_id, slug: row.slug, row_num: Number(row.row_num), claim: row.claim, fact_ids: factIds,
        take_hash: digest(['agent-session-take-v1', Number(row.id), row.slug, Number(row.row_num), row.claim, factIds]) };
    });
}

/** The evidence flags as CLI arguments, in their normalized order. */
export function agentSessionFlagArgs(opts: AgentSessionOptions): string[] {
  const normal = normalizeAgentSessionOptions(opts);
  return [...normal.cwdPrefixes.flatMap(p => ['--cwd', p]), ...normal.sessions.flatMap(s => ['--session', s]), ...(normal.principal ? ['--principal', normal.principal] : [])];
}

function previewCommand(scope: RepairScope, all: string[], opts: AgentSessionOptions, includeAmbiguous: boolean): string {
  const source = scope.source_ids.length === 1 && all.length > 1 ? ` --source ${scope.source_ids[0]}` : '';
  return `gbrain repair ${COMMAND}${source}${agentSessionFlagArgs(opts).map(arg => ` ${shellQuote(arg)}`).join('')}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

async function activeSources(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
}

async function brainId(engine: BrainEngine): Promise<string> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
  return brain?.brain_id ?? 'host';
}

function pageItem(page: ApprovedPage, hash: string, index: number, last: boolean, options: AgentSessionOptions): PageItem {
  return { cursor: { phase: page.facts ? 0 : 1, id: index }, source_id: page.source_id, slug: page.slug, chars: 0,
    action: page.facts ? `re-attribute ${page.facts.length} agent-session fact(s)` : `retire ${page.takes!.length} take(s)`, page, hash, last, options };
}

function groupByPage<T extends { source_id: string; slug: string }>(rows: T[], make: (first: T) => ApprovedPage, field: 'facts' | 'takes'): ApprovedPage[] {
  const pages = new Map<string, ApprovedPage>();
  for (const row of rows) {
    const key = `${row.source_id}\u0000${row.slug}`;
    const page = pages.get(key) ?? make(row);
    (page[field] as unknown as T[]).push(row);
    pages.set(key, page);
  }
  return [...pages.values()];
}

const evidenceOptions = (opts: RepairPlanOptions | undefined) =>
  normalizeAgentSessionOptions({ cwdPrefixes: opts?.cwdPrefixes, sessions: opts?.sessions, principal: opts?.principal });

export const agentSessionFactsRepair: RepairHandler = {
  kind: 'agent-session-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    const options = evidenceOptions(opts);
    const optionsKey = JSON.stringify(options);
    const command = previewCommand(scope, await activeSources(engine), options, includeAmbiguous);
    const hashOf = async (candidates: AgentSessionFactCandidate[], takes: AgentSessionTake[]) => previewHash(['agent-session-facts-v1', await brainId(engine),
      scope.source_ids, includeAmbiguous, options, candidates.map(c => [c.id, c.class, c.reason, c.principal, c.fact_hash]), takes.map(t => [t.id, t.take_hash])]);
    if (!opts?.apply) {
      const { candidates, unclassifiable, not_suspect, unreadable_corpus_files } = await classifyAgentSessionFacts(engine, scope.source_ids, options);
      const approvedFacts = candidates.filter(c => c.class === 'evidenced' || (c.class === 'ambiguous' && includeAmbiguous));
      const takes = await agentSessionTakes(engine, scope.source_ids, new Set(approvedFacts.map(c => c.id)));
      const hash = await hashOf(candidates, takes);
      const base = (row: { source_id: string; slug: string }) => ({ source_id: row.source_id, slug: row.slug, include_ambiguous: includeAmbiguous,
        scope: scope.source_ids, options: optionsKey });
      const approved = [...groupByPage(approvedFacts, row => ({ ...base(row), facts: [] }), 'facts'), ...groupByPage(takes, row => ({ ...base(row), takes: [] }), 'takes')];
      if (approved.length) await saveApprovedSet(engine, { command: COMMAND, hash }, approved);
      const count = (klass: AgentSessionFactClass) => candidates.filter(c => c.class === klass).length;
      const listing: RepairListing[] = candidates.map(c => ({ item: `${c.source_id}:${c.slug}#${c.id}`, class: c.class === 'excluded' ? c.reason : c.class,
        detail: `${c.reason}; session ${c.session}; ${c.evidence}; principal ${c.principal}` }));
      for (const take of takes) listing.push({ item: `${take.source_id}:${take.slug}@take:${take.id}`, class: 'take_to_retire',
        detail: `row ${take.row_num}; contributing facts ${take.fact_ids.join(', ')}` });
      for (const path of unreadable_corpus_files) listing.push({ item: path, class: 'unreadable_corpus_file',
        detail: 'not read (check its permissions); facts of its sessions are counted unclassifiable and kept' });
      return { items: approved.map((page, i) => pageItem(page, hash, i, i === approved.length - 1, options)), preview_hash: hash, listing,
        residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'), unclassifiable, not_suspect, takes_to_retire: takes.length,
          ...(unreadable_corpus_files.length ? { unreadable_corpus_files: unreadable_corpus_files.length } : {}) } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', `gbrain repair ${COMMAND} --apply re-attributes only the set a preview printed.`,
        `Preview first: ${command} — then run the apply command it prints after the user agrees: ${command} --apply --expect <preview-hash> --yes`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedPage>(engine, { command: COMMAND, hash: opts.expect, previewCommand: command, emptyHash: () => hashOf([], []) });
    const scopeKey = JSON.stringify(scope.source_ids);
    if (approved.items.some(page => page.include_ambiguous !== includeAmbiguous || JSON.stringify(page.scope) !== scopeKey || page.options !== optionsKey)) {
      throw previewChangedError(opts.expect, command);
    }
    const items = approved.items.map((page, i) => pageItem(page, opts.expect!, i, i === approved.items.length - 1, options))
      .filter(item => afterCursor(item.cursor, after));
    if (!items.length) await clearApprovedSet(engine, { command: COMMAND, hash: opts.expect });
    return { items, preview_hash: opts.expect, residuals: { approved_pages: approved.items.length, pending_pages: items.length } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last, options } = entry as PageItem;
    const engine = ctx.engine;
    const done: number[] = [];
    if (page.facts) {
      const live = new Map((await classifyAgentSessionFacts(engine, [page.source_id], { ...options, ids: page.facts.map(f => f.id) })).candidates.map(c => [c.id, c]));
      const unchanged = page.facts.filter(f => {
        const current = live.get(f.id);
        return !!current && (['class', 'reason', 'principal', 'fact_hash', 'slug', 'row_num'] as const).every(field => current[field] === f[field]);
      });
      const dbOnly = unchanged.filter(f => f.row_num === null);
      if (dbOnly.length) done.push(...await databaseWrite(engine, page, hash, { facts: dbOnly.map(f => ({ id: f.id, note: speakerContextNote(f.principal) })) }));
      const fenced = unchanged.filter(f => f.row_num !== null);
      if (fenced.length) done.push(...await rewriteFencedFacts(ctx, entry, page, fenced));
    } else {
      const live = new Map((await agentSessionTakes(engine, [page.source_id], new Set(), page.takes!.map(t => t.id))).map(t => [t.id, t]));
      const unchanged = page.takes!.filter(t => live.get(t.id)?.take_hash === t.take_hash);
      if (unchanged.length) done.push(...await retireTakes(ctx, entry, page, hash, unchanged));
    }
    if (last) await clearApprovedSet(engine, { command: COMMAND, hash });
    const all = (page.facts ?? page.takes!).map(row => row.id);
    const changed = all.filter(id => !done.includes(id));
    const verb = page.facts ? 'reattributed' : 'retired';
    return { applied: done.length > 0, outcome: !changed.length ? verb : done.length ? `partially_${verb}` : 'changed_since_preview',
      ...(changed.length ? { reason: `${done.length} of ${all.length} ${verb}; changed since the preview: ${changed.join(', ')}` } : {}) };
  },
};

/** One approved database-only write: facts to re-attribute (each with its speaker note) and takes to retire. */
export interface AgentSessionWrite { facts?: Array<{ id: number; note: string }>; take_ids?: number[] }

/**
 * Re-attributes each named database-only fact still user-attributed and active, appending its note once, and retires
 * each named take still active, unresolved, `kind: fact` / `holder: self` on a page of the source whose every
 * contributing fact is non-user. The checks run in the UPDATEs, under the row locks. Returns the changed ids.
 */
export async function applyAgentSessionWrite(tx: BrainEngine, sourceId: string, write: AgentSessionWrite): Promise<{ reattributed: number[]; retired: number[] }> {
  const reattributed = write.facts?.length ? (await tx.executeRaw<{ id: number | string }>(`UPDATE facts f
      SET attributed_to='other',
          context=CASE WHEN position(r.note in COALESCE(f.context,''))>0 THEN f.context ELSE concat_ws($3::text, NULLIF(f.context,''), r.note) END
     FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, note text)
    WHERE f.source_id=$1 AND f.id=r.id AND (f.attributed_to IS NULL OR f.attributed_to='user') AND f.expired_at IS NULL AND f.superseded_by IS NULL
      AND f.row_num IS NULL
    RETURNING f.id`, [sourceId, JSON.stringify(write.facts), NOTE_SEPARATOR])).map(row => Number(row.id)) : [];
  const retired = write.take_ids?.length ? (await tx.executeRaw<{ id: number | string }>(`UPDATE takes t SET active=false, updated_at=now()
     FROM pages p
    WHERE p.id=t.page_id AND p.source_id=$1 AND t.id=ANY($2::bigint[]) AND t.active AND t.resolved_at IS NULL AND t.kind='fact' AND t.holder='self'
      AND t.created_at >= (SELECT min(f.consolidated_at) FROM facts f WHERE f.consolidated_into=t.id) - interval '1 second'
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.consolidated_into=t.id AND (f.attributed_to IS NULL OR f.attributed_to='user'))
    RETURNING t.id`, [sourceId, write.take_ids])).map(row => Number(row.id)) : [];
  return { reattributed, retired };
}

/** Database-only rows: one maintenance request on the page key on a managed brain (owner-checked, receipted); one transaction otherwise. */
async function databaseWrite(engine: BrainEngine, page: ApprovedPage, hash: string, write: AgentSessionWrite): Promise<number[]> {
  const key = write.facts ? 'reattributed' : 'retired';
  if (!await managedPersistenceEnabled(engine)) return (await maintenanceTransaction(engine, tx => applyAgentSessionWrite(tx, page.source_id, write)))[key];
  const authority = (await maintenancePreflight(engine, page.source_id))!;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  const h = digest(['agent-session-facts-write-v1', hash, page.source_id, page.slug, write, snapshot?.revision ?? null]);
  const receipt = await submitDatabaseMaintenanceIntent(engine, authority, page.slug,
    { kind: AGENT_SESSION_FACTS_INTENT, expected_revision: snapshot?.revision ?? null, ...write },
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
  return (receipt[key] as number[] | undefined) ?? [];
}

/** Preparer for `managed_maintenance_agent_session_facts`: re-attributes the named database-only facts and retires the named takes. */
export async function prepareAgentSessionFactsWrite(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = (row.intent ?? {}) as { facts?: unknown; take_ids?: unknown };
  const facts = intent.facts ?? [];
  const takeIds = intent.take_ids ?? [];
  const valid = Array.isArray(facts) && facts.every(f => !!f && typeof f === 'object' && Number.isSafeInteger((f as { id: unknown }).id)
    && typeof (f as { note: unknown }).note === 'string') && Array.isArray(takeIds) && takeIds.every(id => Number.isSafeInteger(id)) && facts.length + takeIds.length > 0;
  if (!valid) {
    throw opError('invalid_params', 'The agent-session facts intent does not name its facts or takes.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts or takes to change, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: readFix('Previews the agent-session-facts repair without changing anything.', { argv: ['gbrain', 'repair', COMMAND, '--source', row.source_id, '--json'] }) });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot?.revision ?? null, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => ({ status: 'completed', ...await applyAgentSessionWrite(tx, row.source_id,
      { facts: facts as Array<{ id: number; note: string }>, take_ids: takeIds as number[] }) }) };
}

/**
 * Fenced facts: set `attributed_to: other` and append the note on each still-matching, still user-attributed active
 * fence row and publish the page once, bound to the revision read; the canonical projection rewrites the rows in
 * place. Returns the facts that now read back as `other`. A page stored in segments is not rewritten.
 */
async function rewriteFencedFacts(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, page: ApprovedPage, facts: AgentSessionFactCandidate[]): Promise<number[]> {
  const engine = ctx.engine;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  if (!snapshot || isSegmentedPage(snapshot.page)) return [];
  const rows = await engine.executeRaw<{ id: number | string; fact: string; row_num: number }>(
    'SELECT id, fact, row_num FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL', [page.source_id, facts.map(f => f.id)]);
  let body = snapshot.page.compiled_truth ?? '';
  const rewritten: number[] = [];
  for (const row of rows) {
    const note = speakerContextNote(facts.find(f => f.id === Number(row.id))!.principal);
    const fenceRow = parseFactsFence(body).facts.find(f => f.rowNum === Number(row.row_num));
    if (!fenceRow?.active || fenceRow.claim.trim() !== row.fact.trim() || (fenceRow.attributedTo !== undefined && fenceRow.attributedTo !== 'user')) continue;
    const next = strikeFenceRow(body, Number(row.row_num), current => ({ ...current, attributedTo: 'other',
      context: current.context?.includes(note) ? current.context : [current.context?.trim(), note].filter(Boolean).join(NOTE_SEPARATOR) }));
    if (next === null) continue;
    body = next;
    rewritten.push(Number(row.id));
  }
  if (!rewritten.length) return [];
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'agent-session-facts', item, snapshot.revision) } });
  return (await engine.executeRaw<{ id: number | string }>("SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND attributed_to='other'",
    [page.source_id, rewritten])).map(row => Number(row.id));
}

/**
 * Takes: a take the page's takes fence holds (same row and claim, active) is struck there by one revision-bound
 * `put_page` (the projection sets `active = false`); the rest are retired in the database. A page stored in
 * segments is not rewritten. Returns the retired takes.
 */
async function retireTakes(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, page: ApprovedPage, hash: string, takes: AgentSessionTake[]): Promise<number[]> {
  const engine = ctx.engine;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  if (snapshot && isSegmentedPage(snapshot.page)) return [];
  const body = snapshot ? serializePageToMarkdown(snapshot.page, snapshot.tags) : '';
  const fence = parseTakesFence(body);
  const fenced = takes.filter(t => fence.takes.some(row => row.rowNum === t.row_num && row.claim.trim() === t.claim.trim() && row.active));
  const retired: number[] = [];
  const databaseOnly = fence.takes.length ? [] : takes.filter(t => !fenced.includes(t)); // a fenced page's unmatched take stays: the file is the parent
  if (databaseOnly.length) retired.push(...await databaseWrite(engine, page, hash, { take_ids: databaseOnly.map(t => t.id) }));
  if (fenced.length && snapshot) {
    const rows = new Set(fenced.map(t => t.row_num));
    const content = takesPreparation.replaceFence(body, fence.takes.map(row => rows.has(row.rowNum) ? { ...row, active: false } : row));
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id, content,
      expected_revision: snapshot.revision, request_id: await repairRequestId(ctx, 'agent-session-facts', item, snapshot.revision) } });
    retired.push(...(await engine.executeRaw<{ id: number | string }>('SELECT id FROM takes WHERE id=ANY($1::bigint[]) AND active=false',
      [fenced.map(t => t.id)])).map(row => Number(row.id)));
  }
  return retired;
}
