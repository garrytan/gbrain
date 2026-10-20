/**
 * An in-memory NotifierStore (src/core/commit-notifier.ts) for driving the notifier through its seams with a fake clock.
 * `leases` is shared between stores to model several residents on one host (Postgres); omit it for the PGLite shape
 * (no lease: the process holding the database owns). Markers keep the SQL store's generation rules.
 */
import type { NotifierStore } from '../../src/core/commit-notifier.ts';
import type { MarkerIntent, NotifierSourceRow, StatePatch, WantedMarker } from '../../src/core/notifier/store.ts';

export interface MemoryLeases { rows: Map<string, { ownerId: string; fence: number; kind: string; expiresAt: number }>; now: () => number }

export interface MemoryNotifierStore extends NotifierStore {
  markers: Map<string, WantedMarker>;
  states: Map<string, NotifierSourceRow>;
  writes: Array<{ kind: 'state' | 'coverage' | 'marker'; sourceId: string; detail: string }>;
  lastCommit: (sourceId: string) => string | null;
  upsert(sourceId: string, intent: MarkerIntent, wantedHead: string | null, jobId?: number | null): WantedMarker;
}

const empty = (sourceId: string): NotifierSourceRow => ({ source_id: sourceId, syncer_host_id: null, state: 'idle', reason: null, first_due_at: null, attempts: 0,
  next_retry_at: null, last_progress_at: null, last_error_code: null, last_error: null, last_error_at: null, trace_path: null, observed_head: null,
  observed_at: null, detection_mode: null, owner_host_id: null, owner_kind: null, owner_pid: null, owner_seen_at: null });

export function memoryNotifierStore(opts: { leases?: MemoryLeases; lastCommit?: (sourceId: string) => string | null; liveJobs?: Set<number> } = {}): MemoryNotifierStore {
  const markers = new Map<string, WantedMarker>();
  const states = new Map<string, NotifierSourceRow>();
  const writes: MemoryNotifierStore['writes'] = [];
  const lastCommit = opts.lastCommit ?? (() => null);
  const key = (s: string, i: string) => `${s}\u0000${i}`;
  const at = () => new Date(opts.leases?.now() ?? Date.now()).toISOString();
  const upsert = (sourceId: string, intent: MarkerIntent, wantedHead: string | null, jobId: number | null = null): WantedMarker => {
    const prior = markers.get(key(sourceId, intent));
    const m: WantedMarker = { source_id: sourceId, intent, wanted_head: wantedHead, generation: (prior?.generation ?? 0) + 1,
      first_due_at: prior?.first_due_at ?? at(), updated_at: at(), requested_by: 'test', job_id: jobId ?? prior?.job_id ?? null };
    markers.set(key(sourceId, intent), m);
    writes.push({ kind: 'marker', sourceId, detail: `${intent}:${m.generation}` });
    return m;
  };
  const due = (ids: string[]) => [...markers.values()].filter(m => ids.includes(m.source_id)
    && (m.intent !== 'freshness' || m.wanted_head === null || m.wanted_head !== lastCommit(m.source_id)));
  return {
    markers, states, writes, lastCommit, upsert,
    claimLease: async (l) => {
      if (!opts.leases) return null;
      const t = opts.leases.now();
      const row = opts.leases.rows.get(l.hostId);
      if (!row || row.ownerId === l.ownerId || row.expiresAt <= t) {
        const fence = !row ? 1 : row.ownerId === l.ownerId ? row.fence : row.fence + 1;
        opts.leases.rows.set(l.hostId, { ownerId: l.ownerId, fence, kind: l.kind, expiresAt: t + l.leaseMs });
        return { owner: true, fence };
      }
      return { owner: false, holderKind: row.kind };
    },
    holdsLease: async (hostId, ownerId, fence) => {
      const row = opts.leases?.rows.get(hostId);
      return !!row && row.ownerId === ownerId && row.fence === fence && row.expiresAt > opts.leases!.now();
    },
    releaseLease: async (hostId, ownerId) => {
      const row = opts.leases?.rows.get(hostId);
      if (row && row.ownerId === ownerId) row.expiresAt = opts.leases!.now();
    },
    dueMarkers: async (ids) => due(ids),
    liveJobs: async (ids) => new Set(ids.filter(id => opts.liveJobs?.has(id))),
    forward: async (sourceId, head) => { upsert(sourceId, 'freshness', head); },
    settleMarkers: async (sourceId, read, run) => {
      for (const m of read) {
        const cur = markers.get(key(sourceId, m.intent));
        if (!cur || cur.generation !== m.generation) continue;
        if (m.intent === 'pull' && !run.pulled) continue;
        if (m.intent === 'full' && !run.full) continue;
        if (m.intent === 'freshness' && m.wanted_head !== null && m.wanted_head !== lastCommit(sourceId)) continue;
        markers.delete(key(sourceId, m.intent));
      }
      return due([sourceId]);
    },
    readStates: async (ids) => ids.flatMap(id => states.has(id) ? [states.get(id)!] : []),
    writeState: async (sourceId, p: StatePatch) => {
      const row = states.get(sourceId) ?? empty(sourceId);
      row.state = p.state;
      row.reason = p.reason ?? null;
      row.first_due_at = p.firstDue === 'clear' ? null : row.first_due_at ?? at();
      if (p.attempts !== undefined) row.attempts = p.attempts;
      row.next_retry_at = p.nextRetryInMs ? new Date((opts.leases?.now() ?? Date.now()) + p.nextRetryInMs).toISOString() : null;
      if (p.error !== undefined) { row.last_error_code = p.error?.code ?? null; row.last_error = p.error?.message ?? null; row.trace_path = p.error?.tracePath ?? null; }
      states.set(sourceId, row);
      writes.push({ kind: 'state', sourceId, detail: `${p.state}${p.reason ? `:${p.reason}` : ''}` });
    },
    writeCoverage: async (sourceId, c) => {
      const row = states.get(sourceId) ?? empty(sourceId);
      row.observed_head = c.head; row.detection_mode = c.mode; row.owner_host_id = c.ownerHostId; row.owner_kind = c.ownerKind; row.owner_pid = c.ownerPid;
      states.set(sourceId, row);
      writes.push({ kind: 'coverage', sourceId, detail: `${c.head}|${c.mode}|${c.ownerKind}` });
    },
  };
}
