/**
 * propose_takes failure ledger (GBRA-130 A-25).
 *
 * One op_checkpoints row per source (op `propose-takes-failures`, fingerprint
 * the source id) records each page whose extractor call failed: the content
 * hash and prompt version it failed at, the failure code and class, and the
 * number of counted runs in a row it failed the same way (`attempts`). The
 * phase retries a recorded page after its fresh candidates, and a page whose
 * content-class failure (a prompt too long for the model, a provider content
 * block) repeats in PROPOSE_TAKES_HOLD_RUNS counted runs at the same hash and
 * prompt version gets a failure tombstone in take_proposals: a `rejected` row
 * whose claim text names the code, so the idempotency check skips the page
 * until its content or the prompt version changes, and which stays distinct
 * from a successful empty extraction. `gbrain takes propose --retry-failed`
 * deletes the tombstones and records so the next run re-extracts.
 *
 * A run's failures count only when the run is not systemic (most fresh pages
 * failing trips the ItemRun breaker) and the extractor has succeeded on another
 * page since the failing page first failed (this run, or a stored success
 * after it), so a dead extractor lane never tombstones pages.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { ItemRun, classifyItemFailure, type ClassifiedItemFailure } from '../item-failure.ts';

export const PROPOSE_TAKES_FAILURE_OP = 'propose-takes-failures';
export const PROPOSE_TAKES_HOLD_RUNS = 3;
/** Recorded pages kept per source; the oldest failures drop first. */
const MAX_RECORDS = 500;
const TOMBSTONE_PREFIX = '(extraction failed: ';

export interface ProposeTakesFailureRecord {
  content_hash: string;
  prompt_version: string;
  code: string;
  class: 'content' | 'transient';
  message: string;
  /** Counted runs in a row that failed with `code` (content class only; 0 while only observed). */
  attempts: number;
  first_failed_at: string;
  last_failed_at: string;
}

export interface ProposeTakesFailureLedger {
  /** The last run that had an extractor success: a prompt version and ISO time. */
  success: { prompt_version: string; at: string } | null;
  pages: Record<string, ProposeTakesFailureRecord>;
}

export const failureTombstoneText = (code: string) => `${TOMBSTONE_PREFIX}${code})`;

/** The command that releases a tombstoned page so the next propose_takes run re-extracts it (one extractor call). */
export function retryFailedAction(sourceId: string, slug: string): Action {
  return {
    argv: ['gbrain', 'takes', 'propose', '--retry-failed', '--slug', slug, '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
    why: `Deletes the failure tombstone of ${slug} in source ${sourceId}; the next propose_takes run calls the extractor on it again, and `
      + `it is tombstoned again after ${PROPOSE_TAKES_HOLD_RUNS} counted runs failing the same way.`,
    verify: { argv: ['gbrain', 'takes', 'propose', '--failed', '--json', '--source', sourceId] },
  };
}

export async function loadFailureLedger(engine: BrainEngine, sourceId: string): Promise<ProposeTakesFailureLedger> {
  const [row] = await engine.executeRaw<{ ledger: ProposeTakesFailureLedger | string | null }>(
    "SELECT completed_keys->0 AS ledger FROM op_checkpoints WHERE op = $1 AND fingerprint = $2", [PROPOSE_TAKES_FAILURE_OP, sourceId]);
  const stored = typeof row?.ledger === 'string' ? JSON.parse(row.ledger) as ProposeTakesFailureLedger : row?.ledger;
  return { success: stored?.success ?? null, pages: stored?.pages && typeof stored.pages === 'object' ? stored.pages : {} };
}

export async function saveFailureLedger(engine: BrainEngine, sourceId: string, ledger: ProposeTakesFailureLedger): Promise<void> {
  const pages = Object.fromEntries(Object.entries(ledger.pages)
    .sort((a, b) => b[1].last_failed_at.localeCompare(a[1].last_failed_at)).slice(0, MAX_RECORDS));
  await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ($1, $2, $3::text::jsonb)
    ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
    [PROPOSE_TAKES_FAILURE_OP, sourceId, JSON.stringify([{ success: ledger.success, pages }])]);
}

