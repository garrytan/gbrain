/**
 * `gbrain repair captured-facts`: expire facts that the capture lanes
 * (`hook:writeback`, `hook:compact`, `sweep:corpus`) extracted, before
 * v0.60.30.0, from gbrain's own claude-cli sessions (#5413, #5820) or from
 * pasted text (#5812). Those releases stopped new extraction; this kind
 * cleans up the facts already stored.
 *
 * Candidates are active capture-lane facts of the scoped sources. Each is
 * classified from its session (`source_session`; corpus rows carry
 * `sweep:corpus:<file>`, resolved with `corpusFileSessionId`):
 *   - evidenced (self-capture): the session id names a harness transcript
 *     under a gbrain claude-cli scratch project, or its corpus file sits in
 *     doctor's `<corpus>.quarantine/` directory.
 *   - ambiguous (paste candidate): a still-retained corpus file of the session
 *     holds a paste block, and at least 60% of the fact's content words occur
 *     in that file only inside paste blocks (not in the session's own text).
 *     Heuristic: listed in every preview, expired only with
 *     `--include-ambiguous` and the hash of that preview.
 *   - excluded: an evidenced or ambiguous row whose claim and entity also have
 *     an active row that is not suspect (another lane, or a capture row from a
 *     session that is neither); the self-capture prompts ran over real pages,
 *     so such a claim is legitimate and is kept.
 * Rows of sessions that cannot be classified on this host (harness transcript
 * pruned, corpus file gone) are counted as `unclassifiable`, never expired.
 *
 * The apply expires rows; it never records a withdrawal, so a later
 * `remember` of the same claim is not blocked. A fenced row (`row_num` on its
 * entity page) is struck in the page's `## Facts` fence by one revision-bound
 * `put_page` per page, so the canonical projection expires it and a later
 * write of the page cannot reactivate it; rows with no fence row are expired
 * by one database-only maintenance request on a managed brain (one
 * transaction on an unmanaged brain). Each fact is rechecked before it is
 * touched; a fact that changed since the preview is reported as
 * `changed_since_preview` and kept.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { claudeCliSelfProjectDirs, isClaudeCliSelfSessionId } from '../ai/providers/claude-cli-scratch.ts';
import { claudeProjectsDir } from '../bootstrap/host-specs.ts';
import { corpusFileSessionId, corpusTextForExtraction } from '../context/corpus-segments.ts';
import { pruneDir } from '../sync.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

export const CAPTURE_LANES = ['hook:writeback', 'hook:compact', 'sweep:corpus'] as const;
const CORPUS_KEY = 'dream.synthesize.session_corpus_dir';
const PASTE_SHARE = 0.6;
const EXPIRY_CONTEXT = 'expired: captured-facts repair';

export type CapturedFactClass = 'evidenced' | 'ambiguous' | 'excluded';

export interface CapturedFactCandidate {
  id: number;
  source_id: string;
  /** The page the fact lives on (fenced rows) or its entity key (database-only rows). */
  slug: string;
  row_num: number | null;
  class: CapturedFactClass;
  /** `self_capture_transcript`, `self_capture_quarantined`, `paste_heuristic`, or `excluded:legitimate_duplicate`. */
  reason: string;
  session: string;
  evidence: string;
  /** Digest of the row's claim, visibility, entity and fence position, so an edited row is not expired. */
  fact_hash: string;
}

export interface CapturedFactsClassification {
  candidates: CapturedFactCandidate[];
  unclassifiable: number;
  not_suspect: number;
}

export interface CapturedFactsPage {
  source_id: string;
  slug: string;
  include_ambiguous: boolean;
  scope: string[];
  facts: CapturedFactCandidate[];
}

interface PageItem extends RepairItem { page: CapturedFactsPage; hash: string; last: boolean }

interface FactRow {
  id: number | string; source_id: string; source: string; source_session: string | null; fact: string; visibility: string;
  entity_slug: string | null; row_num: number | null; source_markdown_slug: string | null; fingerprint: string; legit_twin: boolean;
}

