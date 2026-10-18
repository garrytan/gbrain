import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { writerLintForPutPage } from '../output/post-write.ts';
import type { WriteRequest } from './model.ts';
import type { TimelineRowsRemoved } from './canonical-projections.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { prepareFactsBackstop } from './effect-facts.ts';
import { parseLineGrammar } from '../line-grammar.ts';
import { lineGrammarReport } from '../line-grammar-report.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
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
  // #6276: off by default, so the default path sends no statement; on Postgres the check runs with JIT off (its
  // correlated visibility subplans cross the JIT cost threshold on larger brains and compile on every call).
  if (!/^(true|1|yes|on)$/i.test((await engine.getConfig('put_page.similar_pages').catch(() => null))?.trim() ?? '')) return undefined;
  const input = { sourceId: row.source_id, slug: row.slug, title: page.title ?? '', excludePrivate: row.authority.excludePrivate ?? row.authority.remote };
  const found = engine.kind === 'postgres'
    ? await engine.transaction(async tx => { await tx.executeRaw('SET LOCAL jit = off'); return findSimilarPages(tx, input); })
    : await findSimilarPages(engine, input);
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
 * fact lines, with every near-miss explained (core/line-grammar-report.ts).
 * Absent when the page has none or the grammar is off. Relations are stored
 * with the page's links (or by the next sweep for a remote writer); fact
 * lines stay page text and are not added to `facts`.
 */
async function lineGrammarAdvisory(engine: BrainEngine, row: WriteRequest, page: ParsedPage): Promise<Record<string, unknown> | undefined> {
  // Settings and pack reads are skipped for a body with nothing the grammar could read or explain.
  const ungated = parseLineGrammar(page.compiled_truth, { explainGuards: true });
  if (!ungated.relations.length && !ungated.facts.length && !ungated.diagnostics.length) return undefined;
  const report = await lineGrammarReport(engine, { slug: row.slug, sourceId: row.source_id, body: page.compiled_truth, limit: LINE_GRAMMAR_FINDINGS_MAX });
  if (report.state === 'diagnostics_failed') return report;
  if (!report.enabled) return undefined;
  if (!report.relations && !report.facts && !report.total) return undefined;
  const relationsState = !(await isAutoLinkEnabled(engine)) ? 'auto_link_disabled'
    : row.authority.remote && !row.authority.autoLinkTrusted ? 'pending_sweep' : 'stored';
  return {
    relations: report.relations,
    relations_state: relationsState,
    facts: report.facts,
    ...(report.facts ? { facts_state: 'page_text_only',
      facts_message: 'Fact lines are searchable page text; they are not added to recall facts. Use remember (or the page ## Facts table) for a fact recall must return.' } : {}),
    findings: report.findings.map(f => ({ ...f, message: `Page saved; line ${f.line} was not read as written. ${f.message}` })),
    total: report.total,
    details_truncated: report.details_truncated,
    ...(report.more ? { more: report.more } : {}),
    pack: report.pack,
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
  const grammar = await lineGrammarAdvisory(engine, row, visible).catch((e: unknown): Record<string, unknown> => ({ state: 'diagnostics_failed',
    message: `Line-grammar diagnostics failed (${e instanceof Error ? e.message : String(e)}); the page was saved, but nothing is known about its typed lines.`,
    fix: readFix('Checks the brain configuration and schema pack, read-only.', { argv: ['gbrain', 'doctor', '--json'] }) }));
  const similar = await similarPagesAdvisory(engine, row, page).catch(() => undefined);
  return { ...remoteLinkHint(row), ...(sanitized ? { writer_lint: sanitized } : {}), ...(facts ? { facts_backstop: facts } : {}),
    ...(grammar ? { line_grammar: grammar } : {}), ...(similar ? { similar_pages: similar } : {}) };
}
