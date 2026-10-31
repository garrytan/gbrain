/**
 * `gbrain repair secret-spans` (GST-327): replace the credentials the secret
 * scanner finds in the database copies of named pages with `<REDACTED:rule>`
 * markers, and change nothing else. The text change and its proof are
 * `redactFields` (secret-spans.ts, pure): every field of one page is planned
 * against one shared echo dictionary, and a page with a field whose independent
 * splice and `applyRedaction` disagree is refused (`proof_failed`).
 *
 * The copies of a page: its title, the string leaves of its frontmatter (keys
 * are never touched), its body (inline columns, or the live generation of a
 * segmented body, restaged and flipped), its timeline rows (page or event
 * page), the fact rows it holds or that name it with no holding page, its take
 * rows, its outgoing link contexts and the string leaves of its raw data (an
 * ontology fact's resolved value is scanned, and a match refuses the page). Chunk
 * rows that hold a value are deleted and the projection is rebuilt from the
 * redacted body (vectors of unchanged chunk texts are kept); derivation rows and
 * view digests that may hold one are deleted. Fact and take vectors of a
 * rewritten row are cleared. History is kept: page versions, retained segmented
 * generations, write receipts and Git are not rewritten, and the preview counts
 * the retained versions.
 *
 * Nothing is published: no journal admission, no Git effect, no file write, and
 * a sync hold on the page stays as it is, so a held page is redacted where it is
 * stored. One transaction per page under its key lock, a coordinated
 * maintenance write on a managed brain and an attributed maintenance
 * transaction otherwise (repo-less brains included); trust tiers are kept (a
 * redaction is not authorship). Each page's value-free receipt (field hashes and
 * span offsets) is written in the same transaction and appended to the
 * `secret-spans` audit log.
 *
 * Explicit-only, preview-bound and trusted-local-CLI-only: the preview needs
 * `--source` and at least one `--slug`, lists each page's spans by rule and
 * every changed field's old and new SHA-256 under a hash, and writes nothing but
 * the approval checkpoint. `--apply --expect <hash>` rechecks every page
 * before writing (`preview_changed`) and again under its lock
 * (`changed_since_preview`), then re-scans what it wrote.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { digest } from '../persistence/digest.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { withCoordinatedWrite, withTrustKeep, withWriteAttribution } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { applySegmentedBody, sealSegmentedPage } from '../persistence/segmented-apply.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { materializeSegmentedBody, prepareSegmentedBody } from '../page-body/ingest.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { buildSegmentedProjection } from '../page-body/projection.ts';
import { queuePageProjection, resealSafeChunks } from '../page-state/projections.ts';
import { embedStalePages } from '../embed-stale.ts';
import { isQuarantined } from '../quarantine.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { contentHash } from '../utils.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { redactFields, residualMatches, resolveSecretRules, spanCounts, type FieldRedaction, type SecretRuleSet } from '../secret-spans.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#secret-spans';
export const SECRET_SPANS_RECEIPT_OP = 'secret-spans-receipt';

type Json = Record<string, unknown>;
type LeafPath = Array<string | number>;
type Store = 'page' | 'frontmatter' | 'timeline_entries' | 'facts' | 'takes' | 'links' | 'raw_data';

/** One stored text of a page: where it lives and its current value. */
interface Field { key: string; text: string; store: Store; id?: number; column?: string; path?: LeafPath }

interface PageRow {
  id: number; source_id: string; slug: string; title: string; type: string; page_kind: string; frontmatter: Json | null;
  compiled_truth: string | null; timeline: string | null; body_storage: string; body_bytes: number | string | null; generation: string;
  body_flags: Json | null; revision: string; contextual_retrieval_mode: string | null; corpus_generation: string | null; tags: string[];
}

type Refusal = 'page_not_found' | 'page_kind_unsupported' | 'page_too_large';
type PlanRefusal = 'proof_failed' | 'fact_value_unsupported' | 'timeline_rows_collide';
/** `text`: the body's truth and timeline regions as stored (inline columns, or a segmented body read in full). */
interface Read { page: PageRow; fields: Field[]; text: { truth: string; tail: string } }
interface Planned { read: Read; results: FieldRedaction[]; digest: string }

