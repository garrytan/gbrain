/**
 * #6712 PR 4b (design v3.2 §8): `sync.admission`, the brain-wide switch that pauses what a managed pass admits.
 *
 * - `normal` (the default): the pass admits everything it classifies.
 * - `imports_only`: no deletes and no keep_db writes; those paths settle as `paused_deletes` / `paused_keep_db`.
 * - `classify_only`: the pass reads and classifies, writes telemetry only, and stamps nothing (stop `admission_paused`).
 *
 * The value is read at pin, inside every group's admission transaction, and by the destructive kinds at publication, so
 * a change takes effect at the next group. An unrecognized stored value reads as `classify_only` (fail closed).
 *
 * `set_at`: the config table has no timestamp, so local `gbrain config set` (`writeSyncAdmission`) records the value
 * and the database's clock in an `op_checkpoints` row (`op='sync-admission'`, fingerprint `brain`) in the same
 * transaction as the config row. The row dates the stored value only while it names that value: a value written any
 * other way (or a row the checkpoint GC dropped) reads `set_at: null`. `syncAdmissionStatus` turns `effective` once
 * no pass pinned before `set_at` holds the lease and no destructive request admitted before it is unpublished; with
 * `set_at` unknown, every open pass and every unpublished destructive request counts as earlier.
 */
import type { BrainEngine } from '../engine.ts';
import { syncLockId } from '../db-lock.ts';
import { MANAGED_SYNC_PASS_OP, passFingerprint } from './sync-pass-row.ts';

export const SYNC_ADMISSION_KEY = 'sync.admission';
export const SYNC_ADMISSION_VALUES = ['normal', 'imports_only', 'classify_only'] as const;
export type SyncAdmission = typeof SYNC_ADMISSION_VALUES[number];

export function parseSyncAdmission(value: string | null | undefined): SyncAdmission {
  const trimmed = value?.trim();
  if (!trimmed) return 'normal';
  return (SYNC_ADMISSION_VALUES as readonly string[]).includes(trimmed) ? trimmed as SyncAdmission : 'classify_only';
}

/** The value in effect, read in the caller's transaction (`tx`) when given, so admission and publication see one value. */
export async function readSyncAdmission(engine: Pick<BrainEngine, 'executeRaw'>): Promise<SyncAdmission> {
  const [row] = await engine.executeRaw<{ value: string | null }>('SELECT value FROM config WHERE key=$1', [SYNC_ADMISSION_KEY]);
  return parseSyncAdmission(row?.value ?? null);
}

/** Whether a kind of write may be admitted (or published) under `admission`. */
export function admissionAllows(admission: SyncAdmission, kind: 'import' | 'destructive'): boolean {
  if (admission === 'normal') return true;
  return admission === 'imports_only' && kind === 'import';
}

/** The `op_checkpoints` row that dates the stored value (see the module comment). */
export const SYNC_ADMISSION_SET_OP = 'sync-admission';
const SET_FINGERPRINT = 'brain';
/** The destructive request kinds (design §8): a managed delete, and the DB-wins reconcile keep_db admits. */
export const SYNC_ADMISSION_DESTRUCTIVE_KINDS = ['managed_sync_delete', 'canonical_reconcile'] as const;

type Exec = Pick<BrainEngine, 'executeRaw'>;
const iso = (value: Date | string | null | undefined) => value == null ? null : new Date(value).toISOString();

export interface SyncAdmissionSetting {
  /** The value in effect (`parseSyncAdmission` of the stored one). */
  value: SyncAdmission;
  /** The stored config value, verbatim (null when unset). */
  stored: string | null;
  /** When local `config set` wrote the stored value (database clock), or null when unknown or unset. */
  set_at: string | null;
}

export interface SyncAdmissionStatus { value: SyncAdmission; set_at: string | null; effective: boolean }

/** The value in effect, the stored value and its `set_at`, in one read. */
export async function readSyncAdmissionSetting(engine: Exec): Promise<SyncAdmissionSetting> {
  const { raw_set_at, ...setting } = await readSetting(engine);
  return { ...setting, set_at: iso(raw_set_at) };
}

/** The raw setting row: the stored config value and the dating row's value and `set_at`. */
export interface SyncAdmissionSettingRow { stored: string | null; row_value: string | null; set_at: string | null }

/**
 * The setting's columns and joins for a read that folds it in (`sync status` rides its source read, keeping its statement
 * budget): `$k`..`$k+2` bind `SYNC_ADMISSION_SETTING_PARAMS`, and the columns are `admission_stored`, `admission_row_value`
 * and `admission_set_at`.
 */
export const syncAdmissionSettingSql = (k: number) => ({
  columns: `ac.value AS admission_stored, ao.completed_keys->0->>'value' AS admission_row_value, ao.completed_keys->0->>'set_at' AS admission_set_at`,
  joins: `LEFT JOIN config ac ON ac.key=$${k} LEFT JOIN op_checkpoints ao ON ao.op=$${k + 1} AND ao.fingerprint=$${k + 2}` });
export const SYNC_ADMISSION_SETTING_PARAMS = [SYNC_ADMISSION_KEY, SYNC_ADMISSION_SET_OP, SET_FINGERPRINT];

async function readSetting(engine: Exec): Promise<Omit<SyncAdmissionSetting, 'set_at'> & { raw_set_at: string | null }> {
  const [row] = await engine.executeRaw<SyncAdmissionSettingRow>(
    `SELECT c.value AS stored, o.completed_keys->0->>'value' AS row_value, o.completed_keys->0->>'set_at' AS set_at
       FROM (SELECT 1) one LEFT JOIN config c ON c.key=$1 LEFT JOIN op_checkpoints o ON o.op=$2 AND o.fingerprint=$3`,
    SYNC_ADMISSION_SETTING_PARAMS);
  return settingOf(row);
}
function settingOf(row: SyncAdmissionSettingRow | undefined): Omit<SyncAdmissionSetting, 'set_at'> & { raw_set_at: string | null } {
  const stored = row?.stored ?? null;
  return { value: parseSyncAdmission(stored), stored, raw_set_at: stored !== null && row?.row_value === stored ? row.set_at : null };
}

