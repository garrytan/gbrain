/**
 * `gbrain trust claim-sources` (#5575, legacy content): the owner claims
 * their own sources once, at upgrade. Rows written before trust tiers have
 * no provenance, so they project to `unknown` and an old brain reads as
 * almost entirely "unverified origin". Claiming a source says "this is mine":
 *
 * - the source gets the per-source default operator_curated (the
 *   `sources set-trust` store, claim-state.ts) plus a claim receipt;
 * - its legacy `unknown` rows are lifted through the trust backfill
 *   (backfill.ts, the backfill setting CEO-10 allows: unknown ->
 *   operator_curated, never user_confirmed). A row with a lowering signal
 *   keeps it: mcp:* and capture stamps, transcript imports, clipped pages,
 *   connector origins, extraction and dream provenance, journaled agent
 *   writes and the lower-only trust_tier marker. Never above operator_curated.
 *
 * Connector sources (google, github) cannot be claimed: their text is third
 * party. Claiming needs the owner at a terminal typing each source id
 * (trust/confirm.ts; `--yes` never counts); without one the command refuses
 * with a tell_user_to_run fix. The lift is bounded (keyset batches), resumable
 * (`--resume`, its own cursor) and receipted (each lifted row's
 * `write_origin.channel` is `trust_claim`; the source records when it was
 * claimed and when its lift finished). `--dry-run` is read-only.
 *
 * Doctor `trust_sources_unclaimed`, `gbrain post-upgrade` and the
 * behavior-change notice ask the user while unclaimed sources hold legacy
 * rows (`readUnclaimedLegacySources`).
 */
import type { Action } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../sources-load.ts';
import { runTrustBackfill, type TierCounts } from './backfill.ts';
import {
  claimedSourceSql, isClaimedConfig, isConnectorConfig, legacyRowSql, notConnectorSourceSql, readLegacyCeilings,
  TRUST_CLAIM_COMMAND, TRUST_CLAIM_LIFTED_AT_KEY, TRUST_CLAIMED_AT_KEY,
} from './claim-state.ts';
import { OWNER_TIER_FLOOR, TRUST_TIERS, isTrustTier } from './tier.ts';

export type ClaimBlocker = 'connector' | 'archived' | 'claimed' | 'no_legacy_rows';

export interface ClaimSource {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  kind: string | null;
  pages: number;
  /** Rows (pages, facts, takes, timeline entries) still at `unknown`: legacy rows a claim would lift. */
  legacy_unknown: number;
  claimed: boolean;
  /** Claimed, but the lift has not finished (`--resume` finishes it). */
  pending: boolean;
  /** Stored tiers now (absent before the trust migration). */
  current?: TierCounts;
  /** Tiers after a claim and its lift: unknown rows at operator_curated unless their own signals say lower. */
  projected_if_claimed: TierCounts;
  claimable: boolean;
  blocker?: ClaimBlocker;
}

export interface ClaimSourcesListing { schema: 'trust_columns' | 'pre_trust'; sources: ClaimSource[] }

const zero = (): TierCounts => Object.fromEntries(TRUST_TIERS.map(tier => [tier, 0])) as TierCounts;
const add = (into: TierCounts, from: TierCounts | undefined) => { if (from) for (const tier of TRUST_TIERS) into[tier] += from[tier]; };

interface SourceRow { id: string; name: string; local_path: string | null; config: unknown; archived: boolean }

async function sourceRows(engine: BrainEngine): Promise<SourceRow[]> {
  return engine.executeRaw<SourceRow>('SELECT id, name, local_path, config, archived FROM sources ORDER BY id');
}

/**
 * Every source with its page count, legacy unknown rows and the tier mix a
 * claim would produce, in one read-only pass per source (the backfill dry run
 * scoped to it, projected as claimed). Works before the trust migration.
 */
export async function listClaimSources(engine: BrainEngine, opts: { batchSize?: number } = {}): Promise<ClaimSourcesListing> {
  let schema: ClaimSourcesListing['schema'] = 'trust_columns';
  const out: ClaimSource[] = [];
  const legacyCounts = await legacyUnknownBySource(engine).catch(() => null);
  for (const row of await sourceRows(engine)) {
    const config = parseSourceConfig(row.config);
    const report = await runTrustBackfill(engine, { dryRun: true, sources: [row.id], assumeClaimed: [row.id], ...(opts.batchSize ? { batchSize: opts.batchSize } : {}) });
    schema = report.schema;
    const projected = zero();
    const current = report.schema === 'trust_columns' ? zero() : undefined;
    for (const t of report.tables) { add(projected, t.projected); add(current as TierCounts, t.current); }
    const legacy = report.schema === 'pre_trust' || !legacyCounts ? report.rows : legacyCounts.get(row.id) ?? 0;
    const claimed = isClaimedConfig(config);
    const pending = claimed && typeof config[TRUST_CLAIM_LIFTED_AT_KEY] !== 'string';
    const blocker: ClaimBlocker | undefined = isConnectorConfig(config) ? 'connector' : row.archived ? 'archived'
      : claimed ? 'claimed' : legacy === 0 ? 'no_legacy_rows' : undefined;
    out.push({
      id: row.id, name: row.name, local_path: row.local_path,
      remote_url: typeof config.remote_url === 'string' ? config.remote_url : null,
      kind: typeof config.kind === 'string' ? config.kind : null,
      pages: report.tables.find(t => t.table === 'pages')?.rows ?? 0,
      legacy_unknown: legacy, claimed, pending,
      ...(current ? { current } : {}), projected_if_claimed: projected,
      claimable: !blocker, ...(blocker ? { blocker } : {}),
    });
  }
  return { schema, sources: out };
}