interface Selection { source_ids: string[]; slugs: string[]; rules: string[] }
/** `old_fp` / `new_fp`: the first 64 bits of the field's SHA-256, so a field that is only a short value is not printed as its full hash. */
interface FieldSummary { key: string; spans: number; old_fp: string; new_fp: string; spans_sha256: string }
interface PlannedPage {
  source_id: string; slug: string; id: number; revision: string; generation: string; storage: string; digest: string;
  rules: Record<string, number>; echo: number; fields: FieldSummary[]; versions: number;
}
interface SpanItem extends RepairItem { page: PlannedPage; hash: string; rules: string[]; last: boolean }

const REFUSAL_TEXT: Record<Refusal | PlanRefusal, string> = {
  page_not_found: 'no live page with this slug in the source',
  page_kind_unsupported: 'only markdown pages are redacted here (code and image pages index the file itself)',
  page_too_large: `the segmented body is over the ${PAGE_MAX_BYTES / 1024 ** 2} MiB single-string ceiling this repair reads`,
  proof_failed: 'the planned spans and the scanner\'s own redaction disagree, so nothing on the page is rewritten',
  fact_value_unsupported: 'an ontology fact\'s resolved value holds a match; its value_hash keys the fact\'s dedup, so this repair does not rewrite it (retire the fact with gbrain forget, then preview again)',
  timeline_rows_collide: 'two timeline rows of one day would read the same once redacted, which their dedup key refuses; delete the duplicate row, then preview again',
};

function previewCommand(selection: Selection): string {
  return `gbrain repair secret-spans --source ${selection.source_ids[0]}${selection.slugs.map(slug => ` --slug ${slug}`).join('')}`
    + (selection.rules.join(',') === resolveSecretRules().rules.join(',') ? '' : ` --rules ${selection.rules.join(',')}`);
}

const pointer = (path: LeafPath) => path.map(part => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** Every string leaf of a JSON value with its path, keys in sorted order. */
function leaves(value: unknown, path: LeafPath = []): Array<{ path: LeafPath; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => leaves(entry, [...path, index]));
  if (value && typeof value === 'object') return Object.keys(value).sort().flatMap(key => leaves((value as Json)[key], [...path, key]));
  return [];
}

/** A copy of `root` with the string leaf at `path` replaced. */
function withLeaf<T>(root: T, path: LeafPath, text: string): T {
  if (!path.length) return text as T;
  const copy = (Array.isArray(root) ? [...root] : { ...(root as Json) }) as Json;
  const [head, ...rest] = path;
  copy[head as string] = withLeaf(copy[head as string], rest, text);
  return copy as T;
}

const PAGE_SQL = `SELECT p.id,p.source_id,p.slug,p.title,p.type,p.page_kind,p.frontmatter,p.compiled_truth,p.timeline,p.body_storage,p.body_bytes,
    COALESCE(p.body_generation,0)::text AS generation,p.body_flags,p.knowledge_revision::text AS revision,p.contextual_retrieval_mode,p.corpus_generation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags
  FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`;

