/**
 * The git sync hold store and the managed sync pass row reads, answered from the store's op checkpoint rows
 * (rust/docs/store/persistence.md, "Checkpoint rows").
 * The rows are the ones PGLite keeps in `op_checkpoints`: a hold row (`GIT_HOLD_OP`, `<source>:<incarnation>:<path>`)
 * holds `[record]`, a summary row (`GIT_HOLD_SUMMARY_OP`, `<source>:<incarnation>`) holds `[{ source_id, incarnation,
 * count, stale, ... }]`, a pass row (`MANAGED_SYNC_PASS_OP`, `<source>:<incarnation>`) holds `[value]`.
 *
 * Each store call is one store write transaction and the store runs one at a time, so a read followed by a write here
 * sees no other write between them: the summary row lock PGLite and Postgres take is implied. The SQL these members
 * stand for (the hold listing, per-code and image counts and the conversion log among them) is engine-sql/sync-hold-store.ts, engine-sql/sync-hold-reads.ts and engine-sql/persistence-journal.ts.
 * Fingerprints list in byte order, where the SQL orders by the database collation; the two agree on the ASCII paths
 * the parity tests hold.
 */
import { GIT_HOLD_OP } from '../../engine-sql/persistence-journal.ts';
import type { SourceStateRow } from '../../engine-sql/write-misc.ts';
import type { SourceRow } from '../../engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

/** One op checkpoint row as the store returns it. */
interface CheckpointRow { fingerprint: string; completed_keys: unknown; updated_at: string }
type JsonObject = Record<string, unknown>;

/** A live source: its id, current incarnation (as text), archived flag and config. */
interface LiveSource { id: string; incarnation: string; archived: boolean; config: JsonObject }

const first = (row: CheckpointRow | null): JsonObject | null => {
  const keys = row?.completed_keys;
  return Array.isArray(keys) && keys[0] !== undefined && keys[0] !== null ? keys[0] as JsonObject : null;
};


/** `x->>'name'`: the text of a JSON value, or null. */
const text = (value: unknown): string | null =>
  value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value);

function readRow(brain: StoreBrain, member: string, op: string, fingerprint: string): Promise<CheckpointRow | null> {
  return storeCall({ member }, () => brain.readOpCheckpointRow(op, fingerprint));
}

function listRows(brain: StoreBrain, member: string, op: string, prefix = ''): Promise<CheckpointRow[]> {
  return storeCall({ member }, () => brain.listOpCheckpointRows(op, prefix));
}

/** Every source, archived ones too, with its current incarnation and config. */
async function liveSources(brain: StoreBrain, member: string): Promise<Map<string, LiveSource>> {
  const rows: SourceRow[] = await storeCall({ member }, () => brain.listAllSources({ includeArchived: true }));
  const out = new Map<string, LiveSource>();
  for (const row of rows) {
    const state: SourceStateRow | null = await storeCall({ member, sourceId: row.id }, () => brain.readSourceState(row.id));
    if (state) out.set(row.id, { id: row.id, incarnation: String(state.incarnation), archived: state.archived === true, config: state.config ?? {} });
  }
  return out;
}

/** The source a hold record names (`source_id`, `incarnation`) when that incarnation is the source's current one. */
const holdSource = (sources: Map<string, LiveSource>, record: JsonObject): LiveSource | undefined => {
  const source = sources.get(String(record.source_id));
  return source && source.incarnation === text(record.incarnation) ? source : undefined;
};

/** The current-incarnation hold rows naming these page ids, each with its page's revision (any source, deleted too). */
export const readHeldPageRows: StoreMember<[pageIds: string[]], Array<{ record: never; revision: string | null }>> = async (brain, pageIds) => {
  const member = 'readHeldPageRows';
  const ids = new Set(pageIds.map(String));
  if (ids.size === 0) return [];
  const sources = await liveSources(brain, member);
  const held = (await listRows(brain, member, GIT_HOLD_OP)).flatMap(row => {
    const record = first(row);
    const pageId = record ? text(record.page_id) : null;
    return record && pageId !== null && ids.has(pageId) && holdSource(sources, record) ? [{ record, pageId }] : [];
  });
  const numeric = [...new Set(held.map(h => Number(h.pageId)).filter(Number.isSafeInteger))];
  const revisions = numeric.length
    ? await storeCall({ member }, () => brain.readPageRevisions(numeric)) as Array<{ id: number; knowledge_revision: string | number | null }>
    : [];
  const revisionOf = new Map(revisions.map(row => [String(row.id), row.knowledge_revision === null ? null : String(row.knowledge_revision)]));
  return held.map(h => ({ record: h.record as never, revision: revisionOf.get(String(Number(h.pageId))) ?? null }));
};
