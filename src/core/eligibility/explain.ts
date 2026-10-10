/**
 * DX-10 `gbrain trust explain` data API: why a memory is (or is not) used.
 * For one typed ref it returns the stored tier and origin, the write-gate
 * verdict and receipts, and the activation decision on every registered
 * proactive surface plus explicit reads. Deterministic, read-only, zero
 * model calls. The CLI (lane L1a) renders it; nothing here prints.
 *
 * Refs (DX-7): `f<id>` fact, `t<id>` take, `e<id>` timeline entry, `h<id>`
 * write-gate hold, `p:<source>/<slug>` page.
 */
import type { BrainEngine } from '../engine.ts';
import { QUARANTINE_KEY } from '../quarantine.ts';
import { getWriteGateHold, parseHoldRef } from '../write-gate-store.ts';
import { admitsTrust, compareTrust, storedTrustTier, trustLabel, type TrustTier } from '../trust/tier.ts';
import { ACTIVATION_REASON_FAMILIES, ACTIVATION_TIER_CEILING, type EligibilityTable } from './sql.ts';
import { FILTER_POLICY_FLOOR, loadTrustReadConfig, type TrustReadConfig } from './policy.ts';
import { PROACTIVE_SURFACES, type ProactiveSurface } from './registry.ts';
import { trustFields, trustLabelWords } from './labels.ts';

type Exec = Pick<BrainEngine, 'executeRaw' | 'getConfig'>;

export type ExplainRef =
  | { kind: 'row'; table: Exclude<EligibilityTable, 'pages'>; id: number }
  | { kind: 'page'; sourceId: string; slug: string }
  | { kind: 'hold'; id: number };

/** Parses a typed ref; null when it names nothing. */
export function parseExplainRef(ref: string): ExplainRef | null {
  const r = ref.trim();
  const page = /^p:([^/]+)\/(.+)$/.exec(r);
  if (page) return { kind: 'page', sourceId: page[1], slug: page[2] };
  const hold = parseHoldRef(r);
  if (hold !== null) return { kind: 'hold', id: hold };
  const row = /^([fte])(\d+)$/.exec(r);
  if (!row) return null;
  const table = ({ f: 'facts', t: 'takes', e: 'timeline_entries' } as const)[row[1] as 'f' | 't' | 'e'];
  return { kind: 'row', table, id: Number(row[2]) };
}

export type SurfaceDecision = 'eligible' | 'suppressed' | 'below_floor' | 'quarantined' | 'needs_rederive' | 'held' | 'not_live';

export interface TrustReceiptView {
  id: number; verdict: string; reason_families: string[]; detector_version: number; tier: string; created_at: string; last_seen_at: string;
}