/** Every stored text of one live page, in a stable order, or why the page is not redacted here. */
async function readFields(engine: BrainEngine, sourceId: string, slug: string): Promise<Read | Refusal> {
  const [page] = await engine.executeRaw<PageRow>(PAGE_SQL, [sourceId, slug]);
  if (!page) return 'page_not_found';
  if (page.page_kind !== 'markdown') return 'page_kind_unsupported';
  const id = Number(page.id);
  let text = { truth: page.compiled_truth ?? '', tail: page.timeline ?? '' };
  if (page.body_storage === 'segmented') {
    if (Number(page.body_bytes ?? 0) > PAGE_MAX_BYTES) return 'page_too_large';
    const stored = await materializeSegmentedBody(engine, id, sourceId);
    text = { truth: stored.compiled_truth, tail: stored.timeline };
  }
  const fields: Field[] = [
    { key: 'title', text: page.title ?? '', store: 'page', column: 'title' },
    ...leaves(page.frontmatter ?? {}).map(leaf => ({ key: `frontmatter${pointer(leaf.path)}`, text: leaf.text, store: 'frontmatter' as const, path: leaf.path })),
    { key: 'compiled_truth', text: text.truth, store: 'page', column: 'compiled_truth' },
    { key: 'timeline', text: text.tail, store: 'page', column: 'timeline' },
  ];
  const rows = (store: Store, columns: string[], list: Array<Record<string, unknown>>) => {
    for (const row of list) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === 'string' && value) fields.push({ key: `${store}/${row.id}/${column}`, text: value, store, id: Number(row.id), column });
      }
    }
  };
  rows('timeline_entries', ['summary', 'detail', 'source'], await engine.executeRaw(
    'SELECT id,summary,detail,source FROM timeline_entries WHERE page_id=$1 OR event_page_id=$1 ORDER BY id', [id]));
  rows('facts', ['fact', 'context', 'value'], await engine.executeRaw(`SELECT id,fact,context,value FROM facts
    WHERE source_id=$1 AND (source_markdown_slug=$2 OR (source_markdown_slug IS NULL AND entity_slug=$2)) ORDER BY id`, [sourceId, slug]));
  rows('takes', ['claim', 'source', 'resolved_source'], await engine.executeRaw('SELECT id,claim,source,resolved_source FROM takes WHERE page_id=$1 ORDER BY id', [id]));
  rows('links', ['context'], await engine.executeRaw('SELECT id,context FROM links WHERE from_page_id=$1 ORDER BY id', [id]));
  for (const row of await engine.executeRaw<{ id: number; data: unknown }>('SELECT id,data FROM raw_data WHERE page_id=$1 ORDER BY id', [id])) {
    for (const leaf of leaves(row.data)) fields.push({ key: `raw_data/${row.id}/data${pointer(leaf.path)}`, text: leaf.text, store: 'raw_data', id: Number(row.id), path: leaf.path });
  }
  return { page: { ...page, id }, fields, text };
}

/** The page's redaction and the digest the plan hash binds: identity, revision, generation and every field's old text and spans. */
function planPage(read: Read, rules: SecretRuleSet): Planned {
  const results = redactFields(read.fields, rules);
  const { page } = read;
  return { read, results, digest: digest(['secret-spans-page-v1', page.id, page.revision, page.generation,
    results.map(result => [result.key, result.old_sha256, result.spans_sha256])]) };
}

/**
 * Why a planned page cannot be rewritten as planned, or null. A timeline row's dedup key (page, date, summary, source)
 * is checked against every row of the pages its rows belong to, because the event-page rows sit on other pages.
 */
async function planRefusal(engine: BrainEngine, planned: Planned): Promise<PlanRefusal | null> {
  if (planned.results.some(result => !result.proven)) return 'proof_failed';
  const changed = changedOf(planned);
  if (changed.some(result => /^facts\/\d+\/value$/.test(result.key))) return 'fact_value_unsupported';
  if (!changed.some(result => result.key.startsWith('timeline_entries/'))) return null;
  const next = new Map(planned.results.map(result => [result.key, result.next]));
  const rows = await engine.executeRaw<{ id: number | string; page_id: number | string; date: string; summary: string; source: string }>(`SELECT id,page_id,date::text AS date,summary,source
    FROM timeline_entries WHERE page_id IN (SELECT page_id FROM timeline_entries WHERE page_id=$1 OR event_page_id=$1)`, [planned.read.page.id]);
  const keys = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([String(row.page_id), row.date, next.get(`timeline_entries/${row.id}/summary`) ?? row.summary, next.get(`timeline_entries/${row.id}/source`) ?? row.source]);
    if (keys.has(key)) return 'timeline_rows_collide';
    keys.add(key);
  }
  return null;
}

