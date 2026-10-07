import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { writerLintForPutPage } from '../output/post-write.ts';
import type { WriteRequest } from './model.ts';
import type { TimelineRowsRemoved } from './canonical-projections.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { prepareFactsBackstop } from './effect-facts.ts';
import { lineGrammarOptions, parseLineGrammar } from '../line-grammar.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { findSimilarPages } from '../similar-pages.ts';
import { isQuarantined } from '../quarantine.ts';
import { readFix } from '../ops/op-fix.ts';

const LINE_GRAMMAR_FINDINGS_MAX = 5;

/**
 * On a create: existing pages in the same source that this one probably
 * duplicates (same title or alias, same name elsewhere, very similar title).
 * A question for the writer, never a merge; slugs only.
 */
async function similarPagesAdvisory(engine: BrainEngine, row: WriteRequest, page: ParsedPage): Promise<Record<string, unknown> | undefined> {
  if (!['put_page', 'capture'].includes(row.operation) || row.page_id != null || row.slug.startsWith('wiki/agents/')
    || page.frontmatter?.dream_generated === true || (page.type as string) === 'extract_receipt' || isQuarantined(page.frontmatter)) return undefined;
  const found = await findSimilarPages(engine, { sourceId: row.source_id, slug: row.slug, title: page.title ?? '',
    excludePrivate: row.authority.excludePrivate ?? row.authority.remote });
  if (!found?.candidates.length) return undefined;
  const first = found.candidates[0];
  return {
    candidates: found.candidates,
    checks_ran: found.checks_ran,
    semantic: 'not_checked',
    message: `This new page looks like ${found.candidates.length === 1 ? 'an existing page' : 'existing pages'} (${found.candidates.map(c => `${c.slug}: ${c.evidence}`).join(', ')}). If it is the same thing, move this content into that page with edit_page and delete this one; if it is different, keep both.`,
    fix: readFix(`Shows existing page ${first.slug} in source ${first.source_id} so you can compare it with the new page, read-only.`,
      { argv: ['gbrain', 'get', '--source', first.source_id, '--', first.slug], mcp: { tool: 'get_page', arguments: { slug: first.slug, source_id: first.source_id } } }),
  };
}

/**
 * What the line grammar read from this page body: typed relation lines and
 * fact lines, with every near-miss explained. Absent when the page has none.
 * Relations are stored with the page's links (or by the next sweep for a
 * remote writer); fact lines stay page text and are not added to `facts`.
 */
async function lineGrammarAdvisory(engine: BrainEngine, row: WriteRequest, page: ParsedPage): Promise<Record<string, unknown> | undefined> {
  // Declared-type gating only turns relations into findings, so a body with nothing to read needs no config or pack reads.
  const ungated = parseLineGrammar(page.compiled_truth);
  if (!ungated.relations.length && !ungated.facts.length && !ungated.diagnostics.length) return undefined;
  const options = await lineGrammarOptions(engine);
  if (!options.enabled) return undefined;
  const pack = options.allowUndeclaredTypes ? null : (await loadActivePackForLocalEngine(engine, { sourceId: row.source_id }))?.manifest ?? null;
  const declaredTypes = pack?.link_types.length ? new Set(pack.link_types.map(lt => lt.name)) : null;
  const parsed = parseLineGrammar(page.compiled_truth, { declaredTypes });
  if (!parsed.relations.length && !parsed.facts.length && !parsed.diagnostics.length) return undefined;
  const relationsState = !(await isAutoLinkEnabled(engine)) ? 'auto_link_disabled'
    : row.authority.remote && !row.authority.autoLinkTrusted ? 'pending_sweep' : 'stored';
  return {
    relations: parsed.relations.length,
    relations_state: relationsState,
    facts: parsed.facts.length,
    ...(parsed.facts.length ? { facts_state: 'page_text_only',
      facts_message: 'Fact lines are searchable page text; they are not added to recall facts. Use remember (or the page ## Facts table) for a fact recall must return.' } : {}),
    findings: parsed.diagnostics.slice(0, LINE_GRAMMAR_FINDINGS_MAX).map(d => ({ severity: 'warning', validator: 'line-grammar',
      line: d.line, reason: d.reason, text: d.text, message: d.message })),
    total: parsed.diagnostics.length,
    details_truncated: parsed.diagnostics.length > LINE_GRAMMAR_FINDINGS_MAX,
  };
}