/** Stores `value` and its `set_at` (database clock) in one transaction; returns `set_at`. The caller validated `value`. */
export async function writeSyncAdmission(engine: Pick<BrainEngine, 'transaction'>, value: SyncAdmission): Promise<string> {
  return engine.transaction(async tx => {
    await tx.setConfig(SYNC_ADMISSION_KEY, value);
    const [row] = await tx.executeRaw<{ set_at: string }>(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('value',$3::text,'set_at',clock_timestamp())),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
      RETURNING completed_keys->0->>'set_at' AS set_at`, [SYNC_ADMISSION_SET_OP, SET_FINGERPRINT, value]);
    return iso(row!.set_at)!;
  });
}

/** `effective`'s two probes as SQL: `e` names the expressions they read (binds, or columns of an enclosing read). */
function effectProbes(e: { lock: string; passOp: string; passKey: string; setAt: string; sourceId: string; incarnation: string; kinds: string }) {
  return {
    pinned: `EXISTS (SELECT 1 FROM op_checkpoints p JOIN gbrain_cycle_locks l ON l.id=${e.lock} AND l.ttl_expires_at > now()
          AND l.acquisition_token::text = p.completed_keys->0->>'lease_token'
        WHERE p.op=${e.passOp} AND p.fingerprint=${e.passKey} AND p.completed_keys->0->'telemetry'->>'outcome'='open'
          AND (${e.setAt} IS NULL OR (p.completed_keys->0->'telemetry'->>'started_at')::timestamptz < ${e.setAt}))`,
    destructive: `EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id=${e.sourceId} AND r.source_incarnation=${e.incarnation}
          AND r.state IN ('queued','running','recovering') AND r.intent->>'kind' = ANY(${e.kinds})
          AND (${e.setAt} IS NULL OR r.created_at < ${e.setAt}))`,
  };
}

/**
 * GBRA-135: `effective`'s probes folded into a read that joins the setting (`syncAdmissionSettingSql`) and the source row
 * `src`, as columns `admission_pinned` and `admission_destructive`: `sync status` reads them with its source, so a
 * restricted value costs it no statement of its own. `$k`..`$k+2` bind `syncAdmissionEffectParams`. Both are null while
 * the stored value reads as `normal` (the guard trims less than `parseSyncAdmission`, so any other value is probed).
 */
export function syncAdmissionEffectSql(k: number, src: string): string {
  const setAt = "(CASE WHEN ao.completed_keys->0->>'value' = ac.value THEN (ao.completed_keys->0->>'set_at')::timestamptz END)";
  const probes = effectProbes({ lock: `$${k}`, kinds: `$${k + 1}::text[]`, passOp: `$${k + 2}`, passKey: `${src}.id||':'||${src}.incarnation::text`, setAt,
    sourceId: `${src}.id`, incarnation: `${src}.incarnation` });
  const restricted = "COALESCE(btrim(ac.value), '') NOT IN ('', 'normal')";
  return `CASE WHEN ${restricted} THEN ${probes.pinned} END AS admission_pinned, CASE WHEN ${restricted} THEN ${probes.destructive} END AS admission_destructive`;
}
export const syncAdmissionEffectParams = (sourceId: string) => [syncLockId(sourceId), [...SYNC_ADMISSION_DESTRUCTIVE_KINDS], MANAGED_SYNC_PASS_OP];

/** A setting row with `effective`'s probes read beside it (`syncAdmissionEffectSql`). */
export interface SyncAdmissionEffectRow extends SyncAdmissionSettingRow { pinned: boolean | null; destructive: boolean | null }

/**
 * `sync status`'s `admission` of one source incarnation (design §8). `effective` is always true for `normal`; otherwise
 * it is false while the source's pass row is `open` with `started_at` before `set_at` and its `lease_token` holds the
 * live drain lease, or while a destructive request of the incarnation admitted before `set_at` is still queued,
 * running or recovering. `read` is the setting row a caller already read with `syncAdmissionSettingSql`, and its probes
 * when it read them too (`syncAdmissionEffectSql`).
 */
export async function syncAdmissionStatus(engine: Exec, sourceId: string, incarnation: string, read?: SyncAdmissionSettingRow | SyncAdmissionEffectRow): Promise<SyncAdmissionStatus> {
  const { value, raw_set_at } = read ? settingOf(read) : await readSetting(engine);
  const set_at = iso(raw_set_at);
  if (value === 'normal') return { value, set_at, effective: true };
  const probes = effectProbes({ lock: '$1', passOp: '$2', passKey: '$3', setAt: '$4::timestamptz', sourceId: '$5', incarnation: '$6::uuid', kinds: '$7::text[]' });
  const [row] = read && 'pinned' in read && read.pinned !== null && read.destructive !== null ? [read]
    : await engine.executeRaw<{ pinned: boolean; destructive: boolean }>(`SELECT ${probes.pinned} AS pinned, ${probes.destructive} AS destructive`,
      [syncLockId(sourceId), MANAGED_SYNC_PASS_OP, passFingerprint(sourceId, incarnation), raw_set_at, sourceId, incarnation, [...SYNC_ADMISSION_DESTRUCTIVE_KINDS]]);
  return { value, set_at, effective: !row?.pinned && !row?.destructive };
}
