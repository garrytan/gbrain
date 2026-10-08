/**
 * What the line grammar reads from one page body, with every refused line
 * explained in the agent operator contract's terms (`code`, `why`, a
 * canonical form where one exists, and a read-only `verify`). Shared by the
 * put_page advisory (first five findings) and `get_page grammar_diagnostics`
 * (all findings), so a writer can always reach the full list.
 *
 * Effective mode: the brain's grammar settings and the source's active pack
 * verbs. A failed settings or pack read is reported as `diagnostics_failed`,
 * never as an ungated parse.
 */
import type { BrainEngine } from './engine.ts';
import { parseLineGrammar, readLineGrammarSettings, type GrammarDiagnostic } from './line-grammar.ts';
import { loadActivePackForEngine } from './schema-pack/engine-resolution.ts';
import { readFix } from './ops/op-fix.ts';
import type { Action } from './agent-output.ts';

export interface LineGrammarFinding {
  severity: 'warning';
  validator: 'line-grammar';
  code: GrammarDiagnostic['reason'];
  reason: GrammarDiagnostic['reason'];
  line: number;
  text: string;
  message: string;
  why: string;
  canonical?: string;
  verify: Action;
}

export type LineGrammarReport =
  | { state: 'diagnostics_failed'; message: string; fix: Action }
  | {
    state: 'ok';
    enabled: boolean;
    mode: 'effective';
    pack: string | null;
    relations: number;
    facts: number;
    findings: LineGrammarFinding[];
    total: number;
    details_truncated: boolean;
    more?: Action;
  };

const WHY: Record<GrammarDiagnostic['reason'], string> = {
  prose_tail: 'A relation line is one type, one link and at most one trailing (context); extra words make it a sentence.',
  two_links: 'A relation line names exactly one link.',
  stoplist_type: 'The word before the link is too generic to be a relation type.',
  undeclared_type: 'Relation types are limited to the active schema pack\'s link verbs.',
  unknown_qualifier: 'Only @effective[start,end) (alias @valid) is read.',
  invalid_range: 'Validity ranges take ISO dates with the start before the end.',
  template_slot: 'The line holds another bare [Slot], which marks an unfilled template, not a typed fact.',
  separator_claim: 'The claim starts with a separator, which marks a template or table row.',
  placeholder_claim: 'The claim is only a placeholder.',
  usage_label: 'The bracketed word is a dictionary usage label, not a fact category.',
  type_punctuation: 'A relation type is read only when written bare, without formatting or a colon.',
};

const verifyFor = (slug: string, sourceId: string): Action => readFix(
  'Re-reads this page\'s line-grammar findings after an edit, read-only.',
  { argv: ['gbrain', 'get', '--source', sourceId, '--grammar-diagnostics', '--', slug],
    mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, grammar_diagnostics: true } } });

/** The bare form of a decorated relation line (`- **works_at** [[x]]` -> `- works_at [[x]]`). */
function canonicalLine(d: GrammarDiagnostic): string | undefined {
  if (d.reason !== 'type_punctuation') return undefined;
  const m = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)(?:\*\*|__|`)?([A-Za-z][A-Za-z0-9_-]*?)(?:\*\*|__|`)?:?(\s+.*)$/.exec(d.text);
  return m ? `${m[1]}${m[2]}${m[3]}` : undefined;
}

export async function lineGrammarReport(engine: BrainEngine, opts: {
  slug: string; sourceId: string; body: string; limit?: number;
}): Promise<LineGrammarReport> {
  let settings: Awaited<ReturnType<typeof readLineGrammarSettings>>;
  let declaredTypes: Set<string> | null = null;
  let pack: string | null = null;
  try {
    settings = await readLineGrammarSettings(engine);
    if (!settings.allowUndeclaredTypes) {
      const resolved = await loadActivePackForEngine(engine, { remote: false, sourceId: opts.sourceId });
      pack = resolved?.manifest?.name ?? null;
      const verbs = resolved?.manifest?.link_types.map((lt: { name: string }) => lt.name) ?? [];
      declaredTypes = verbs.length ? new Set(verbs) : null;
    }
  } catch (e) {
    return {
      state: 'diagnostics_failed',
      message: `Line-grammar diagnostics could not read the brain's grammar settings or schema pack (${(e as Error).message}); nothing about this page's typed lines is known.`,
      fix: readFix('Checks the brain\'s configuration and schema pack health, read-only.', { argv: ['gbrain', 'doctor', '--json'] }),
    };
  }
  const parsed = parseLineGrammar(opts.body, { declaredTypes, explainGuards: opts.limit === undefined });
  const all = parsed.diagnostics.map((d): LineGrammarFinding => {
    const canonical = canonicalLine(d);
    return { severity: 'warning', validator: 'line-grammar', code: d.reason, reason: d.reason, line: d.line, text: d.text,
      message: d.message, why: WHY[d.reason], ...(canonical ? { canonical } : {}), verify: verifyFor(opts.slug, opts.sourceId) };
  });
  const findings = opts.limit === undefined ? all : all.slice(0, opts.limit);
  const truncated = findings.length < all.length;
  return {
    state: 'ok', enabled: settings.enabled, mode: 'effective', pack,
    relations: parsed.relations.length, facts: parsed.facts.length, findings, total: all.length, details_truncated: truncated,
    ...(truncated ? { more: readFix('Lists every line-grammar finding for this page, read-only.', {
      argv: ['gbrain', 'get', '--source', opts.sourceId, '--grammar-diagnostics', '--', opts.slug],
      mcp: { tool: 'get_page', arguments: { slug: opts.slug, source_id: opts.sourceId, grammar_diagnostics: true } } }) } : {}),
  };
}