const changedOf = (planned: Planned) => planned.results.filter(result => result.spans.length);

function summaryOf(planned: Planned, versions: number): PlannedPage {
  const { page } = planned.read;
  const changed = changedOf(planned);
  const counts = spanCounts(changed.flatMap(result => result.spans));
  return { source_id: page.source_id, slug: page.slug, id: page.id, revision: page.revision, generation: page.generation, storage: page.body_storage,
    digest: planned.digest, rules: counts.rules, echo: counts.echo, versions,
    fields: changed.map(result => ({ key: result.key, spans: result.spans.length, old_fp: result.old_sha256.slice(0, 16), new_fp: result.new_sha256.slice(0, 16), spans_sha256: result.spans_sha256 })) };
}

const ruleText = (rules: Record<string, number>) => Object.entries(rules).sort().map(([rule, n]) => `${rule}=${n}`).join(', ');
const spansOf = (page: PlannedPage) => page.fields.reduce((n, field) => n + field.spans, 0);

function changeDetail(page: PlannedPage): string {
  return `${spansOf(page)} span(s) in ${page.fields.length} field(s): ${ruleText(page.rules)}${page.echo ? ` (${page.echo} echo)` : ''}`
    + `; ${page.versions} retained version(s) kept`;
}

/** The secret values of one page's spans, kept in memory only: chunk and derivation rows holding one are deleted. */
function valuesOf(planned: Planned): string[] {
  const values = new Set<string>();
  planned.results.forEach((result, index) => {
    for (const span of result.spans) values.add(planned.read.fields[index]!.text.slice(span.start, span.end));
  });
  return [...values];
}

async function* once(text: string): AsyncIterable<Uint8Array> { if (text) yield Buffer.from(text, 'utf8'); }

const receiptKey = (hash: string, pageId: number) => `${hash}:${pageId}`;
const audit = createAuditWriter<{ ts: string } & Json>({ featureName: 'secret-spans', errorLabel: 'secret-spans-audit', errorTrailer: '; repair continues' });