export interface ClassifyOptions { projectsRoot?: string; corpusDir?: string | null; ids?: number[] }

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'his', 'her',
  'their', 'they', 'them', 'its', 'our', 'you', 'your', 'who', 'what', 'when', 'which', 'will', 'would', 'should', 'can', 'could', 'into', 'about']);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => !STOPWORDS.has(w)));
}

/** Every `.txt` under `root` (dream discovery's pruning), keyed by its session id. */
function sessionFiles(root: string | null | undefined): Map<string, string[]> {
  const bySession = new Map<string, string[]>();
  if (!root || !existsSync(root)) return bySession;
  const walk = (dir: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (pruneDir(entry.name, dir)) walk(full); }
      else if (entry.isFile() && entry.name.endsWith('.txt')) {
        const session = corpusFileSessionId(entry.name);
        bySession.set(session, [...(bySession.get(session) ?? []), full]);
      }
    }
  };
  walk(root);
  return bySession;
}

function harnessSessionIds(projectsRoot: string): Set<string> {
  const ids = new Set<string>();
  let projects: string[];
  try { projects = readdirSync(projectsRoot); } catch { return ids; }
  for (const project of projects) {
    let files: string[];
    try { files = readdirSync(join(projectsRoot, project)); } catch { continue; }
    for (const file of files) if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length));
  }
  return ids;
}

/** The capture session a fact row came from (`sweep:corpus:<file>` names the corpus file). */
export function captureSessionId(sourceSession: string | null): string | null {
  if (!sourceSession) return null;
  return sourceSession.startsWith('sweep:corpus:') ? corpusFileSessionId(basename(sourceSession.slice('sweep:corpus:'.length))) : sourceSession;
}

const factHash = (row: FactRow) => digest(['captured-fact-v1', row.fact, row.visibility, row.entity_slug, row.row_num, row.source_markdown_slug]);
const targetSlug = (row: Pick<FactRow, 'row_num' | 'source_markdown_slug' | 'entity_slug'>) =>
  row.row_num !== null && row.source_markdown_slug ? row.source_markdown_slug : row.source_markdown_slug ?? row.entity_slug ?? 'memory/unattributed';