/** Pages of a source that carry a failure tombstone, with the code it names. */
export async function listFailedProposals(engine: BrainEngine, sourceId: string): Promise<Array<{ slug: string; code: string; prompt_version: string; proposed_at: string }>> {
  const rows = await engine.executeRaw<{ slug: string; claim_text: string; prompt_version: string; proposed_at: string }>(
    `SELECT page_slug AS slug, claim_text, prompt_version, proposed_at::text AS proposed_at FROM take_proposals
      WHERE source_id = $1 AND status = 'rejected' AND acted_at IS NULL AND starts_with(claim_text, $2) ORDER BY page_slug`, [sourceId, TOMBSTONE_PREFIX]);
  return rows.map(row => ({ slug: row.slug, code: row.claim_text.slice(TOMBSTONE_PREFIX.length, -1), prompt_version: row.prompt_version, proposed_at: row.proposed_at }));
}

/** Deletes the failure tombstones (and ledger records) of one page or every page of a source, so the next run re-extracts them. */
export async function retryFailedProposals(engine: BrainEngine, sourceId: string, slug?: string): Promise<{ released: string[] }> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `DELETE FROM take_proposals WHERE source_id = $1 AND status = 'rejected' AND acted_at IS NULL AND starts_with(claim_text, $2)
        AND ($3::text IS NULL OR page_slug = $3) RETURNING page_slug AS slug`, [sourceId, TOMBSTONE_PREFIX, slug ?? null]);
  const ledger = await loadFailureLedger(engine, sourceId);
  const pages = slug === undefined ? {} : Object.fromEntries(Object.entries(ledger.pages).filter(([key]) => key !== slug));
  if (Object.keys(pages).length !== Object.keys(ledger.pages).length) await saveFailureLedger(engine, sourceId, { ...ledger, pages });
  return { released: [...new Set(rows.map(row => row.slug))].sort() };
}

/** One page whose extractor call failed this run, as the phase reports it. */
export interface FailedPage {
  slug: string;
  key: string;
  code: string;
  class: 'content' | 'transient';
  message: string;
  /** Counted runs in a row this page failed the same way; a page reaching PROPOSE_TAKES_HOLD_RUNS is `held`. */
  attempts: number;
  held: boolean;
  /** Set on a held page: the command that releases it. */
  fix: Action | null;
}

type RunFailure = { sourceId: string; slug: string; contentHash: string; failure: ClassifiedItemFailure };

/** The failure ledgers of every source one run touches, and that run's extractor outcomes. */
export class ProposeTakesFailures {
  private readonly itemRun = new ItemRun('propose_takes.pages');
  private readonly failures: RunFailure[] = [];
  private readonly succeeded: Array<{ sourceId: string; slug: string }> = [];
  /** Failures that feed the breaker and the #3763 halt: every failure except a recorded page repeating its content-class code. */
  freshFailures = 0;

  private constructor(private readonly ledgers: Map<string, ProposeTakesFailureLedger>, private readonly promptVersion: string) {}

  static async load(engine: BrainEngine, sourceIds: Iterable<string>, promptVersion: string): Promise<ProposeTakesFailures> {
    const ledgers = new Map<string, ProposeTakesFailureLedger>();
    for (const id of new Set(sourceIds)) ledgers.set(id, await loadFailureLedger(engine, id));
    return new ProposeTakesFailures(ledgers, promptVersion);
  }

  /** The page's record when it failed before at this content hash and prompt version. */
  known(sourceId: string, slug: string, contentHash: string): ProposeTakesFailureRecord | undefined {
    const record = this.ledgers.get(sourceId)?.pages[slug];
    return record && record.content_hash === contentHash && record.prompt_version === this.promptVersion ? record : undefined;
  }

  /** Fresh pages first; a page that failed before at this hash and prompt version is retried after them. */
  order<T extends { slug: string }>(pages: T[], key: (page: T) => [sourceId: string, contentHash: string]): T[] {
    const failing = (page: T) => this.known(key(page)[0], page.slug, key(page)[1]) !== undefined;
    return [...pages.filter(page => !failing(page)), ...pages.filter(failing)];
  }