/** Rewrites one page's changed fields in the caller's transaction; `unsealed`: a segmented body whose projection is built after commit. */
async function writePage(tx: BrainEngine, planned: Planned): Promise<{ unsealed: boolean }> {
  const { page, text } = planned.read;
  const fieldOf = (index: number) => planned.read.fields[index]!;
  const next = new Map(planned.results.map(result => [result.key, result.next]));
  let frontmatter: Json = page.frontmatter ?? {};
  planned.results.forEach((result, index) => {
    const field = fieldOf(index);
    if (field.store === 'frontmatter' && result.spans.length) frontmatter = withLeaf(frontmatter, field.path!, result.next);
  });
  const title = next.get('title') ?? page.title, compiled = next.get('compiled_truth') ?? text.truth, timeline = next.get('timeline') ?? text.tail;
  const pageChanged = planned.results.some((result, index) => result.spans.length > 0 && (fieldOf(index).store === 'page' || fieldOf(index).store === 'frontmatter'));
  let unsealed = false;
  if (pageChanged && page.body_storage === 'segmented') {
    const { principal } = await maintenanceAttribution(tx);
    const prepared = await prepareSegmentedBody(tx, { sourceId: page.source_id, slug: page.slug, title, type: page.type, frontmatter, tags: page.tags,
      live: { id: page.id, generation: Number(page.generation), storage: 'segmented', title: page.title, type: page.type, flags: page.body_flags },
      truth: once(compiled), timeline: once(timeline), hasTimeline: timeline.length > 0, flags: page.body_flags ?? {},
      declaredBytes: Buffer.byteLength(compiled, 'utf8') + Buffer.byteLength(timeline, 'utf8'),
      owner: { kind: 'edit', principalKind: principal.kind, principalId: principal.id, baseRevision: null },
      chunking: { quarantined: isQuarantined(frontmatter), ...(page.contextual_retrieval_mode === 'title'
        ? { tier: 'title' as const, corpusGeneration: page.corpus_generation } : { tier: 'none' as const, corpusGeneration: null }) } });
    const { flipRetireMaxRows } = await readPageBodyPolicy(tx);
    const applied = await withPageTierKept(tx, { sourceId: page.source_id, slug: page.slug }, () => applySegmentedBody(tx, { slug: page.slug, sourceId: page.source_id,
      pageId: page.id, prepared, promotion: false, retireMaxRows: flipRetireMaxRows,
      meta: { title, type: page.type as never, frontmatter, page_kind: page.page_kind as never } }));
    if (applied.complete) await sealSegmentedPage(tx, page.id);
    else unsealed = true;
  } else if (pageChanged) {
    await tx.executeRaw('UPDATE pages SET title=$2,frontmatter=$3::text::jsonb,compiled_truth=$4,timeline=$5,content_hash=$6,updated_at=now() WHERE id=$1',
      [page.id, title, JSON.stringify(frontmatter), compiled, timeline, contentHash({ title, type: page.type, compiled_truth: compiled, timeline, frontmatter, tags: page.tags } as never)]);
  }
  const rawData = new Map<number, unknown>();
  for (const [index, result] of planned.results.entries()) {
    const field = fieldOf(index);
    if (!result.spans.length || field.store === 'page' || field.store === 'frontmatter') continue;
    if (field.store === 'raw_data') {
      if (!rawData.has(field.id!)) rawData.set(field.id!, (await tx.executeRaw<{ data: unknown }>('SELECT data FROM raw_data WHERE id=$1', [field.id]))[0]?.data);
      rawData.set(field.id!, withLeaf(rawData.get(field.id!), field.path!, result.next));
      continue;
    }
    const vectors = field.store === 'facts' || field.store === 'takes' ? ',embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL' : '';
    await tx.executeRaw(`UPDATE ${field.store} SET ${field.column}=$2${vectors}${field.store === 'takes' ? ',updated_at=now()' : ''} WHERE id=$1`, [field.id, result.next]);
  }
  for (const [id, data] of rawData) await tx.executeRaw('UPDATE raw_data SET data=$2::text::jsonb WHERE id=$1', [id, JSON.stringify(data)]);
  if (!pageChanged) {
    // Rows alone changed: a new revision tells caches and projections the page's knowledge moved.
    await tx.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [page.id]);
    if (page.body_storage === 'segmented') await sealSegmentedPage(tx, page.id);
  }
  // Rows holding a value are matched here, never in SQL, so no secret is ever sent as a statement parameter (which a
  // server's slow-statement log would keep).
  const values = valuesOf(planned);
  const holds = (text: string | null | undefined) => !!text && values.some(value => text.includes(value));
  if (page.body_storage !== 'segmented') {
    const chunks = await tx.executeRaw<{ id: number | string; chunk_text: string; doc_comment: string | null }>(
      'SELECT id,chunk_text,doc_comment FROM content_chunks WHERE page_id=$1 -- chunk-visibility-ok: every stored row of the page is checked for a value', [page.id]);
    const doomed = chunks.filter(chunk => holds(chunk.chunk_text) || holds(chunk.doc_comment)).map(chunk => Number(chunk.id));
    if (doomed.length) await tx.executeRaw('DELETE FROM content_chunks WHERE id=ANY($1::int[])', [doomed]);
    await queuePageProjection(tx, page.source_id, page.slug, 'secret_spans');
  }
  const derivations = await tx.executeRaw<{ pipeline: string; occurrence_id: number | string; output: unknown }>(
    'SELECT pipeline,occurrence_id,output FROM page_segment_derivations WHERE page_id=$1 AND output IS NOT NULL', [page.id]);
  for (const row of derivations.filter(row => leaves(row.output).some(leaf => holds(leaf.text)))) {
    await tx.executeRaw('DELETE FROM page_segment_derivations WHERE page_id=$1 AND pipeline=$2 AND occurrence_id=$3', [page.id, row.pipeline, row.occurrence_id]);
  }
  await tx.executeRaw('DELETE FROM page_view_digests WHERE page_id=$1', [page.id]);
  return { unsealed };
}