/** Read-only: every suspect capture-lane fact of these sources, classified, in (source, page, id) order. */
export async function classifyCapturedFacts(db: BrainEngine, sourceIds: string[], opts: ClassifyOptions = {}): Promise<CapturedFactsClassification> {
  const rows = await db.executeRaw<FactRow>(`
    SELECT f.id, f.source_id, f.source, f.source_session, f.fact, f.visibility, f.entity_slug, f.row_num, f.source_markdown_slug,
           gbrain_fact_fingerprint(f.fact) AS fingerprint,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id=f.source_id AND a.id<>f.id AND a.expired_at IS NULL
             AND a.visibility=f.visibility AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug
             AND gbrain_fact_fingerprint(a.fact)=gbrain_fact_fingerprint(f.fact)
             AND COALESCE(a.source,'') <> ALL($2::text[])) AS legit_twin
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.source=ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
       AND ($3::bigint[] IS NULL OR f.id=ANY($3::bigint[]))
     ORDER BY f.source_id, f.id`, [sourceIds, [...CAPTURE_LANES], opts.ids ?? null]);
  if (!rows.length) return { candidates: [], unclassifiable: 0, not_suspect: 0 };
  const projectsRoot = opts.projectsRoot ?? claudeProjectsDir();
  const selfDirs = claudeCliSelfProjectDirs(projectsRoot);
  const known = harnessSessionIds(projectsRoot);
  const corpusDir = opts.corpusDir === undefined ? await db.getConfig(CORPUS_KEY) : opts.corpusDir;
  const corpus = sessionFiles(corpusDir);
  const quarantine = sessionFiles(corpusDir ? join(dirname(corpusDir), `${basename(corpusDir)}.quarantine`) : null);
  const pasteWords = new Map<string, { file: string; paste: Set<string> } | null>();
  const pasteOnlyWords = (session: string) => {
    if (pasteWords.has(session)) return pasteWords.get(session)!;
    let found: { file: string; paste: Set<string> } | null = null;
    for (const file of corpus.get(session) ?? []) {
      let raw: string;
      try { raw = readFileSync(file, 'utf8'); } catch { continue; }
      if (!raw.includes('<pasted_content')) continue;
      const own = words(corpusTextForExtraction(file, raw));
      const paste = new Set([...words(raw)].filter(w => !own.has(w)));
      found = found ? { file: found.file, paste: new Set([...found.paste, ...paste]) } : { file, paste };
    }
    pasteWords.set(session, found);
    return found;
  };

  type Hit = { klass: 'evidenced' | 'ambiguous'; reason: string; session: string; evidence: string };
  const classified: Array<Hit | 'unclassifiable' | 'not_suspect'> = rows.map(row => {
    const session = captureSessionId(row.source_session);
    if (!session) return 'unclassifiable';
    if (isClaudeCliSelfSessionId(session, selfDirs)) {
      const dir = selfDirs.find(d => existsSync(join(d, `${session}.jsonl`)))!;
      return { klass: 'evidenced', reason: 'self_capture_transcript', session, evidence: join(basename(dir), `${session}.jsonl`) };
    }
    const quarantined = quarantine.get(session);
    if (quarantined?.length) return { klass: 'evidenced', reason: 'self_capture_quarantined', session, evidence: basename(quarantined[0]!) };
    const paste = pasteOnlyWords(session);
    if (paste) {
      const claim = [...words(row.fact)];
      const covered = claim.filter(w => paste.paste.has(w)).length;
      if (claim.length >= 2 && covered / claim.length >= PASTE_SHARE) {
        return { klass: 'ambiguous', reason: 'paste_heuristic', session, evidence: `${basename(paste.file)}: ${covered}/${claim.length} words only in paste blocks` };
      }
    }
    return corpus.has(session) || known.has(session) ? 'not_suspect' : 'unclassifiable';
  });
  // A suspect claim that also has an active copy not proven suspect (another lane, or any other capture row) is kept.
  const twinKey = (row: FactRow) => JSON.stringify([row.source_id, row.visibility, row.entity_slug, row.fingerprint]);
  const unproven = new Set(rows.filter((_, i) => typeof classified[i] === 'string').map(twinKey));
  const candidates: CapturedFactCandidate[] = [];
  rows.forEach((row, i) => {
    const hit = classified[i];
    if (typeof hit === 'string') return;
    const legit = row.legit_twin || unproven.has(twinKey(row));
    candidates.push({ id: Number(row.id), source_id: row.source_id, slug: targetSlug(row), row_num: row.row_num === null ? null : Number(row.row_num),
      class: legit ? 'excluded' : hit.klass, reason: legit ? 'excluded:legitimate_duplicate' : hit.reason, session: hit.session,
      evidence: hit.evidence, fact_hash: factHash(row) });
  });
  candidates.sort((a, b) => a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug) || a.id - b.id);
  return { candidates, unclassifiable: classified.filter(c => c === 'unclassifiable').length, not_suspect: classified.filter(c => c === 'not_suspect').length };
}

