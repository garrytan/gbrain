/**
 * Post-write validator hook — runs after put_page / importFromContent
 * succeeds, in LINT MODE only. Findings are logged; they do not reject
 * the write.
 *
 * This is the PR 2.5 minimal integration: we want observability on how
 * many pages the brain would reject in strict mode BEFORE flipping the
 * strict-mode default (CEO plan: "follow-on release gated on BrainBench
 * regression ≤1pt + 7-day soak + zero false-positive count").
 *
 * Gated on config `writer.lint_on_put_page`. Default: false (no change to
 * current put_page behavior). When enabled, findings land in:
 *   - ingest_log (via engine.logIngest) — durable, agent-inspectable
 *   - ~/.gbrain/validator-lint.jsonl — local file for drift-over-time analysis
 *
 * Pages with `validate: false` frontmatter skip the validators entirely
 * (grandfather opt-out from PR 2 migration).
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { gbrainPath } from '../config.ts';

import type { BrainEngine } from '../engine.ts';
import { BUILTIN_VALIDATORS, FIX_HINTS } from './validators/index.ts';
import type { ValidationFinding } from './writer.ts';

const getLintLogFile = () => gbrainPath('validator-lint.jsonl');
const LINT_CONFIG_KEY = 'writer.lint_on_put_page';

export interface PostWriteLintOpts {
  /** Override config lookup; used by tests. If true, always run. */
  force?: boolean;
  /** Skip file writes; used by tests. */
  noLog?: boolean;
  /** Exact scalar source for the page and nested validation reads. */
  sourceId?: string;
  /** Federated read scope; when non-empty, takes precedence over sourceId. */
  sourceIds?: string[];
}

export interface PostWriteLintResult {
  ran: boolean;
  slug: string;
  findings: ValidationFinding[];
  skippedReason?: string;
}

/**
 * Read the writer.lint_on_put_page flag. Returns true only when set to an
 * explicit enable value; anything else (unset, 'false', '0') is false.
 * Fails safe on read error.
 */
export async function isLintOnPutPageEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const v = await engine.getConfig(LINT_CONFIG_KEY);
    if (v === null || v === undefined) return false;
    const lc = v.toLowerCase();
    return lc === 'true' || lc === '1' || lc === 'yes' || lc === 'on';
  } catch {
    return false;
  }
}

/**
 * Run the four built-in validators on a freshly-written page.
 * Returns empty findings when:
 *   - flag disabled
 *   - page not found (shouldn't happen in normal put_page flow)
 *   - page has frontmatter.validate === false
 */
export async function runPostWriteLint(
  engine: BrainEngine,
  slug: string,
  opts: PostWriteLintOpts = {},
): Promise<PostWriteLintResult> {
  const enabled = opts.force ?? await isLintOnPutPageEnabled(engine);
  if (!enabled) {
    return { ran: false, slug, findings: [], skippedReason: 'flag_disabled' };
  }

  const sourceOpts = opts.sourceIds && opts.sourceIds.length > 0
    ? { sourceIds: opts.sourceIds }
    : opts.sourceId
      ? { sourceId: opts.sourceId }
      : undefined;
  const page = await engine.getPage(slug, sourceOpts);
  if (!page) {
    return { ran: false, slug, findings: [], skippedReason: 'page_not_found' };
  }

  if (page.frontmatter?.validate === false) {
    return { ran: false, slug, findings: [], skippedReason: 'validate_false_frontmatter' };
  }

  const ctx = {
    slug,
    type: page.type,
    compiledTruth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter ?? {},
    engine,
    sourceId: opts.sourceId,
    sourceIds: opts.sourceIds,
  };

  const findings: ValidationFinding[] = [];
  for (const v of BUILTIN_VALIDATORS) {
    try {
      const out = await v.validate(ctx);
      for (const f of out) findings.push(f);
    } catch {
      // Validator-level failure shouldn't break the main put_page flow;
      // swallow and continue with other validators.
    }
  }

  if (findings.length > 0 && !opts.noLog) {
    writeLocalLintLog(slug, findings);
    await writeIngestLog(engine, slug, findings);
  }

  return { ran: true, slug, findings };
}

// ---------------------------------------------------------------------------
// put_page payload plumbing (T11 writer-lint visibility)
// ---------------------------------------------------------------------------

