/**
 * config-keys.ts — connector config-table keys + the pure staleness gate.
 *
 * All connector knobs live in the `config` table under the `connectors.` prefix
 * (registered in KNOWN_CONFIG_KEY_PREFIXES). No secrets here — credentials are
 * file-plane only. Sync progress (watermark, last sync, per-conversation
 * ledger) is keyed by (provider, source); see sync.ts for why it is NOT
 * op_checkpoint. The auth-error stamp stays per provider: it describes the
 * shared credential, not a source.
 */

import type { BrainEngine } from '../engine.ts';
import type { ConnectorProviderName } from './types.ts';

/** Trailing gap-heal window behind the watermark, in days. */
export const DEFAULT_WINDOW_DAYS = 7;
/** Daily default cadence (OV#4): scheduled auto-sync floor, in minutes. */
export const DEFAULT_SYNC_FLOOR_MIN = 1440;
/** Doctor flags a stalled sync past this many hours (NOT the dispatch floor). */
export const DEFAULT_DOCTOR_STALE_HOURS = 72;
/** Kick off an embed backfill after a run imports at least this many pages. */
export const DEFAULT_EMBED_KICKOFF_MIN_PAGES = 25;

export const CONNECTORS_CONFIG_PREFIX = 'connectors.';

export const sourceIdKey = () => 'connectors.source_id';
export const syncFloorMinKey = () => 'connectors.sync_floor_min';
export const embedKickoffMinPagesKey = () => 'connectors.embed_kickoff_min_pages';
export const doctorStaleHoursKey = () => 'connectors.doctor_stale_hours';

export const autoSyncKey = (p: ConnectorProviderName) => `connectors.${p}.auto_sync`;
export const authErrorAtKey = (p: ConnectorProviderName) => `connectors.${p}.auth_error_at`;

export type ConnectorSourceField = 'watermark_iso' | 'last_sync_at' | 'synced' | 'failed';
/** Per-(provider, source) sync state. */
export const connectorSourceKey = (p: ConnectorProviderName, sourceId: string, field: ConnectorSourceField) =>
  `connectors.${p}.source.${sourceId}.${field}`;
export const lastSyncAtKey = (p: ConnectorProviderName, sourceId: string) => connectorSourceKey(p, sourceId, 'last_sync_at');
export const watermarkKey = (p: ConnectorProviderName, sourceId: string) => connectorSourceKey(p, sourceId, 'watermark_iso');
/** Pre-per-source scalar; it can only have described the scheduled source. */
const legacyProviderKey = (p: ConnectorProviderName, field: 'watermark_iso' | 'last_sync_at') => `connectors.${p}.${field}`;

/**
 * Read a per-source watermark / last-sync stamp. A legacy per-provider value
 * is honored only for the scheduled source (`connectors.source_id`, default
 * 'default') and only until that source writes its own key.
 */
export async function readConnectorState(
  engine: BrainEngine, p: ConnectorProviderName, sourceId: string, field: 'watermark_iso' | 'last_sync_at',
): Promise<string | null> {
  const own = await engine.getConfig(connectorSourceKey(p, sourceId, field));
  if (own) return own;
  if (own !== null) return null;
  const scheduled = (await engine.getConfig(sourceIdKey())) || 'default';
  if (sourceId !== scheduled) return null;
  return (await engine.getConfig(legacyProviderKey(p, field))) || null;
}

/** Write a per-source stamp; the scheduled source retires the legacy scalar. */
export async function writeConnectorState(
  engine: BrainEngine, p: ConnectorProviderName, sourceId: string, field: 'watermark_iso' | 'last_sync_at', value: string,
): Promise<void> {
  await engine.setConfig(connectorSourceKey(p, sourceId, field), value);
  const scheduled = (await engine.getConfig(sourceIdKey())) || 'default';
  if (sourceId === scheduled && await engine.getConfig(legacyProviderKey(p, field))) {
    await engine.setConfig(legacyProviderKey(p, field), '');
  }
}

/** The canonical truthiness parser for `auto_sync`-style flags. */
export function isTruthy(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Pure staleness gate — never reads the clock (caller injects `nowMs`).
 * Returns true when a scheduled sync is due: no prior sync, or the last one is
 * older than `floorMin` minutes.
 */
export function isConnectorSyncStale(
  lastSyncAtIso: string | null | undefined,
  nowMs: number,
  floorMin: number,
): boolean {
  if (!lastSyncAtIso) return true;
  const last = Date.parse(lastSyncAtIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= floorMin * 60_000;
}