function previewCommand(scope: RepairScope, all: string[], includeAmbiguous: boolean): string {
  const source = scope.source_ids.length === 1 && all.length > 1 ? ` --source ${scope.source_ids[0]}` : '';
  return `gbrain repair captured-facts${source}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

async function activeSources(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
}

function pageItem(page: CapturedFactsPage, hash: string, index: number, last: boolean): PageItem {
  return { cursor: { phase: 0, id: index }, source_id: page.source_id, slug: page.slug, chars: 0,
    action: `expire ${page.facts.length} captured fact(s)`, page, hash, last };
}

export const capturedFactsRepair: RepairHandler = {
  kind: 'captured-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    const command = previewCommand(scope, await activeSources(engine), includeAmbiguous);
    if (!opts?.apply) {
      const { candidates, unclassifiable, not_suspect } = await classifyCapturedFacts(engine, scope.source_ids);
      const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
      const hash = previewHash(['captured-facts-v1', brain?.brain_id ?? 'host', scope.source_ids, includeAmbiguous,
        candidates.map(c => [c.id, c.class, c.reason, c.fact_hash])]);
      const pages = new Map<string, CapturedFactsPage>();
      for (const fact of candidates) {
        if (fact.class === 'excluded' || (fact.class === 'ambiguous' && !includeAmbiguous)) continue;
        const key = `${fact.source_id}\u0000${fact.slug}`;
        const page = pages.get(key) ?? { source_id: fact.source_id, slug: fact.slug, include_ambiguous: includeAmbiguous, scope: scope.source_ids, facts: [] };
        page.facts.push(fact);
        pages.set(key, page);
      }
      const approved = [...pages.values()];
      if (approved.length) await saveApprovedSet(engine, { command: 'captured-facts', hash }, approved);
      const count = (klass: CapturedFactClass) => candidates.filter(c => c.class === klass).length;
      const listing: RepairListing[] = candidates.map(c => ({ item: `${c.source_id}:${c.slug}#${c.id}`,
        class: c.class === 'excluded' ? c.reason : c.class, detail: `${c.reason === 'paste_heuristic' ? 'paste candidate' : c.reason}; session ${c.session}; ${c.evidence}` }));
      return { items: approved.map((page, i) => pageItem(page, hash, i, i === approved.length - 1)), preview_hash: hash, listing,
        residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'), unclassifiable, not_suspect } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair captured-facts --apply expires only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<CapturedFactsPage>(engine, { command: 'captured-facts', hash: opts.expect, previewCommand: command });
    const scopeKey = JSON.stringify(scope.source_ids);
    if (approved.items.some(page => page.include_ambiguous !== includeAmbiguous || JSON.stringify(page.scope) !== scopeKey)) {
      throw previewChangedError(opts.expect, command);
    }
    const items = approved.items.map((page, i) => pageItem(page, opts.expect!, i, i === approved.items.length - 1))
      .filter(item => afterCursor(item.cursor, after));
    if (!items.length) await clearApprovedSet(engine, { command: 'captured-facts', hash: opts.expect });
    return { items, preview_hash: opts.expect, residuals: { approved_pages: approved.items.length, pending_pages: items.length } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as PageItem;
    const engine = ctx.engine;
    // Recheck each approved fact against its live row: same class, evidence and row.
    const live = new Map((await classifyCapturedFacts(engine, [page.source_id], { ids: page.facts.map(f => f.id) })).candidates.map(c => [c.id, c]));
    const unchanged = page.facts.filter(f => {
      const current = live.get(f.id);
      return !!current && (['class', 'reason', 'fact_hash', 'slug', 'row_num'] as const).every(field => current[field] === f[field]);
    });
    const expired: number[] = [];
    const dbOnly = unchanged.filter(f => f.row_num === null);
    if (dbOnly.length) expired.push(...await expireDatabaseRows(engine, page, hash, dbOnly.map(f => f.id)));
    const fenced = unchanged.filter(f => f.row_num !== null);
    if (fenced.length) expired.push(...await strikeFencedRows(ctx, entry, page, fenced));
    if (last) await clearApprovedSet(engine, { command: 'captured-facts', hash });
    const changed = page.facts.filter(f => !expired.includes(f.id)).map(f => f.id);
    return { applied: expired.length > 0, outcome: !changed.length ? 'expired' : expired.length ? 'partially_expired' : 'changed_since_preview',
      ...(changed.length ? { reason: `${expired.length} of ${page.facts.length} expired; changed since the preview: ${changed.join(', ')}` } : {}) };
  },
};

