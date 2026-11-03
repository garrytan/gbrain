/**
 * GBRA-217 (A7): purge reaches page change reasons. A reason quoting a purged claim lives in three places this module
 * covers: the snapshots that carry it (`page_versions.change_reason`, redacted by `redactPageVersions`), Git effects
 * not yet run or retained after running (`commit_line`, `commit_trailers`, a legacy `commit_trailer`), and the commit
 * messages already in Git, which purge never rewrites: their (commit, path) pairs are tombstoned, text-free, so no later
 * sync, cold re-import or re-derive stores that reason again.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { REASON_TRAILER_KEY } from '../persistence/change-reason.ts';
import type { IntentRedactionTarget } from '../persistence/intent-redaction.ts';
import { reasonScanCap, scanTrailersCarrying } from '../reason-trailers.ts';
import { claimNeedles } from './purge-verify.ts';

const PURGE_REASON_DOCS = 'docs/guides/page-history.md#purge-and-reasons';

/** The preparation's trailer scan: nothing to tombstone without a checkout (repo-less brain, plain folder). */
export interface PurgeTrailerPlan { sourceRoot: string | null; head: string | null; hits: Array<{ commit: string; path: string }>; commits: number; limited: boolean }

const scanFailed = (sourceId: string, rawId: string, detail: string) => opError('reason_purge_scan_failed',
  `Reading the change reasons in the Git history of source ${sourceId} failed (${detail}), so nothing was purged.`,
  'Purge reads every gbrain-reason trailer that quotes the claim before it deletes anything, so the reason can be blocked from coming back; nothing changed and retrying is safe. Wait, then run the same purge again.',
  { docs: PURGE_REASON_DOCS, retryable: true, fix: { argv: ['gbrain', 'forget', rawId, '--purge', '--dry-run', '--json'], consent: [], actor: 'provider', requires_exclusive: false,
    why: 'Nothing was changed; once Git can be read again, the dry run confirms the plan and the same purge can be retried.' } });

/**
 * Before the purge transaction, while the claim still exists: the commits whose reason quotes it. A failed read refuses
 * `reason_purge_scan_failed` (retry); more commits than the cap refuses `reason_purge_scan_capped` (the user chooses a
 * `--reason-scan-limit` or stops), and with a limit the older commits are left unread and the receipt says so.
 */
export async function scanPurgeTrailers(engine: BrainEngine, input: { sourceId: string; claim: string; rawId: string; limit?: number }): Promise<PurgeTrailerPlan> {
  const none: PurgeTrailerPlan = { sourceRoot: null, head: null, hits: [], commits: 0, limited: false };
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [input.sourceId]);
  if (!source?.local_path) return none;
  const scan = await scanTrailersCarrying(source.local_path, [input.claim], input.limit === undefined ? {} : { limit: input.limit });
  if (scan.status === 'no_repository') return none;
  if (scan.status === 'failed') throw scanFailed(input.sourceId, input.rawId, scan.detail);
  if (scan.status === 'capped') {
    throw opError('reason_purge_scan_capped', `Source ${input.sourceId} has more than ${scan.cap} commits to check for change reasons that quote this claim, so nothing was purged.`,
      'Ask the user: purge now and check only the newest commits (pass --reason-scan-limit with the number they choose; older commits are not checked, so a reason there could be mirrored again by a later re-import), or stop.',
      { docs: PURGE_REASON_DOCS, fix: { ask_user: true, argv: ['gbrain', 'forget', input.rawId, '--purge', '--reason-scan-limit', String(scan.cap)], consent: ['destructive'], actor: 'agent', requires_exclusive: false,
        why: `Purges and tombstones the reasons found in the newest ${scan.cap} commits; older commits are not read.`,
        user_message: `This brain's Git history is longer than ${scan.cap} commits. Purge now and check only the newest commits for change reasons quoting this claim (choose how many), or stop?` } });
  }
  return { sourceRoot: source.local_path, head: scan.head, hits: scan.hits, commits: scan.commits, limited: scan.limited };
}

/**
 * Inside the purge transaction: rechecks the commits that landed since the preparation's scan, then records every
 * (commit, path) the claim's reason was found under. Returns the tombstones added.
 */
export async function recordReasonTombstones(tx: BrainEngine, input: { sourceId: string; claim: string; rawId: string; plan: PurgeTrailerPlan }): Promise<number> {
  const { plan } = input;
  if (!plan.sourceRoot) return 0;
  const recheck = await scanTrailersCarrying(plan.sourceRoot, [input.claim], { from: plan.head, limit: reasonScanCap('purge') });
  if (recheck.status === 'failed') throw scanFailed(input.sourceId, input.rawId, recheck.detail);
  if (recheck.status === 'no_repository') throw scanFailed(input.sourceId, input.rawId, 'the Git checkout scanned before the purge is gone');
  const hits = [...plan.hits, ...(recheck.status === 'complete' ? recheck.hits : [])];
  if (!hits.length) return 0;
  return (await tx.executeRaw(`INSERT INTO reason_purge_tombstones(source_id, commit_sha, path)
    SELECT $1, t.c, t.p FROM unnest($2::text[], $3::text[]) AS t(c, p) ON CONFLICT DO NOTHING RETURNING 1`,
  [input.sourceId, hits.map(hit => hit.commit), hits.map(hit => hit.path)])).length;
}