interface Residual { total: number; rules: Record<string, number>; stores: Record<string, number> }

/** Matches of the selected rules still stored for the page, by rule and by store (chunks and derivations included). */
async function residualScan(engine: BrainEngine, sourceId: string, slug: string, rules: SecretRuleSet): Promise<Residual> {
  const out: Residual = { total: 0, rules: {}, stores: {} };
  const add = (store: string, text: string) => {
    for (const [rule, n] of Object.entries(residualMatches(text, rules))) {
      out.total += n; out.rules[rule] = (out.rules[rule] ?? 0) + n; out.stores[store] = (out.stores[store] ?? 0) + n;
    }
  };
  const read = await readFields(engine, sourceId, slug);
  if (typeof read === 'string') return out;
  for (const field of read.fields) add(field.store, field.text);
  for (const row of await engine.executeRaw<{ chunk_text: string; doc_comment: string | null }>(
    'SELECT chunk_text,doc_comment FROM content_chunks WHERE page_id=$1 -- chunk-visibility-ok: the residual scan reads every stored chunk row, staged and retired included', [read.page.id])) add('content_chunks', `${row.chunk_text}\n${row.doc_comment ?? ''}`);
  for (const row of await engine.executeRaw<{ output: unknown }>('SELECT output FROM page_segment_derivations WHERE page_id=$1 AND output IS NOT NULL', [read.page.id])) {
    for (const leaf of leaves(row.output)) add('page_segment_derivations', leaf.text);
  }
  return out;
}

const sourcesOf = (engine: BrainEngine, selection: Selection) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [selection.source_ids]);

const hashOf = async (engine: BrainEngine, scope: RepairScope, selection: Selection, pages: PlannedPage[]) =>
  previewHash({ kind: 'secret-spans-v1', brain_id: scope.brain_id, sources: await sourcesOf(engine, selection), selection,
    pages: pages.map(page => ({ id: page.id, slug: page.slug, revision: page.revision, generation: page.generation, digest: page.digest })) });

/** Pages already redacted under `hash` (a resumed apply), by page id. */
async function receiptsOf(engine: BrainEngine, hash: string, pages: readonly PlannedPage[]): Promise<Set<number>> {
  const rows = await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])',
    [SECRET_SPANS_RECEIPT_OP, pages.map(page => receiptKey(hash, page.id))]);
  return new Set(rows.map(row => Number(row.fingerprint.slice(hash.length + 1))));
}

function selectionOf(scope: RepairScope, slugs: readonly string[] | undefined, rules: readonly string[] | undefined): Selection {
  if (scope.source_ids.length !== 1) {
    throw new OperationError('invalid_params', 'gbrain repair secret-spans redacts pages of one source; name it with --source.',
      'Pass --source with the source id and one --slug per page to preview; gbrain sources list shows the source ids.', DOCS);
  }
  const selected = [...new Set((slugs ?? []).map(slug => slug.trim()).filter(Boolean))].sort();
  if (!selected.length) {
    throw new OperationError('invalid_params', 'gbrain repair secret-spans redacts only the pages you name; pass --slug <slug> (repeatable).',
      `Add one --slug per page to gbrain repair secret-spans --source ${scope.source_ids[0]}, then preview.`, DOCS);
  }
  return { source_ids: scope.source_ids, slugs: selected, rules: resolveSecretRules(rules).rules };
}

function item(page: PlannedPage, hash: string, rules: string[], last: boolean): SpanItem {
  return { cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug, chars: 0, action: changeDetail(page), page, hash, rules, last };
}

