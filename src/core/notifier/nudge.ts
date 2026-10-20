/**
 * GBRA-133 PR 2a: the serve side of `sync_nudge` and the marker a trigger records. One rule for every submitter:
 * a managed source asks for freshness (its checkout's HEAD; it never pulls), a classic source asks for a pull unless
 * the caller named an intent, and a freshness marker with no head takes the checkout's HEAD now.
 */
import type { BrainEngine } from '../engine.ts';
import { SYNC_NUDGE_VERSION, type SyncNudgeRequest, type SyncNudgeResponse } from '../context/sync-ipc.ts';
import { MARKER_INTENTS, upsertMarker, type MarkerIntent, type MarkerRequester, type WantedMarker } from './store.ts';
import { revParseHead } from './detect.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { nudgeResidentNotifier, residentNotifier } from './resident.ts';

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whether the source is a managed one (bound to a worktree on an activated brain), and its checkout root. */
export async function sourceSyncShape(engine: BrainEngine, sourceId: string): Promise<{ exists: boolean; managed: boolean; root: string | null }> {
  const [row] = await engine.executeRaw<{ local_path: string | null; root: string | null; bound: unknown }>(
    `SELECT s.local_path, h.local_path AS root, (b.source_id IS NOT NULL) AS bound
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
      WHERE s.id = $1 AND NOT s.archived LIMIT 1`, [sourceId]);
  if (!row) return { exists: false, managed: false, root: null };
  const managed = (row.bound === true || row.bound === 't')
    && await readManagedMode(engine, { refusal: { subject: 'Recording a sync request', consequence: 'it refuses rather than guess whether the source pulls' } });
  return { exists: true, managed, root: (managed ? row.root : null) ?? row.local_path };
}

/** Records the marker a trigger asks for; resolves the intent and, for freshness, the checkout's HEAD. */
export async function recordTriggerMarker(engine: BrainEngine, req: { sourceId: string; intent?: MarkerIntent; wantedHead?: string | null; requestedBy: MarkerRequester; jobId?: number | null }):
    Promise<{ marker: WantedMarker; managed: boolean } | null> {
  const shape = await sourceSyncShape(engine, req.sourceId);
  if (!shape.exists) return null;
  const intent: MarkerIntent = req.intent ?? (shape.managed ? 'freshness' : 'pull');
  let wantedHead = req.wantedHead ?? null;
  if (intent === 'freshness' && !wantedHead && shape.root) wantedHead = await revParseHead(shape.root).catch(() => null);
  return { marker: await upsertMarker(engine, { sourceId: req.sourceId, intent, wantedHead, requestedBy: req.requestedBy, jobId: req.jobId ?? null }), managed: shape.managed };
}

export async function recordSyncNudge(engine: BrainEngine, req: SyncNudgeRequest): Promise<SyncNudgeResponse> {
  if (typeof req.version !== 'number' || req.version < 1) return { ok: false, protocol: 2, version: SYNC_NUDGE_VERSION, error: 'unsupported_version' };
  if (typeof req.sourceId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(req.sourceId)) return { ok: false, protocol: 2, version: SYNC_NUDGE_VERSION, error: 'invalid_options:sourceId' };
  if (req.intent !== undefined && !(MARKER_INTENTS as readonly string[]).includes(req.intent)) return { ok: false, protocol: 2, version: SYNC_NUDGE_VERSION, error: 'invalid_options:intent' };
  if (req.wantedHead !== undefined && req.wantedHead !== null && !(typeof req.wantedHead === 'string' && SHA.test(req.wantedHead))) {
    return { ok: false, protocol: 2, version: SYNC_NUDGE_VERSION, error: 'invalid_options:wantedHead' };
  }
  const requestedBy: MarkerRequester = req.requestedBy === 'delegated_sync' ? 'delegated_sync' : 'sync_nudge';
  const recorded = await recordTriggerMarker(engine, { sourceId: req.sourceId, intent: req.intent, wantedHead: req.wantedHead ?? null, requestedBy });
  if (!recorded) return { ok: false, protocol: 2, version: SYNC_NUDGE_VERSION, error: 'unknown_source' };
  const resident = residentNotifier();
  nudgeResidentNotifier();
  const m = recorded.marker;
  return { ok: true, protocol: 2, version: SYNC_NUDGE_VERSION, acked: true, notifier: resident !== null, resident: resident?.resident ?? null,
    marker: { source_id: m.source_id, intent: m.intent, generation: m.generation, wanted_head: m.wanted_head, first_due_at: m.first_due_at } };
}
