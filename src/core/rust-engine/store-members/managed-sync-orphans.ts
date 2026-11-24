/**
 * Managed-sync orphans (BrainEngine listManagedSyncOrphanRows through deleteManagedSyncManifest, the statements of
 * engine-sql/managed-sync-orphans.ts) and the owned-content reads (listOwnedContentRows, readContentReceiptBinding,
 * readConfigForUpdate, engine-sql/owned-content.ts). Each member evaluates the statement's predicates over what the
 * store keeps: the op checkpoint rows, the source's requests, its sources, its local writers and its cycle locks.
 * Where the result differs from Postgres: rust/docs/store/repair-bookkeeping.md, "Managed-sync orphans".
 */
import type {
  ManagedSyncCursorRow, ManagedSyncFailureRow, ManagedSyncOrphanRows, ManagedSyncPassRow, ManagedSyncRetireMode,
  ManagedSyncRetireTarget, ManagedSyncRetiredCursorRow, SourceManagedSyncFailure,
} from '../../engine-sql/managed-sync-orphans.ts';
import type { ContentReceiptBinding, OwnedContentRow } from '../../engine-sql/owned-content.ts';
import { CHECKPOINT_MOVED_MESSAGE } from '../../persistence/sync-slug-mode.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

/** A SQL boolean: true, false or unknown (null). */
type Bool3 = boolean | null;

/** One `op_checkpoints` parent as the store lists it. */
interface CheckpointRow { fingerprint: string; completed_keys: unknown; updated_at: string; updated_at_us: number }
/** One request with the columns the predicates test (`listSourceRequestRows`). */
interface RequestRow {
  request_id: string; source_incarnation: string; state: string; recovery: boolean; error_code: string | null;
  error_message: string | null; intent: unknown; sequence: number; principal_kind: string; principal_id: string;
}
/** One active or archived source with what the predicates read. */
interface SourceRow { id: string; incarnation: string; last_commit: string | null; config: unknown; archived: boolean }

const OPEN_STATES = ['queued', 'running', 'recovering'];
const TERMINAL_STATES = ['committed', 'failed', 'conflict', 'cancelled'];

/** `j->'key'`: the member of an object, else SQL null (undefined). */
function get(value: unknown, ...path: string[]): unknown {
  let out = value;
  for (const key of path) {
    if (out === null || typeof out !== 'object' || Array.isArray(out)) return undefined;
    out = (out as Record<string, unknown>)[key];
  }
  return out;
}

/** `j->>'key'`: a string as itself, JSON null and a missing member as SQL null, any other value as its JSON text. */
function text(value: unknown, ...path: string[]): string | null {
  const out = get(value, ...path);
  if (out === undefined || out === null) return null;
  return typeof out === 'string' ? out : JSON.stringify(out);
}

/** `completed_keys->0`. */
function first(completedKeys: unknown): unknown {
  return Array.isArray(completedKeys) ? completedKeys[0] : undefined;
}

/** `x::int`, with text that is not an integer read as SQL null (Postgres raises). */
function int(value: string | null): number | null {
  return value !== null && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : null;
}