export const secretSpansRepair: RepairHandler = {
  kind: 'secret-spans',
  publication: 'projection',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote !== false) throw trustedCliRequired('gbrain repair secret-spans reads and rewrites stored credentials, so it runs only from the trusted local CLI on the brain host.');
    if (!opts.apply && !opts.slugs?.length) {
      return { items: [], residuals: { pages_to_redact: 0, spans: 0, clean: 0, refused: 0, retained_versions: 0 },
        warnings: ['No page named, so nothing was read. Preview the pages to redact: gbrain repair secret-spans --source <id> --slug <slug>... (repeatable).'] };
    }
    const selection = selectionOf(scope, opts.slugs, opts.rules);
    const rules = resolveSecretRules(selection.rules);
    const command = previewCommand(selection);
    const sourceId = selection.source_ids[0]!;
    if (!opts.apply) {
      const planned: PlannedPage[] = [];
      const listing: RepairListing[] = [];
      const residuals: Record<string, number> = { pages_to_redact: 0, spans: 0, clean: 0, refused: 0, retained_versions: 0 };
      for (const slug of selection.slugs) {
        const read = await readFields(engine, sourceId, slug);
        if (typeof read === 'string') {
          residuals.refused!++;
          listing.push({ item: `${sourceId}:${slug}`, class: 'refused', detail: `${read}: ${REFUSAL_TEXT[read]}` });
          continue;
        }
        const plan = planPage(read, rules);
        const label = `${sourceId}:${slug} (revision ${read.page.revision})`;
        const refusal = await planRefusal(engine, plan);
        if (refusal) {
          residuals.refused!++;
          listing.push({ item: label, class: 'refused', detail: `${refusal}: ${REFUSAL_TEXT[refusal]}` });
          continue;
        }
        if (!changedOf(plan).length) { residuals.clean!++; continue; }
        const [versions] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [read.page.id]);
        const page = summaryOf(plan, Number(versions?.n ?? 0));
        planned.push(page);
        residuals.pages_to_redact!++;
        residuals.spans! += spansOf(page);
        residuals.retained_versions! += page.versions;
        listing.push({ item: label, class: 'redact', detail: changeDetail(page) });
      }
      // Items run in cursor (page id) order, so a resumed apply after --limit or a stop continues with the rest.
      planned.sort((a, b) => a.id - b.id);
      const hash = await hashOf(engine, scope, selection, planned);
      if (planned.length) await saveApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'secret-spans', hash }, planned.map(page => ({ ...page, selection })));
      return { items: planned.map((page, index) => item(page, hash, selection.rules, index === planned.length - 1)), preview_hash: hash, residuals, listing,
        details: { rules: selection.rules, pages: planned } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair secret-spans --apply redacts only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash>`, DOCS);
    }
    const expect = opts.expect;
    const approved = (await loadApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'secret-spans', hash: expect, previewCommand: command,
      emptyHash: () => hashOf(engine, scope, selection, []) })).items;
    if (approved.some(page => digest(page.selection) !== digest(selection))) throw previewChangedError(expect, command);
    const pages = approved.map(({ selection: _selection, ...page }) => page);
    const done = await receiptsOf(engine, expect, pages);
    // Every page not yet redacted under this hash still holds exactly what the user saw, or nothing is written.
    for (const page of pages) {
      if (done.has(page.id)) continue;
      const read = await readFields(engine, page.source_id, page.slug);
      if (typeof read === 'string' || read.page.id !== page.id || planPage(read, rules).digest !== page.digest) throw previewChangedError(expect, command);
    }
    return { items: pages.map((page, index) => item(page, expect, selection.rules, index === pages.length - 1)).filter(entry => afterCursor(entry.cursor, after)),
      preview_hash: expect, residuals: {} };
  },
  async apply(ctx, entry, opts): Promise<RepairItemOutcome> {
    if (ctx.remote !== false) throw trustedCliRequired('gbrain repair secret-spans runs only from the trusted local CLI on the brain host.');
    const { page, hash, last } = entry as SpanItem;
    const rules = resolveSecretRules((entry as SpanItem).rules);
    const detail = { spans: spansOf(page), fields: page.fields.length, rules: ruleText(page.rules) };
    try {
      if ((await receiptsOf(ctx.engine, hash, [page])).has(page.id)) return { applied: true, outcome: 'redacted', detail };
      const written = await ctx.engine.transaction(async tx => {
        const managed = await readManagedMode(tx, { refusal: { subject: 'repair secret-spans' } });
        const attribution = await maintenanceAttribution(tx);
        const write = () => withTrustKeep(tx, ['pages', 'facts', 'takes', 'timeline_entries'], async () => {
          await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
          const read = await readFields(tx, page.source_id, page.slug);
          if (typeof read === 'string') return { refused: read };
          const planned = planPage(read, rules);
          if (read.page.id !== page.id || planned.digest !== page.digest) return { refused: 'changed_since_preview' };
          const refusal = await planRefusal(tx, planned);
          if (refusal) return { refused: refusal };
          const { unsealed } = await writePage(tx, planned);
          const [after] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [page.id]);
          const receipt = { kind: 'secret-spans', hash, source_id: page.source_id, slug: page.slug, page_id: page.id, revision_before: page.revision,
            revision_after: after?.revision ?? null, rules: rules.rules, fields: changedOf(planned).map(result => ({ key: result.key, old_fp: result.old_sha256.slice(0, 16),
              new_fp: result.new_sha256.slice(0, 16), spans_sha256: result.spans_sha256, spans: result.spans.map(span => [span.start, span.end, span.rule, span.echo ? 1 : 0]) })) };
          await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES ($1,$2,$3::text::jsonb,now())
            ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
          [SECRET_SPANS_RECEIPT_OP, receiptKey(hash, page.id), JSON.stringify([receipt])]);
          return { receipt, unsealed, embedSkip: !!(read.page.frontmatter ?? {}).embed_skip };
        });
        return managed ? withCoordinatedWrite(tx, [page.source_id], write, attribution) : withWriteAttribution(tx, attribution, write);
      });
      if ('refused' in written) {
        return { applied: false, outcome: 'changed_since_preview', reason: written.refused === 'changed_since_preview' ? 'the page changed since the preview' : written.refused };
      }
      audit.log(written.receipt);
      let projection = 'sealed';
      try {
        if (page.storage !== 'segmented') await resealSafeChunks(ctx.engine, page.slug, page.source_id);
        else if (written.unsealed) await buildSegmentedProjection(ctx.engine, { sourceId: page.source_id, slug: page.slug });
      } catch { projection = 'queued'; }
      const embedded = opts?.embed && !written.embedSkip
        ? (await embedStalePages(ctx.engine, [page.slug], page.source_id).catch(() => ({ embedded: 0 }))).embedded : 0;
      const residual = await residualScan(ctx.engine, page.source_id, page.slug, rules);
      return { applied: true, outcome: 'redacted', detail: { ...detail, projection, embedded, residual: residual.total,
        ...(residual.total ? { residual_rules: ruleText(residual.rules), residual_stores: ruleText(residual.stores) } : {}) } };
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'secret-spans', hash });
    }
  },
  render(details) {
    return ((details.pages ?? []) as PlannedPage[]).flatMap(page => [`  ${page.source_id}:${page.slug} (${page.storage}): ${changeDetail(page)}`,
      ...page.fields.map(field => `    ${field.key}: ${field.spans} span(s), sha256 ${field.old_fp} -> ${field.new_fp}, spans ${field.spans_sha256.slice(0, 12)}`)]);
  },
  async report(ctx, scope, result, opts) {
    if (result.mode !== 'apply' || !opts.slugs?.length || scope.source_ids.length !== 1) return {};
    const rules = resolveSecretRules(opts.rules);
    const byRule: Record<string, number> = {};
    let total = 0;
    const slugs = [...new Set(opts.slugs)].sort();
    for (const slug of slugs) {
      const scan = await residualScan(ctx.engine, scope.source_ids[0]!, slug, rules);
      total += scan.total;
      for (const [rule, n] of Object.entries(scan.rules)) byRule[rule] = (byRule[rule] ?? 0) + n;
    }
    return { verification: { rescanned_pages: slugs.length, residual_matches: total, residual_by_rule: byRule } };
  },
};
