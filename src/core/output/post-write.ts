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
import {
  citationValidator,
  linkValidator,
  backLinkValidator,
  tripleHrValidator,
} from './validators/index.ts';
import type { ValidationFinding, PageValidator } from './writer.ts';

const getLintLogFile = () => gbrainPath('validator-lint.jsonl');
const LINT_CONFIG_KEY = 'writer.lint_on_put_page';

export interface PostWriteLintOpts {
  /** Override config lookup; used by tests. If true, always run. */
  force?: boolean;
  /** Skip file writes; used by tests. */
  noLog?: boolean;
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

  const page = await engine.getPage(slug);
  if (!page) {
    return { ran: false, slug, findings: [], skippedReason: 'page_not_found' };
  }

  if (page.frontmatter?.validate === false) {
    return { ran: false, slug, findings: [], skippedReason: 'validate_false_frontmatter' };
  }

  const validators: PageValidator[] = [citationValidator, linkValidator, backLinkValidator, tripleHrValidator];
  const ctx = {
    slug,
    type: page.type,
    compiledTruth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter ?? {},
    engine,
  };

  const findings: ValidationFinding[] = [];
  for (const v of validators) {
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
