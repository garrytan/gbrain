/**
 * Typed `sources` members for hermetic stub engines. Production code reads `sources` through these BrainEngine members
 * (listAllSources, getSource, listLocalPathSources, listSourceRoutingRows, listSourceRecords, countDefaultSourceSplit,
 * listStaleSyncSourceIds, readSourceIncarnation, listOnboardingSources, readSourceState, and the guest and company-brain lookups) instead of `executeRaw`, so a stub engine that used to answer SQL text spreads these instead.
 * Each member answers as the engine-sql statement does: the same filters, the same order, the same row shape.
 */
import type { GuestSourceLookupRow, SourceDetailRow, SourceIncarnationRow, SourceRecordRow, SourceRow } from '../../src/core/engine.ts';
import type { DefaultSourceSplit, LocalPathSourceRow, SourceRoutingRow } from '../../src/core/engine-sql/sources.ts';
import type { OnboardingSourceRow } from '../../src/core/engine-sql/writer-status.ts';
import type { SourceStateRow } from '../../src/core/engine-sql/write-misc.ts';

export interface StubSourceRow {
  id: string;
  name?: string | null;
  local_path?: string | null;
  archived?: boolean;
  config?: Record<string, unknown>;
  last_commit?: string | null;
  last_sync_at?: Date | null;
  created_at?: Date;
  incarnation?: string;
}

export interface StubSourceMemberOptions {
  /** Whether `default` holds a live page (listSourceRoutingRows' `default_has_pages`, countDefaultSourceSplit). */
  defaultHasPages?: boolean | (() => boolean);
  /** Throw this from a member (by name) to simulate a failed read; return undefined to answer normally. */
  fail?: (member: string) => Error | undefined;
  /** Called with the member name on every call (for assertions on which reads ran). */
  onCall?: (member: string) => void;
}

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const defaultFirst = <T extends { id: string }>(rows: T[]) => {
  const sorted = byId(rows);
  return [...sorted.filter(r => r.id === 'default'), ...sorted.filter(r => r.id !== 'default')];
};

/** The typed source members over `sources` (an array, or a function read on every call so a test can change it). */
export function stubSourceMembers(sources: readonly StubSourceRow[] | (() => readonly StubSourceRow[]), opts: StubSourceMemberOptions = {}) {
  const rows = () => (typeof sources === 'function' ? sources() : sources).map(s => ({
    id: s.id,
    name: s.name === undefined ? s.id : s.name,
    local_path: s.local_path ?? null,
    archived: s.archived === true,
    config: s.config ?? {},
    last_commit: s.last_commit ?? null,
    last_sync_at: s.last_sync_at ?? null,
    created_at: s.created_at ?? new Date('2026-01-01T00:00:00.000Z'),
    incarnation: s.incarnation ?? `00000000-0000-4000-8000-${s.id.padStart(12, '0').slice(-12)}`,
  }));
  const hasPages = () => (typeof opts.defaultHasPages === 'function' ? opts.defaultHasPages() : opts.defaultHasPages === true);
  const enter = (member: string) => {
    opts.onCall?.(member);
    const error = opts.fail?.(member);
    if (error) throw error;
  };
  return {
    async listAllSources(o?: { includeArchived?: boolean; localPathOnly?: boolean }): Promise<SourceRow[]> {
      enter('listAllSources');
      return defaultFirst(rows())
        .filter(r => o?.includeArchived === true || !r.archived)
        .filter(r => o?.localPathOnly !== true || (r.local_path !== null && r.config.role !== 'storage_manifest'))
        .map(({ id, name, local_path, last_sync_at, config }) => ({ id, name, local_path, last_sync_at, config }));
    },
    async getSource(id: string): Promise<SourceDetailRow | null> {
      enter('getSource');
      const r = rows().find(row => row.id === id);
      if (!r) return null;
      return { id: r.id, name: r.name ?? r.id, local_path: r.local_path, last_commit: r.last_commit, last_sync_at: r.last_sync_at, config: r.config, created_at: r.created_at };
    },
    async listLocalPathSources(): Promise<LocalPathSourceRow[]> {
      enter('listLocalPathSources');
      return rows().filter(r => r.local_path !== null).map(({ id, local_path, archived }) => ({ id, local_path: local_path!, archived }));
    },
    async listSourceRoutingRows(): Promise<SourceRoutingRow[]> {
      enter('listSourceRoutingRows');
      const flag = hasPages();
      return byId(rows()).map(({ id, local_path, archived, config }) => ({ id, local_path, archived, config, default_has_pages: flag }));
    },
    async listSourceRecords(): Promise<SourceRecordRow[]> {
      enter('listSourceRecords');
      return defaultFirst(rows()).map(({ id, name, local_path, last_commit, last_sync_at, config, created_at, archived }) =>
        ({ id, name: name ?? id, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at: null }));
    },
    async countDefaultSourceSplit(): Promise<DefaultSourceSplit> {
      enter('countDefaultSourceSplit');
      return { defaultPages: hasPages() ? 1 : 0, nonDefaultPages: 0, nonDefaultSources: 0 };
    },
    async listStaleSyncSourceIds(): Promise<string[]> {
      enter('listStaleSyncSourceIds');
      const staleBefore = Date.now() - 7 * 86_400_000;
      return byId(rows()).filter(r => !r.archived && r.last_sync_at !== null && r.last_sync_at.getTime() < staleBefore).map(r => r.id);
    },
    async readSourceIncarnation(id: string): Promise<SourceIncarnationRow | null> {
      enter('readSourceIncarnation');
      const r = rows().find(row => row.id === id);
      return r ? { config: r.config, incarnation: r.incarnation } : null;
    },
    /** The live sources' id, root, incarnation and kind, in byte order of id (listOnboardingSources). */
    async listOnboardingSources(sourceId: string | null): Promise<OnboardingSourceRow[]> {
      enter('listOnboardingSources');
      return byId(rows()).filter(r => !r.archived && (sourceId === null || r.id === sourceId))
        .map(({ id, local_path, incarnation, config }) => ({ id, local_path, incarnation, kind: typeof config.kind === 'string' ? config.kind : null }));
    },
    /** The source row's incarnation, archived flag, local path and config (readSourceState), or null for an unknown id. */
    async readSourceState(id: string): Promise<SourceStateRow | null> {
      enter('readSourceState');
      const r = rows().find(row => row.id === id);
      return r ? { incarnation: r.incarnation, archived: r.archived, local_path: r.local_path, config: r.config } : null;
    },
    /** The guest_sources lookup (readGuestSourceRow) for a brain with no guest sources: every source answers "not a guest". */
    async readGuestSourceRow(_id: string): Promise<GuestSourceLookupRow> {
      enter('readGuestSourceRow');
      return { hidden: false, source_id: null, writers: null, trust_ceiling: null };
    },
    async listGuestSourceIds(_ids: readonly string[]): Promise<string[]> {
      enter('listGuestSourceIds');
      return [];
    },
    async hasGuestSource(): Promise<boolean> {
      enter('hasGuestSource');
      return false;
    },
    /** No source holds a company-brain ingestion receipt. */
    async hasCompanyBrainReceipt(_id: string): Promise<boolean> {
      enter('hasCompanyBrainReceipt');
      return false;
    },
  };
}