/** `x::uuid` in canonical form, with text that is not a UUID read as SQL null (Postgres raises). */
function uuid(value: string | null): string | null {
  if (value === null) return null;
  const hex = value.trim().replace(/^\{(.*)\}$/, '$1').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A non-null text that is not a UUID: Postgres raises on its cast, so a write keeps its row. */
const badUuid = (value: string | null) => value !== null && uuid(value) === null;

/** `a = b` over text. */
const eq = (a: string | null, b: string | null): Bool3 => (a === null || b === null ? null : a === b);
/** `a IS DISTINCT FROM b`. */
const distinct = (a: string | null, b: string | null) => a !== b;

/** SQL AND over three-valued operands. */
function and3(...values: Bool3[]): Bool3 {
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}

/** `jsonb ? key`: an object's key, an array's string element, or a string scalar equal to it. */
function hasKey(value: unknown, key: string): Bool3 {
  if (value === undefined || value === null) return value === null ? false : null;
  if (Array.isArray(value)) return value.includes(key);
  if (typeof value === 'object') return Object.prototype.hasOwnProperty.call(value, key);
  return value === key;
}

/** Byte order of the UTF-8 text, the store's collation. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

const notDone = (k0: unknown) => (text(k0, 'done') ?? 'false') !== 'true';
const isOpen = (r: RequestRow) => OPEN_STATES.includes(r.state) || r.recovery;

/** What one classification or retirement reads from the store. */
class Snapshot {
  private readonly requests = new Map<string, RequestRow[]>();
  private sources: SourceRow[] | null = null;
  constructor(private readonly brain: StoreBrain, private readonly member: string) {}

  async allSources(): Promise<SourceRow[]> {
    if (this.sources) return this.sources;
    const records: Array<{ id: string; last_commit?: string | null; config: unknown; archived?: boolean }> =
      await storeCall({ member: this.member }, () => this.brain.listSourceRecords());
    const out: SourceRow[] = [];
    for (const record of records) {
      const row: { incarnation: unknown } | null =
        await storeCall({ member: this.member, sourceId: record.id }, () => this.brain.readSourceIncarnation(record.id));
      if (!row) continue;
      const config = typeof record.config === 'string' ? JSON.parse(record.config) : record.config;
      out.push({ id: record.id, incarnation: String(row.incarnation), last_commit: record.last_commit ?? null, config, archived: record.archived === true });
    }
    this.sources = out;
    return out;
  }

  /** The active source `id`, when it exists. */
  async active(id: string | null): Promise<SourceRow | undefined> {
    if (id === null) return undefined;
    return (await this.allSources()).find(s => s.id === id && !s.archived);
  }

  async requestsOf(sourceId: string): Promise<RequestRow[]> {
    let rows = this.requests.get(sourceId);
    if (!rows) {
      rows = await storeCall({ member: this.member, sourceId }, () => this.brain.listSourceRequestRows(sourceId)) as RequestRow[];
      this.requests.set(sourceId, rows);
    }
    return rows;
  }

  async checkpoints(op: string): Promise<CheckpointRow[]> {
    return storeCall({ member: this.member }, () => this.brain.listOpCheckpointRecords(op)) as Promise<CheckpointRow[]>;
  }

  async checkpoint(op: string, fingerprint: string): Promise<{ completed_keys: unknown } | null> {
    return storeCall({ member: this.member }, () => this.brain.readOpCheckpointRecord(op, fingerprint, null));
  }

  /** `principal_live`: an unrevoked local writer of that id, for a local principal kind. */
  async principalLive(kind: string | null, id: string | null): Promise<boolean> {
    if (id === null || (kind !== 'local_cli' && kind !== 'local_stdio')) return false;
    const writer: { revoked_at: string | null } | null =
      await storeCall({ member: this.member }, () => this.brain.readLocalWriter(id));
    return writer != null && writer.revoked_at == null;
  }

  /** The request `request_id = $id::uuid` of the source. */
  async request(sourceId: string, id: string | null): Promise<RequestRow | undefined> {
    const want = uuid(id);
    if (want === null) return undefined;
    return (await this.requestsOf(sourceId)).find(r => uuid(r.request_id) === want);
  }

  /** `checkpointMovedSql` for the cursor's first record `k0` and its fingerprint. */
  async checkpointMoved(s: SourceRow, k0: unknown, fingerprint: string, msg: string): Promise<Bool3> {
    const m = await this.request(s.id, text(k0, 'pending', 'requestId'));
    const refused = m !== undefined && ['failed', 'conflict'].includes(m.state) && !m.recovery
      && m.error_code === 'revision_conflict' && m.error_message === msg;
    const open = (await this.requestsOf(s.id)).some(o => text(o.intent, 'cursorKey') === fingerprint && isOpen(o));
    return and3(
      eq(text(k0, 'pending', 'intent', 'kind'), 'managed_sync_checkpoint'), text(k0, 'companyReceiptId') === null,
      geq(k0), distinct(s.last_commit, text(k0, 'from')),
      or3(eq(text(k0, 'pending', 'intent', 'slice', 'done'), 'false'), distinct(s.last_commit, text(k0, 'target'))),
      refused, !open,
    );
  }

  /** `slugModeRefusedSql` for the cursor's first record `k0` and its fingerprint. */
  async slugModeRefused(s: SourceRow, k0: unknown, fingerprint: string): Promise<Bool3> {
    const m = await this.request(s.id, text(k0, 'pending', 'requestId'));
    const refused = m !== undefined && ['failed', 'conflict'].includes(m.state) && !m.recovery && m.error_code === 'slug_root_mode_mismatch';
    const open = (await this.requestsOf(s.id)).some(o => text(o.intent, 'cursorKey') === fingerprint && isOpen(o));
    const mode = text(s.config, 'slug_root_mode');
    return and3(
      eq(text(k0, 'pending', 'intent', 'kind'), 'managed_sync_checkpoint'), text(k0, 'companyReceiptId') === null,
      geq(k0), mode !== null, distinct(mode, text(k0, 'slugMode')), refused, !open,
    );
  }

  /** `passStampSql`: the newest stamp request of the pass row's pass. */
  async passStamp(s: SourceRow, k0: unknown): Promise<RequestRow | undefined> {
    const passId = text(k0, 'telemetry', 'pass_id');
    let newest: RequestRow | undefined;
    for (const n of await this.requestsOf(s.id)) {
      if (text(n.intent, 'kind') !== 'managed_sync_checkpoint' || passId === null || text(n.intent, 'passId') !== passId) continue;
      if (!newest || n.sequence > newest.sequence) newest = n;
    }
    return newest;
  }

  /** `passSlugModeRefusedSql(req)` for the pass row's first record `k0`, with `req` the stamp request id (or null). */
  async passSlugModeRefused(s: SourceRow, k0: unknown, req: string | null): Promise<boolean> {
    const passId = text(k0, 'telemetry', 'pass_id');
    const passMode = text(k0, 'obligations', 'slug_mode');
    const mode = text(s.config, 'slug_root_mode');
    if (passMode === null || mode === null || mode === passMode || passId === null) return false;
    const m = await this.request(s.id, req);
    if (!m || text(m.intent, 'kind') !== 'managed_sync_checkpoint' || text(m.intent, 'passId') !== passId
      || !['failed', 'conflict'].includes(m.state) || m.recovery || m.error_code !== 'slug_root_mode_mismatch') return false;
    return !(await this.requestsOf(s.id)).some(o => text(o.intent, 'passId') === passId && isOpen(o));
  }
}

/** `(k0->>'index')::int >= (k0->>'total')::int`. */
function geq(k0: unknown): Bool3 {
  const index = int(text(k0, 'index'));
  const total = int(text(k0, 'total'));
  return index === null || total === null ? null : index >= total;
}

/** SQL OR over three-valued operands. */
function or3(...values: Bool3[]): Bool3 {
  if (values.includes(true)) return true;
  return values.includes(null) ? null : false;
}

/** The order `ORDER BY s.id, c.updated_at, c.fingerprint`, in the store's byte order. */
function bySourceTimeKey<T extends { source_id: string; cursor_key: string }>(rows: Array<{ row: T; us: number }>): T[] {
  return rows.sort((a, b) => byteCmp(a.row.source_id, b.row.source_id) || a.us - b.us || byteCmp(a.row.cursor_key, b.row.cursor_key))
    .map(r => r.row);
}

/** The five reads of the classification. */
export const listManagedSyncOrphanRows: StoreMember<[sourceIds: readonly string[] | null], ManagedSyncOrphanRows> =
  async (brain, sourceIds) => {
    const snap = new Snapshot(brain, 'listManagedSyncOrphanRows');
    const wanted = (s: SourceRow) => !s.archived && (sourceIds === null || sourceIds.includes(s.id));
    const sources = (await snap.allSources()).filter(wanted);
    const byId = new Map(sources.map(s => [s.id, s]));
    const sync = await snap.checkpoints('managed-sync');
    const failureRows = await snap.checkpoints('managed-sync-failure');
    const passRows = await snap.checkpoints('managed-sync-pass');
    const syncKeys = new Set(sync.map(c => c.fingerprint));
    const openSyncKeys = new Set(sync.filter(c => notDone(first(c.completed_keys))).map(c => c.fingerprint));
    const passKeys = new Set(passRows.map(p => p.fingerprint));

    const cursors: Array<{ row: ManagedSyncCursorRow; us: number }> = [];
    const retiredCursors: Array<{ row: ManagedSyncRetiredCursorRow; us: number }> = [];
    for (const c of sync) {
      const k0 = first(c.completed_keys);
      const s = byId.get(text(k0, 'sourceId') ?? '');
      const incarnation = text(k0, 'incarnation');
      if (!s || !notDone(k0) || incarnation === null) continue;
      const principalKind = text(k0, 'authority', 'writer', 'principal', 'kind');
      const principalId = text(k0, 'authority', 'writer', 'principal', 'id');
      const pendingRequestId = text(k0, 'pending', 'requestId');
      const updatedAt = c.updated_at;
      if (s.incarnation === incarnation) {
        const r = await snap.request(s.id, pendingRequestId);
        const pending = r && r.source_incarnation === s.incarnation && r.principal_id === principalId && r.principal_kind === principalKind ? r : undefined;
        const superseded = sync.some(n => {
          const n0 = first(n.completed_keys);
          return n.fingerprint !== c.fingerprint && text(n0, 'sourceId') === s.id && text(n0, 'incarnation') === s.incarnation
            && (text(n0, 'done') ?? 'false') === 'true' && n.updated_at_us > c.updated_at_us;
        });
        cursors.push({ us: c.updated_at_us, row: {
          cursor_key: c.fingerprint, source_id: s.id, source_incarnation: s.incarnation, run_id: text(k0, 'runId'),
          principal_kind: principalKind, principal_id: principalId, has_sync_options: hasKey(k0, 'syncOptions') as boolean,
          pending_request_id: pendingRequestId, pending_state: pending?.state ?? null,
          principal_live: await snap.principalLive(principalKind, principalId), superseded,
          checkpoint_moved: await snap.checkpointMoved(s, k0, c.fingerprint, CHECKPOINT_MOVED_MESSAGE) as boolean,
          slug_mode_refused: await snap.slugModeRefused(s, k0, c.fingerprint) as boolean, updated_at: updatedAt,
        } });
      } else {
        const r = await snap.request(s.id, pendingRequestId);
        retiredCursors.push({ us: c.updated_at_us, row: {
          cursor_key: c.fingerprint, source_id: s.id, source_incarnation: incarnation, run_id: text(k0, 'runId'),
          principal_kind: principalKind, principal_id: principalId, pending_request_id: pendingRequestId,
          pending_state: r?.state ?? null, updated_at: updatedAt,
        } });
      }
    }

    const failures: ManagedSyncFailureRow[] = [];
    const retiredFailures: ManagedSyncFailureRow[] = [];
    for (const f of failureRows) {
      const k0 = first(f.completed_keys);
      const s = byId.get(text(k0, 'source_id') ?? '');
      const incarnation = text(k0, 'source_incarnation');
      if (!s || incarnation === null) continue;
      const row = { cursor_key: f.fingerprint, source_id: s.id, run_id: text(k0, 'run_id'), request_id: text(k0, 'request_id'), updated_at: f.updated_at };
      if (s.incarnation === incarnation) {
        if (!syncKeys.has(f.fingerprint) && !passKeys.has(f.fingerprint)) failures.push({ ...row, source_incarnation: s.incarnation });
      } else if (!openSyncKeys.has(f.fingerprint)) {
        retiredFailures.push({ ...row, source_incarnation: incarnation });
      }
    }
    const byKey = (a: ManagedSyncFailureRow, b: ManagedSyncFailureRow) => byteCmp(a.source_id, b.source_id) || byteCmp(a.cursor_key, b.cursor_key);

    const passes: ManagedSyncPassRow[] = [];
    for (const p of passRows) {
      const s = sources.find(x => p.fingerprint === `${x.id}:${x.incarnation}`);
      if (!s) continue;
      const k0 = first(p.completed_keys);
      const stamp = await snap.passStamp(s, k0);
      if (!(await snap.passSlugModeRefused(s, k0, stamp?.request_id ?? null))) continue;
      passes.push({
        cursor_key: p.fingerprint, source_id: s.id, source_incarnation: s.incarnation, run_id: text(k0, 'telemetry', 'pass_id') as string,
        request_id: stamp!.request_id, state: stamp!.state, updated_at: p.updated_at,
      });
    }

    return {
      cursors: bySourceTimeKey(cursors), failures: failures.sort(byKey),
      passes: passes.sort((a, b) => byteCmp(a.source_id, b.source_id)),
      retiredCursors: bySourceTimeKey(retiredCursors), retiredFailures: retiredFailures.sort(byKey),
    };
  };

/** The ids of the archived sources. */
export const listArchivedSourceIds: StoreMember<[], string[]> = async (brain) =>
  (await new Snapshot(brain, 'listArchivedSourceIds').allSources()).filter(s => s.archived).map(s => s.id);

/** Which of `keys` have a durable `managed-sync-failure` row. */
export const listManagedSyncFailureKeys: StoreMember<[keys: readonly string[]], string[]> = async (brain, keys) => {
  const snap = new Snapshot(brain, 'listManagedSyncFailureKeys');
  const out: string[] = [];
  for (const key of new Set(keys)) if (await snap.checkpoint('managed-sync-failure', key)) out.push(key);
  return out;
};

/** The store's writes are durable when they return and take no lock that can wait, so there is nothing to set. */
export const applyManagedSyncRetireLimits: StoreMember<[], void> = async () => {};

/** Removes the pass row's `slug_mode` obligation while the refusal still holds and no pass holds the drain lease. */
export const retireManagedSyncPassSlugMode: StoreMember<[target: ManagedSyncRetireTarget, lockId: string], boolean> =
  async (brain, target, lockId) => {
    const member = 'retireManagedSyncPassSlugMode';
    const locks: Array<{ ttl_expires_at: string }> =
      await storeCall({ member }, () => brain.readCycleLocks({ by: 'id', lockId }));
    if (locks[0] && new Date(locks[0].ttl_expires_at).getTime() > Date.now()) return false;
    const snap = new Snapshot(brain, member);
    const p = await snap.checkpoint('managed-sync-pass', target.cursorKey);
    const s = await snap.active(target.sourceId);
    if (!p || !s || s.incarnation !== target.incarnation || badUuid(target.requestId)) return false;
    const k0 = first(p.completed_keys);
    if (text(k0, 'telemetry', 'pass_id') !== target.runId) return false;
    if (!(await snap.passSlugModeRefused(s, k0, target.requestId))) return false;
    const stamp = await snap.passStamp(s, k0);
    if (!stamp || uuid(stamp.request_id) !== uuid(target.requestId)) return false;
    const { slug_mode: _dropped, ...obligations } = get(k0, 'obligations') as Record<string, unknown>;
    const keys = [...(p.completed_keys as unknown[])];
    keys[0] = { ...(k0 as Record<string, unknown>), obligations };
    await storeCall({ member }, () => brain.writeOpCheckpointRecord('managed-sync-pass', target.cursorKey, keys));
    return true;
  };

/** Deletes the unfinished cursor when its pending request is not live and `mode`'s re-check holds; its pending intent. */
export const retireManagedSyncCursor: StoreMember<[target: ManagedSyncRetireTarget, mode: ManagedSyncRetireMode], { intent: unknown } | null> =
  async (brain, target, mode) => {
    const member = 'retireManagedSyncCursor';
    const snap = new Snapshot(brain, member);
    const c = await snap.checkpoint('managed-sync', target.cursorKey);
    if (!c) return null;
    const k0 = first(c.completed_keys);
    const pendingRequestId = text(k0, 'pending', 'requestId');
    if (!notDone(k0) || text(k0, 'sourceId') !== target.sourceId || target.incarnation === null
      || text(k0, 'incarnation') !== target.incarnation || badUuid(pendingRequestId)) return null;
    const pending = await snap.request(target.sourceId, pendingRequestId);
    if (pending && !TERMINAL_STATES.includes(pending.state)) return null;
    const sameRun = text(k0, 'runId') === target.runId && pendingRequestId === target.requestId;
    let holds = false;
    if (mode === 'retired') {
      const s = await snap.active(target.sourceId);
      holds = s !== undefined && s.incarnation !== target.incarnation;
    } else if (mode === 'adoption') {
      holds = !(await snap.requestsOf(target.sourceId)).some(r => text(r.intent, 'cursorKey') === target.cursorKey && isOpen(r));
    } else if (mode === 'checkpoint_moved' || mode === 'slug_mode_refused') {
      const s = await snap.active(target.sourceId);
      if (sameRun && s && s.incarnation === target.incarnation) {
        holds = (mode === 'checkpoint_moved'
          ? await snap.checkpointMoved(s, k0, target.cursorKey, CHECKPOINT_MOVED_MESSAGE)
          : await snap.slugModeRefused(s, k0, target.cursorKey)) === true;
      }
    } else if (mode === 'orphan') {
      const live = hasKey(k0, 'syncOptions') === true && await snap.principalLive(
        text(k0, 'authority', 'writer', 'principal', 'kind'), text(k0, 'authority', 'writer', 'principal', 'id'));
      holds = !live;
    }
    if (!holds) return null;
    await storeCall({ member }, () => brain.deleteOpCheckpoint('managed-sync', target.cursorKey));
    const intent = get(k0, 'pending', 'intent');
    return { intent: intent ?? null };
  };

/** Deletes the `managed-sync-failure` row under `key` while no `managed-sync` cursor shares the key. */
export const deleteManagedSyncFailureRow: StoreMember<[key: string, retired: boolean], boolean> = async (brain, key, retired) => {
  const member = 'deleteManagedSyncFailureRow';
  const snap = new Snapshot(brain, member);
  const f = await snap.checkpoint('managed-sync-failure', key);
  if (!f) return false;
  const c = await snap.checkpoint('managed-sync', key);
  if (c && (!retired || notDone(first(c.completed_keys)))) return false;
  if (retired) {
    const k0 = first(f.completed_keys);
    const s = await snap.active(text(k0, 'source_id'));
    const incarnation = text(k0, 'source_incarnation');
    if (!s || incarnation === null || s.incarnation === incarnation) return false;
  }
  await storeCall({ member }, () => brain.deleteOpCheckpoint('managed-sync-failure', key));
  return true;
};

/** The source's `managed-sync-failure` rows (any incarnation) by byte key, each with whether an unfinished cursor shares its key. */
export const listSourceManagedSyncFailures: StoreMember<[sourceId: string], Array<SourceManagedSyncFailure<never>>> = async (brain, sourceId) => {
  const snap = new Snapshot(brain, 'listSourceManagedSyncFailures');
  const cursors = new Map((await snap.checkpoints('managed-sync')).map(row => [row.fingerprint, row]));
  return (await snap.checkpoints('managed-sync-failure'))
    .filter(row => text(first(row.completed_keys), 'source_id') === sourceId)
    .sort((a, b) => byteCmp(a.fingerprint, b.fingerprint))
    .map(row => {
      const cursor = cursors.get(row.fingerprint);
      return { key: row.fingerprint, failure: (first(row.completed_keys) ?? null) as never, unfinished: cursor !== undefined && notDone(first(cursor.completed_keys)) };
    });
};

/** Deletes the `managed-sync-failure` row under `key` while it still records `observationId`. */
export const deleteManagedSyncFailureObservation: StoreMember<[key: string, observationId: string], boolean> = async (brain, key, observationId) => {
  const member = 'deleteManagedSyncFailureObservation';
  const f = await new Snapshot(brain, member).checkpoint('managed-sync-failure', key);
  if (!f || text(first(f.completed_keys), 'observation_id') !== observationId) return false;
  await storeCall({ member }, () => brain.deleteOpCheckpoint('managed-sync-failure', key));
  return true;
};

/** Deletes the run's `managed-sync-manifest` row while no `managed-sync` cursor names the run. */
export const deleteManagedSyncManifest: StoreMember<[runId: string], boolean> = async (brain, runId) => {
  const member = 'deleteManagedSyncManifest';
  const snap = new Snapshot(brain, member);
  if (!(await snap.checkpoint('managed-sync-manifest', runId))) return false;
  if ((await snap.checkpoints('managed-sync')).some(c => text(first(c.completed_keys), 'runId') === runId)) return false;
  await storeCall({ member }, () => brain.deleteOpCheckpoint('managed-sync-manifest', runId));
  return true;
};

/** The store keeps no writer bindings (a Rust brain is never managed), so it owns no content. */
export const listOwnedContentRows: StoreMember<[sourceIds: readonly string[] | null, inheritsPersistence: boolean], OwnedContentRow[]> =
  async () => [];

/** No writer binding exists, so no content receipt is bound. */
export const readContentReceiptBinding: StoreMember<[sourceId: string], ContentReceiptBinding | null> = async () => null;

/** The config value; the store serializes its writes, so there is no row lock to take. */
export const readConfigForUpdate: StoreMember<[key: string], string | null> = (brain, key) =>
  storeCall({ member: 'readConfigForUpdate' }, () => brain.getConfig(key));