export const CAPTURED_FACTS_INTENT = 'managed_maintenance_expire_captured_facts';

const expireRows = (tx: BrainEngine, sourceId: string, ids: number[]) => tx.executeRaw<{ id: number | string }>(`UPDATE facts
    SET expired_at=now(), context=concat_ws(' | ', $3::text, NULLIF(context,''))
  WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL AND row_num IS NULL RETURNING id`, [sourceId, ids, EXPIRY_CONTEXT]);

/**
 * Database-only rows: on a managed brain one database-only maintenance
 * request on the page key (owner-checked, with a publication receipt); on an
 * unmanaged brain one transaction.
 */
async function expireDatabaseRows(engine: BrainEngine, page: CapturedFactsPage, hash: string, ids: number[]): Promise<number[]> {
  if (!await managedPersistenceEnabled(engine)) return (await engine.transaction(tx => expireRows(tx, page.source_id, ids))).map(row => Number(row.id));
  const authority = (await maintenancePreflight(engine, page.source_id))!;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  const h = digest(['captured-facts-expire-v1', hash, page.source_id, page.slug, ids, snapshot?.revision ?? null]);
  const receipt = await submitDatabaseMaintenanceIntent(engine, authority, page.slug,
    { kind: CAPTURED_FACTS_INTENT, expected_revision: snapshot?.revision ?? null, fact_ids: ids },
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
  return (receipt.expired as number[] | undefined) ?? [];
}

/** Preparer for `managed_maintenance_expire_captured_facts`: expires the named database-only rows of the source. */
export async function prepareCapturedFactsExpiry(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const ids = (row.intent as { fact_ids?: unknown } | null)?.fact_ids;
  if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id))) {
    throw opError('invalid_params', 'The captured facts expiry intent does not name its facts.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts to expire, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: readFix('Previews the captured-facts repair without changing anything.', { argv: ['gbrain', 'repair', 'captured-facts', '--source', row.source_id, '--json'] }) });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot?.revision ?? null, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => ({ status: 'completed', expired: (await expireRows(tx, row.source_id, ids as number[])).map(r => Number(r.id)) }) };
}

/**
 * Fenced rows: strike each still-matching fence row (no withdrawal marker) and
 * publish the page once, bound to the revision read; the canonical projection
 * expires the struck rows. Returns the facts that ended expired.
 */
async function strikeFencedRows(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, page: CapturedFactsPage, facts: CapturedFactCandidate[]): Promise<number[]> {
  const engine = ctx.engine;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  if (!snapshot) return [];
  const rows = await engine.executeRaw<{ id: number | string; fact: string; row_num: number }>(
    'SELECT id, fact, row_num FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL', [page.source_id, facts.map(f => f.id)]);
  const today = new Date().toISOString().slice(0, 10);
  const strike = (fact: ParsedFact): ParsedFact => ({ ...fact, active: false, forgotten: false, validUntil: fact.validUntil && fact.validUntil < today ? fact.validUntil : today,
    context: [EXPIRY_CONTEXT, fact.context?.trim()].filter(Boolean).join(' | ') });
  let body = snapshot.page.compiled_truth ?? '';
  const struck: number[] = [];
  for (const row of rows) {
    const fenceRow = parseFactsFence(body).facts.find(f => f.rowNum === Number(row.row_num));
    if (!fenceRow?.active || fenceRow.claim.trim() !== row.fact.trim()) continue;
    const next = strikeFenceRow(body, Number(row.row_num), strike);
    if (next === null) continue;
    body = next;
    struck.push(Number(row.id));
  }
  if (!struck.length) return [];
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'captured-facts', item, snapshot.revision) } });
  return (await engine.executeRaw<{ id: number | string }>('SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NOT NULL',
    [page.source_id, struck])).map(row => Number(row.id));
}