/** A Git effect a worker is running may have its commit message in flight: the purge waits for it. */
const gitCommitRunning = (requestId: string) => opError('purge_blocked_pending_recovery', 'A Git commit that carries this content is being written, so nothing was purged.',
  `Request ${requestId} has a Git effect running whose commit message quotes the purged content. Wait for it to finish, then retry the purge with the same request id.`,
  { fix: { argv: ['gbrain', 'write-request', '--', requestId], consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Shows the blocking write\'s state, read-only; retry the purge once it is final.' } });

/**
 * Git effects of the source whose commit message would carry the claim: queued, failed and retained committed ones are
 * redacted in place (`commit_line` becomes "[purged]", a carrying trailer is dropped); one a worker is running refuses
 * `purge_blocked_pending_recovery` (its message may be in flight). Returns the effects redacted.
 */
export async function redactGitEffectReasons(tx: BrainEngine, sourceId: string, claim: string): Promise<number> {
  const [needle, escaped] = claimNeedles(claim);
  const rows = await tx.executeRaw<{ id: string; state: string; request_id: string; data: Record<string, unknown> }>(`SELECT e.id::text AS id, e.state, r.request_id::text AS request_id, e.data
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.source_id = $1 AND e.kind = 'git' AND (strpos(lower(e.data::text), $2) > 0 OR strpos(lower(e.data::text), $3) > 0) ORDER BY e.id FOR UPDATE OF e`, [sourceId, needle, escaped]);
  const carries = (value: unknown) => typeof value === 'string' && value.toLowerCase().includes(needle);
  let redacted = 0;
  for (const row of rows) {
    const data = { ...row.data };
    const listed = Array.isArray(data.commit_trailers) ? data.commit_trailers : null;
    if (!carries(data.commit_line) && !carries(data.commit_trailer) && !listed?.some(carries)) continue;
    if (row.state === 'running') throw gitCommitRunning(row.request_id);
    if (carries(data.commit_line)) data.commit_line = '[purged]';
    if (carries(data.commit_trailer)) delete data.commit_trailer;
    if (listed) {
      const kept = listed.filter(trailer => !carries(trailer));
      if (kept.length) data.commit_trailers = kept; else delete data.commit_trailers;
    }
    await tx.executeRaw('UPDATE persistence_effects SET data = $2::text::jsonb WHERE id = $1::bigint', [row.id, JSON.stringify(data)]);
    redacted++;
  }
  return redacted;
}

/**
 * Page purge, inside its transaction and before the cascade: the page's own change reasons, those its snapshots carry and
 * those its requests recorded (a creation's reason is on no snapshot). They join the claim needles for the slug's receipts.
 */
export async function pageChangeReasons(tx: BrainEngine, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await tx.executeRaw<{ reason: string | null }>(`SELECT change_reason AS reason FROM page_versions WHERE page_id = $1
    UNION SELECT intent->>'reason' FROM persistence_requests WHERE source_id = $2 AND slug = $3
    UNION SELECT outcome->'reason_recorded'->>'reason' FROM persistence_requests WHERE source_id = $2 AND slug = $3`, [pageId, sourceId, slug]);
  return [...new Set(rows.map(row => row.reason).filter((reason): reason is string => !!reason && reason !== '[purged]'))];
}

/** The slug's requests whose intent or outcome records a reason, compacted ones included (compaction keeps the outcome). */
export async function requestsRecordingReasons(tx: BrainEngine, sourceId: string, slug: string): Promise<IntentRedactionTarget[]> {
  return tx.executeRaw<IntentRedactionTarget>(`SELECT id::text AS id, principal_kind, principal_id FROM persistence_requests
    WHERE source_id = $1 AND slug = $2 AND ((intent->>'reason') IS NOT NULL OR (outcome->'reason_recorded') IS NOT NULL) ORDER BY sequence LIMIT 10000`, [sourceId, slug]);
}

/**
 * Page purge: every Git effect of the slug, in any state, loses its commit line and trailers (they name the page's reasons);
 * a running one whose trailers carry a reason refuses `purge_blocked_pending_recovery`. Returns the effects stripped.
 */
export async function stripPageGitNotes(tx: BrainEngine, sourceId: string, slug: string): Promise<number> {
  const rows = await tx.executeRaw<{ id: string; state: string; request_id: string; data: Record<string, unknown> }>(`SELECT e.id::text AS id, e.state, r.request_id::text AS request_id, e.data
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.source_id = $1 AND e.kind = 'git' AND e.data->>'slug' = $2
      AND ((e.data->'commit_line') IS NOT NULL OR (e.data->'commit_trailers') IS NOT NULL OR (e.data->'commit_trailer') IS NOT NULL) ORDER BY e.id FOR UPDATE OF e`, [sourceId, slug]);
  const reasonTrailer = (value: unknown) => typeof value === 'string' && value.startsWith(`${REASON_TRAILER_KEY}:`);
  let stripped = 0;
  for (const row of rows) {
    const { commit_line: _line, commit_trailers: listed, commit_trailer: legacy, ...data } = row.data;
    if (row.state === 'running') {
      if (reasonTrailer(legacy) || (Array.isArray(listed) && listed.some(reasonTrailer))) throw gitCommitRunning(row.request_id);
      continue;
    }
    await tx.executeRaw('UPDATE persistence_effects SET data = $2::text::jsonb WHERE id = $1::bigint', [row.id, JSON.stringify(data)]);
    stripped++;
  }
  return stripped;
}