const LINT_MESSAGES: Record<string,string> = { citation:'Paragraph has no citation marker.',
  link:'A link target is unavailable.', 'back-link':'A reverse link is missing.', 'triple-hr':'An ambiguous timeline separator was found.' };

/**
 * #5969: the timeline rows this write deleted (rows whose bullets the new body dropped). Dates only:
 * page-write receipts never carry stored text.
 */
export function timelineRowsRemovedAdvisory(row: WriteRequest, removed: TimelineRowsRemoved): Record<string, unknown> {
  return { ...removed,
    warning: `This write deleted ${removed.count} timeline row(s) of ${row.slug} dated ${removed.earliest}${removed.latest !== removed.earliest ? ` to ${removed.latest}` : ''}, because the content dropped their bullets.`,
    fix: readFix(`Lists ${row.slug}'s recent versions, read-only. If the rows were removed by mistake, revert_version with the id of the version before this write restores them (as new rows).`,
      { mcp: { tool: 'get_versions', arguments: { slug: row.slug, limit: 5, include_body: false } } }) };
}

export function remoteLinkHint(row: WriteRequest): Record<string, unknown> {
  return row.authority.remote && !row.authority.autoLinkTrusted ? { auto_links: { skipped: 'remote',
    hint: 'Body wikilinks are saved as text but NOT reconciled into the graph inline. With mention_links: queued, a post-commit `links` effect (listed by get_write_request) adds plain mention edges to existing pages this connection can read; typed and frontmatter edges are not added. A stdio `gbrain serve` sweeps them at startup + on idle; `gbrain serve --http` does not self-sweep — run `gbrain sweep --once` (delegates to a live serve over IPC), use trusted local capture/put_page for inline link extraction, or add_link for edges needed now.' } } : {};
}
export function pageNoopAdvisories(row: WriteRequest): Record<string, unknown> {
  return { ...remoteLinkHint(row), ...(['put_page', 'capture', 'edit_page'].includes(row.operation) ? { facts_backstop: { skipped: 'not_imported' } } : {}) };
}
/** Optional lint reads are outside publication locks; its bounded result is retained in the receipt. */
export async function preparePageAdvisories(engine: BrainEngine, row: WriteRequest, page: ParsedPage, before: PageSnapshot | null = null) {
  const visible = row.authority.remote ? { ...page, compiled_truth: sanitizeRemoteBody(page.compiled_truth),
    timeline: sanitizeRemoteBody(page.timeline ?? '') } : page;
  const lint = await writerLintForPutPage(engine, row.slug, { sourceId: row.source_id, noLog: true, page: visible });
  const sanitized = lint && 'top_findings' in lint ? { ...lint,
    top_findings: lint.top_findings.map(finding => ({ ...finding, message: LINT_MESSAGES[finding.validator] ?? `${finding.validator} validation finding.` })) } : lint;
  const facts = ['put_page', 'capture', 'edit_page'].includes(row.operation)
    ? await prepareFactsBackstop(engine, row, page, before).catch(() => ({ skipped: 'backstop_error' })) : undefined;
  const grammar = await lineGrammarAdvisory(engine, row, visible).catch(() => undefined);
  const similar = await similarPagesAdvisory(engine, row, page).catch(() => undefined);
  return { ...remoteLinkHint(row), ...(sanitized ? { writer_lint: sanitized } : {}), ...(facts ? { facts_backstop: facts } : {}),
    ...(grammar ? { line_grammar: grammar } : {}), ...(similar ? { similar_pages: similar } : {}) };
}