export interface TrustExplanation {
  ref: string;
  found: boolean;
  table?: EligibilityTable | 'write_gate_holds';
  id?: number;
  trust_tier?: TrustTier;
  label?: string;
  origin?: string;
  write_origin?: Record<string, unknown> | null;
  /** The newest receipt's verdict, or `allow` when the gate never flagged it. */
  verdict?: string;
  receipts: TrustReceiptView[];
  /** Instruction-family flag on an agent-written-or-lower row: withheld from proactive surfaces until confirmed. */
  unconfirmed: boolean;
  quarantined_page: boolean;
  needs_rederive: boolean;
  config: TrustReadConfig;
  /** Per proactive surface, plus `explicit_reads` (search, query, recall, get_page under the brain's read policy). */
  activation: Record<ProactiveSurface | 'explicit_reads', SurfaceDecision>;
  /** What the owner can run next (confirm or review); always the owner's command, never auto-applied. */
  next?: string[];
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

async function receiptsFor(engine: Exec, table: string, id: number): Promise<TrustReceiptView[]> {
  const rows = await engine.executeRaw<TrustReceiptView & { id: string | number }>(
    `SELECT id, verdict, reason_families, detector_version, tier, ${ISO('created_at')} AS created_at, ${ISO('last_seen_at')} AS last_seen_at
       FROM write_gate_receipts WHERE target_table = $1 AND target_id = $2 ORDER BY last_seen_at DESC, id DESC LIMIT 20`, [table, String(id)]);
  return rows.map(r => ({ ...r, id: Number(r.id), detector_version: Number(r.detector_version) }));
}

const ROW_SQL: Readonly<Record<Exclude<EligibilityTable, 'pages'>, string>> = {
  facts: `SELECT r.id, r.trust_tier, r.write_origin, (r.expired_at IS NULL) AS live,
      EXISTS (SELECT 1 FROM pages q WHERE q.source_id = r.source_id AND q.slug = r.source_markdown_slug AND q.deleted_at IS NULL
        AND COALESCE(q.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}') AS quarantined
    FROM facts r WHERE r.id = $1`,
  takes: `SELECT r.id, r.trust_tier, r.write_origin, r.active AS live, (COALESCE(q.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}') AS quarantined
    FROM takes r JOIN pages q ON q.id = r.page_id WHERE r.id = $1`,
  timeline_entries: `SELECT r.id, r.trust_tier, r.write_origin, (q.deleted_at IS NULL) AS live, (COALESCE(q.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}') AS quarantined
    FROM timeline_entries r JOIN pages q ON q.id = r.page_id WHERE r.id = $1`,
};

/** The explanation for one ref (found: false when it names nothing). */
export async function explainTrust(engine: Exec, ref: string): Promise<TrustExplanation> {
  const config = await loadTrustReadConfig(engine);
  const parsed = parseExplainRef(ref);
  const empty = (): TrustExplanation => ({ ref, found: false, receipts: [], unconfirmed: false, quarantined_page: false, needs_rederive: false, config,
    activation: decisions('not_live', 'not_live') });
  if (!parsed) return empty();

  if (parsed.kind === 'hold') {
    const hold = await getWriteGateHold(engine, parsed.id);
    if (!hold) return empty();
    const tier = storedTrustTier(hold.tier);
    const held = hold.status === 'held' || hold.status === 'dropped';
    return { ref, found: true, table: 'write_gate_holds', id: hold.id, trust_tier: tier, label: trustLabel(tier), origin: trustFields(tier, hold.write_origin).origin,
      write_origin: hold.write_origin as Record<string, unknown> | null, verdict: 'quarantine', receipts: await receiptsFor(engine, 'write_gate_holds', hold.id),
      unconfirmed: false, quarantined_page: false, needs_rederive: false, config, activation: decisions(held ? 'held' : 'not_live', held ? 'held' : 'not_live'),
      ...(hold.status === 'held' ? { next: ['gbrain', 'trust', 'review'] } : {}) };
  }

  let table: EligibilityTable;
  let row: { id: number | string; trust_tier: string; write_origin: unknown; live: boolean; quarantined: boolean } | undefined;
  if (parsed.kind === 'page') {
    table = 'pages';
    [row] = await engine.executeRaw(
      `SELECT id, trust_tier, write_origin, (deleted_at IS NULL) AS live, (COALESCE(frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}') AS quarantined
         FROM pages WHERE source_id = $1 AND slug = $2`, [parsed.sourceId, parsed.slug]);
  } else {
    table = parsed.table;
    [row] = await engine.executeRaw(ROW_SQL[parsed.table], [parsed.id]);
  }
  if (!row) return empty();
  const id = Number(row.id);
  const tier = storedTrustTier(row.trust_tier);
  const receipts = await receiptsFor(engine, table, id);
  const [rederive] = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM needs_rederive WHERE derived_table = $1 AND derived_id = $2', [table, String(id)]);
  const needsRederive = Number(rederive?.n ?? 0) > 0;
  const flagged = receipts.some(r => r.verdict === 'flag' && r.reason_families.some(f => (ACTIVATION_REASON_FAMILIES as readonly string[]).includes(f)));
  const unconfirmed = flagged && compareTrust(tier, ACTIVATION_TIER_CEILING) <= 0;
  const policyFloor = config.mode === 'filter' ? FILTER_POLICY_FLOOR : undefined;

  const gone: SurfaceDecision | null = !row.live ? 'not_live' : row.quarantined ? 'quarantined' : needsRederive ? 'needs_rederive'
    : policyFloor && !admitsTrust(tier, policyFloor) ? 'below_floor' : null;
  const proactive: SurfaceDecision = gone ?? (unconfirmed && config.activation === 'suppress' ? 'suppressed' : 'eligible');
  const fields = trustFields(tier, row.write_origin);
  return {
    ref, found: true, table, id, trust_tier: tier, label: trustLabelWords(fields, { unconfirmed }), origin: fields.origin,
    write_origin: typeof row.write_origin === 'string' ? JSON.parse(row.write_origin) : row.write_origin as Record<string, unknown> | null,
    verdict: receipts[0]?.verdict ?? 'allow', receipts, unconfirmed, quarantined_page: row.quarantined === true, needs_rederive: needsRederive, config,
    activation: decisions(proactive, gone ?? 'eligible'),
    ...(unconfirmed ? { next: ['gbrain', 'trust', 'review'] } : {}),
  };
}

function decisions(proactive: SurfaceDecision, explicit: SurfaceDecision): TrustExplanation['activation'] {
  const out = { explicit_reads: explicit } as TrustExplanation['activation'];
  for (const surface of Object.keys(PROACTIVE_SURFACES) as ProactiveSurface[]) out[surface] = proactive;
  return out;
}