/** Records the claim on each source (per-source default operator_curated plus the receipt). Refuses connector and archived sources. */
export async function recordSourceClaims(engine: BrainEngine, ids: readonly string[], now = new Date()): Promise<void> {
  for (const id of ids) {
    const [row] = await engine.executeRaw<{ config: unknown; archived: boolean }>('SELECT config, archived FROM sources WHERE id = $1', [id]);
    if (!row) throw opError('unknown_source', `Source "${id}" does not exist.`, 'List sources with gbrain trust claim-sources --dry-run.');
    const config = parseSourceConfig(row.config);
    if (isConnectorConfig(config)) throw connectorRefusal(id, String(config.kind));
    if (row.archived) throw opError('unknown_source', `Source "${id}" is archived.`, 'Restore it first (gbrain sources restore), or leave it unclaimed.');
    const next: Record<string, unknown> = { ...config, trust_tier: OWNER_TIER_FLOOR, [TRUST_CLAIMED_AT_KEY]: now.toISOString() };
    delete next[TRUST_CLAIM_LIFTED_AT_KEY];
    await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(normalizeSourceConfig(next)), id]);
  }
}

export function connectorRefusal(id: string, kind: string) {
  return opError('invalid_params', `Source "${id}" is a ${kind} connector source, so it cannot be claimed as your own notes.`,
    'Claim only sources that hold your own files; connector text comes from other people and stays "external, untrusted".');
}

export interface ClaimLiftReport {
  sources: Array<{ id: string; tiers: TierCounts }>;
  /** Rows the lift moved off `unknown`, per table. */
  updated: Record<string, number>;
  /** Rows in the lifted sources below operator_curated after the lift (their own signals kept them lower). */
  kept_lower: number;
}

/**
 * Lifts every claimed source whose lift has not finished, through the
 * backfill setting in bounded, resumable batches, then stamps each source's
 * lift receipt. Idempotent: a finished source is skipped.
 */
export async function liftClaimedSources(engine: BrainEngine, opts: { batchSize?: number; log?: (line: string) => void } = {}): Promise<ClaimLiftReport> {
  const pending = (await sourceRows(engine))
    .filter(r => { const c = parseSourceConfig(r.config); return isClaimedConfig(c) && typeof c[TRUST_CLAIM_LIFTED_AT_KEY] !== 'string'; })
    .map(r => r.id);
  if (pending.length === 0) return { sources: [], updated: {}, kept_lower: 0 };
  const report = await runTrustBackfill(engine, { sources: pending, ...(opts.batchSize ? { batchSize: opts.batchSize } : {}), log: opts.log ?? (() => {}) });
  const at = new Date().toISOString();
  for (const id of pending) {
    const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [id]);
    const config = parseSourceConfig(row?.config);
    if (!isClaimedConfig(config)) continue;
    await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2',
      [JSON.stringify(normalizeSourceConfig({ ...config, [TRUST_CLAIM_LIFTED_AT_KEY]: at })), id]);
  }
  const tiers = new Map(pending.map(id => [id, zero()]));
  const counts = await engine.executeRaw<{ source_id: string; tier: string; n: number | string }>(
    `SELECT source_id, tier, sum(n)::bigint AS n FROM (
       SELECT p.source_id, p.trust_tier AS tier, count(*) AS n FROM pages p WHERE p.source_id = ANY($1::text[]) GROUP BY 1, 2
       UNION ALL SELECT f.source_id, f.trust_tier, count(*) FROM facts f WHERE f.source_id = ANY($1::text[]) GROUP BY 1, 2
       UNION ALL SELECT p.source_id, t.trust_tier, count(*) FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = ANY($1::text[]) GROUP BY 1, 2
       UNION ALL SELECT p.source_id, te.trust_tier, count(*) FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.source_id = ANY($1::text[]) GROUP BY 1, 2
     ) c GROUP BY source_id, tier`, [pending]);
  let keptLower = 0;
  for (const c of counts) {
    const tier = isTrustTier(c.tier) ? c.tier : 'unknown';
    tiers.get(c.source_id)![tier] += Number(c.n);
    if (tier !== OWNER_TIER_FLOOR && tier !== 'user_confirmed') keptLower += Number(c.n);
  }
  return {
    sources: pending.map(id => ({ id, tiers: tiers.get(id)! })),
    updated: Object.fromEntries(report.tables.map(t => [t.table, t.updated ?? 0])),
    kept_lower: keptLower,
  };
}