/** top_findings cap: enough to act on, small enough for the wire. */
const TOP_FINDINGS_CAP = 5;
/** Per-finding message cap; validators already truncate embedded content. */
const FINDING_MESSAGE_MAX = 200;

export interface WriterLintFindingSummary {
  validator: string;
  severity: 'error' | 'warning';
  line?: number;
  message: string;
  hint: string;
}

export interface WriterLintSummary {
  error_count: number;
  warning_count: number;
  /** Errors-first, capped at TOP_FINDINGS_CAP, one actionable hint each. */
  top_findings: WriterLintFindingSummary[];
  /** True when findings beyond the cap were dropped from top_findings. */
  details_truncated: boolean;
  /** Finding count per validator id, e.g. { citation: 17, link: 2 }. */
  by_validator: Record<string, number>;
}

/**
 * The put_page `writer_lint` value: a full summary when lint ran, or the
 * crash marker — distinguishable from lint-off, where the key is absent.
 */
export type WriterLintPayload = WriterLintSummary | { status: 'lint_error' };

/**
 * Shape the `writer_lint` response block from the full findings array.
 * Sort is stable, so within a severity findings keep validator order.
 */
export function summarizeWriterLint(findings: ValidationFinding[]): WriterLintSummary {
  const errorsFirst = [...findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1,
  );
  const byValidator: Record<string, number> = {};
  for (const f of findings) byValidator[f.validator] = (byValidator[f.validator] ?? 0) + 1;
  return {
    error_count: findings.filter(f => f.severity === 'error').length,
    warning_count: findings.filter(f => f.severity === 'warning').length,
    top_findings: errorsFirst.slice(0, TOP_FINDINGS_CAP).map(f => ({
      validator: f.validator,
      severity: f.severity,
      ...(f.line !== undefined ? { line: f.line } : {}),
      message: truncate(f.message, FINDING_MESSAGE_MAX),
      // Registry completeness is test-pinned; the fallback covers a
      // non-builtin validator ever reaching this path.
      hint: FIX_HINTS[f.validator] ?? 'see the validator rule for the fix',
    })),
    details_truncated: findings.length > TOP_FINDINGS_CAP,
    by_validator: byValidator,
  };
}

/**
 * put_page-facing wrapper mapping every lint outcome to the response
 * contract: ran (zero findings included) → full summary; did not run
 * (flag off / validate:false / page missing) → undefined so the
 * writer_lint key stays absent; threw → {status: 'lint_error'} so a lint
 * crash is distinguishable from lint-off. Never throws.
 */
export async function writerLintForPutPage(
  engine: BrainEngine,
  slug: string,
  opts: PostWriteLintOpts = {},
): Promise<WriterLintPayload | undefined> {
  try {
    const lint = await runPostWriteLint(engine, slug, opts);
    if (!lint.ran) return undefined;
    return summarizeWriterLint(lint.findings);
  } catch {
    return { status: 'lint_error' };
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

// ---------------------------------------------------------------------------
// Loggers
// ---------------------------------------------------------------------------

function writeLocalLintLog(slug: string, findings: ValidationFinding[]): void {
  try {
    const lintLogFile = getLintLogFile();
    const dir = dirname(lintLogFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      slug,
      error_count: findings.filter(f => f.severity === 'error').length,
      warning_count: findings.filter(f => f.severity === 'warning').length,
      findings: findings.slice(0, 20), // cap to prevent runaway log size
    }) + '\n';
    appendFileSync(lintLogFile, line, 'utf-8');
  } catch {
    // Non-fatal; logging failure shouldn't break the main flow.
  }
}

async function writeIngestLog(engine: BrainEngine, slug: string, findings: ValidationFinding[]): Promise<void> {
  try {
    const errorCount = findings.filter(f => f.severity === 'error').length;
    const warningCount = findings.filter(f => f.severity === 'warning').length;
    const summary = `post-write lint: ${errorCount} error, ${warningCount} warning` +
      (errorCount > 0 ? ` (top: ${findings.find(f => f.severity === 'error')!.message.slice(0, 80)})` : '');
    await engine.logIngest({
      source_type: 'writer_lint',
      source_ref: slug,
      pages_updated: [slug],
      summary,
    });
  } catch {
    // Non-fatal.
  }
}