  /**
   * Records an extractor failure; a run-scoped error (abort, lost connection, failed transaction) is rethrown.
   * Only a recorded page repeating its content-class code is the expected outcome and stays out of the
   * breaker and the #3763 halt; a transient or provider failure always counts, so an outage still halts.
   */
  fail(sourceId: string, slug: string, contentHash: string, err: unknown): void {
    const classified = classifyItemFailure(err);
    if (classified.scope === 'run') throw err;
    const prior = this.known(sourceId, slug, contentHash);
    const repeat = prior?.class === 'content' && classified.class === 'content' && prior.code === classified.code;
    const failure = repeat ? classified : this.itemRun.record(slug, err).failure;
    this.failures.push({ sourceId, slug, contentHash, failure });
    if (!repeat) this.freshFailures += 1;
  }

  succeed(sourceId: string, slug: string, contentHash: string): void {
    if (this.known(sourceId, slug, contentHash)?.class !== 'content') this.itemRun.succeed();
    this.succeeded.push({ sourceId, slug });
  }

  /**
   * Folds the run into the ledgers and returns the failed pages. A systemic run
   * (most fresh pages failed) or a whole-run LLM halt (`counted` false) records its failures
   * (so the pages are retried after fresh ones) but neither count nor reset.
   * A counted content failure counts only with evidence that the extractor
   * works: a success in this run, or a stored success no earlier than the run
   * in which the page first failed. A page reaching PROPOSE_TAKES_HOLD_RUNS gets a failure
   * tombstone (a `rejected` take_proposals row) and leaves the ledger.
   */
  async settle(engine: BrainEngine, run: { counted: boolean; proposalRunId: string; modelId: string }):
    Promise<{ failed: FailedPage[]; tombstones: number; systemic?: { code: string; message: string } }> {
    const now = new Date().toISOString();
    const systemic = this.itemRun.systemic();
    const counted = run.counted && !systemic;
    const changed = new Set<string>();
    const out: FailedPage[] = [];
    let tombstones = 0;
    for (const { sourceId, slug } of this.succeeded) {
      const ledger = this.ledgers.get(sourceId)!;
      ledger.success = { prompt_version: this.promptVersion, at: now };
      if (Object.keys(ledger.pages).length > 0) changed.add(sourceId);
      delete ledger.pages[slug];
    }
    for (const { sourceId, slug, contentHash, failure } of this.failures) {
      const ledger = this.ledgers.get(sourceId)!;
      const prior = this.known(sourceId, slug, contentHash);
      const evidence = this.succeeded.length > 0
        || (prior !== undefined && ledger.success?.prompt_version === this.promptVersion && ledger.success.at >= prior.first_failed_at);
      const attempts = !counted || !evidence ? prior?.attempts ?? 0
        : failure.class !== 'content' ? 0
        : (prior?.code === failure.code ? prior.attempts : 0) + 1;
      const held = attempts >= PROPOSE_TAKES_HOLD_RUNS;
      if (held) {
        await engine.executeRaw(
          `INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'fact', 'brain', 0, NULL, '[]'::jsonb, $7, 'rejected')
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING`,
          [sourceId, slug, contentHash, this.promptVersion, run.proposalRunId, failureTombstoneText(failure.code), run.modelId],
        );
        tombstones += 1;
        delete ledger.pages[slug];
      } else {
        ledger.pages[slug] = { content_hash: contentHash, prompt_version: this.promptVersion, code: failure.code, class: failure.class,
          message: failure.message.slice(0, 300), attempts, first_failed_at: prior?.first_failed_at ?? now, last_failed_at: now };
      }
      changed.add(sourceId);
      out.push({ slug, key: slug, code: failure.code, class: failure.class, message: failure.message.slice(0, 300), attempts, held,
        fix: held ? retryFailedAction(sourceId, slug) : null });
    }
    for (const sourceId of changed) await saveFailureLedger(engine, sourceId, this.ledgers.get(sourceId)!);
    return { failed: out, tombstones, systemic: systemic ? { code: 'item_failures_systemic', message: systemic.message } : undefined };
  }
}