export interface UnclaimedLegacySources {
  /** Unclaimed, non-connector, live sources holding rows at `unknown`, with that count. */
  unclaimed: Array<{ id: string; legacy_unknown: number }>;
  /** Claimed sources whose lift has not finished. */
  pending: string[];
}

/**
 * Doctor, post-upgrade and the behavior-change notice: the sources a claim
 * would help. A brain before the trust migration throws (callers report it
 * as pre-trust); a fresh or empty brain has none.
 */
export async function readUnclaimedLegacySources(engine: Pick<BrainEngine, 'executeRaw'>): Promise<UnclaimedLegacySources> {
  const legacy = await legacyUnknownBySource(engine);
  const rows = await engine.executeRaw<{ id: string; claimed: boolean; lifted: boolean }>(
    `SELECT s.id, ${claimedSourceSql('s')} AS claimed, (s.config ? '${TRUST_CLAIM_LIFTED_AT_KEY}') AS lifted
       FROM sources s WHERE NOT s.archived AND ${notConnectorSourceSql('s')} ORDER BY s.id`);
  return {
    unclaimed: rows.filter(r => !r.claimed && (legacy.get(r.id) ?? 0) > 0).map(r => ({ id: r.id, legacy_unknown: legacy.get(r.id)! })),
    pending: rows.filter(r => r.claimed && !r.lifted).map(r => r.id),
  };
}

/** Legacy rows (claim-state.ts) still at `unknown`, per source, across pages, facts, takes and timeline entries. */
async function legacyUnknownBySource(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Map<string, number>> {
  const ceilings = await readLegacyCeilings(engine);
  const rows = await engine.executeRaw<{ source_id: string; n: number | string }>(
    `SELECT source_id, sum(n)::bigint AS n FROM (
       SELECT p.source_id, count(*) AS n FROM pages p WHERE p.trust_tier = 'unknown' AND p.deleted_at IS NULL AND ${legacyRowSql('pages', 'p', ceilings)} GROUP BY 1
       UNION ALL SELECT f.source_id, count(*) FROM facts f WHERE f.trust_tier = 'unknown' AND ${legacyRowSql('facts', 'f', ceilings)} GROUP BY 1
       UNION ALL SELECT p.source_id, count(*) FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.trust_tier = 'unknown' AND ${legacyRowSql('takes', 't', ceilings)} GROUP BY 1
       UNION ALL SELECT p.source_id, count(*) FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE te.trust_tier = 'unknown' AND ${legacyRowSql('timeline_entries', 'te', ceilings)} GROUP BY 1
     ) u GROUP BY source_id`);
  return new Map(rows.map(r => [r.source_id, Number(r.n)]));
}

export const CLAIM_USER_MESSAGE = 'Your older notes were saved before gbrain tracked where memory comes from, so they read as "unverified origin". '
  + 'Claiming a source tells gbrain those files are your own notes: they become "your notes", except pages that say they were captured, '
  + 'clipped, imported or written by an agent, which keep their lower trust. Connector sources (Gmail, Calendar, GitHub) cannot be claimed. '
  + 'To claim, run `gbrain trust claim-sources` in a terminal on the brain host; it shows each source and asks you to type its id.';

/**
 * The fix for an unclaimed brain: `actor: 'user'`, so `fix.next` is
 * tell_user_to_run (DX-3: every tier-raising fix is the user's to run, and the
 * command needs them at a terminal typing each source id). The agent relays
 * `user_message`, which explains the decision.
 */
export function claimSourcesFix(verifyCheck = 'trust_sources_unclaimed'): Action {
  return {
    argv: [...TRUST_CLAIM_COMMAND], consent: [], actor: 'user', requires_exclusive: false,
    why: 'Claiming raises legacy rows of the sources the owner confirms from "unverified origin" to "your notes" (never to "confirmed by you"); it is the owner\'s decision and needs them at a terminal.',
    user_message: CLAIM_USER_MESSAGE,
    preview_argv: [...TRUST_CLAIM_COMMAND, '--dry-run', '--json'],
    verify: { argv: ['gbrain', 'doctor', '--only', verifyCheck, '--json'] },
  };
}
