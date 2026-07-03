import {
  CONNECTOR_DEFINITIONS,
  getConnectorDefinition,
} from '../core/connectors/connector-registry.ts';
import {
  loadLocalFileConnectorItems,
  resolveLocalFileConnectorTarget,
  type LocalFileConnectorId,
  type LocalFileConnectorLoad,
  type LocalFileConnectorTarget,
} from '../core/connectors/local-file-connectors.ts';
import {
  loadMeetingTranscriptFilesystemItems,
  resolveMeetingTranscriptFilesystemTarget,
  type MeetingTranscriptFilesystemLoad,
  type MeetingTranscriptFilesystemTarget,
} from '../core/connectors/meeting-transcripts-filesystem.ts';
import { loadConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import { operationsByName, type OperationContext } from '../core/operations.ts';

const MEETING_TRANSCRIPTS_CONNECTOR_ID = 'meeting_transcripts';
const LOCAL_FILE_CONNECTOR_IDS = new Set<string>([
  MEETING_TRANSCRIPTS_CONNECTOR_ID,
  'chat_exports',
  'browser_bookmarks',
]);
let lastConnectorSyncTimestampMs = 0;

export async function runConnectors(
  engineOrArgs: BrainEngine | string[],
  maybeArgs?: string[],
): Promise<void> {
  const engine = Array.isArray(engineOrArgs) ? null : engineOrArgs;
  const args = Array.isArray(engineOrArgs) ? engineOrArgs : maybeArgs ?? [];
  const command = args[0] ?? 'list';
  if (command === '--help' || command === '-h' || command === 'help') {
    printConnectorsHelp();
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify({
      connectors: CONNECTOR_DEFINITIONS.map((connector) => ({
        id: connector.id,
        class: connector.class,
        source_kind: connector.source_kind,
        display_name: connector.display_name,
        default_scopes: connector.default_scopes,
      })),
    }, null, 2));
    return;
  }

  if (command === 'show') {
    const connectorId = args[1];
    if (!connectorId) {
      throw new Error('Usage: mbrain connectors show <connector-id>');
    }
    console.log(JSON.stringify(getConnectorDefinition(connectorId), null, 2));
    return;
  }

  if (command === 'sync') {
    if (!engine) {
      throw new Error('mbrain connectors sync requires a configured brain engine');
    }
    const result = await syncLocalConnector(engine, args.slice(1));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown connectors command: ${command}`);
}

function printConnectorsHelp(): void {
  console.log(`mbrain connectors -- inspect personal data connector definitions

USAGE
  mbrain connectors list
  mbrain connectors show <connector-id>
  mbrain connectors sync meeting_transcripts --path <file-or-directory> [--dry-run]
  mbrain connectors sync chat_exports --path <file-or-directory> [--dry-run]
  mbrain connectors sync browser_bookmarks --path <file-or-directory> [--dry-run]
`);
}

interface LocalConnectorSyncResult {
  connector_id: 'meeting_transcripts' | LocalFileConnectorId;
  source_id: string | null;
  dry_run: boolean;
  source_scope: MeetingTranscriptFilesystemLoad['source_scope'] | LocalFileConnectorLoad['source_scope'];
  path_display: string;
  planned: number;
  persisted: number;
  skipped_unchanged: number;
  deleted_archived: number;
  skipped_files: MeetingTranscriptFilesystemLoad['skipped_files'] | LocalFileConnectorLoad['skipped_files'];
}

type LoadedLocalConnector = MeetingTranscriptFilesystemLoad | LocalFileConnectorLoad;
type LocalConnectorTarget = MeetingTranscriptFilesystemTarget | LocalFileConnectorTarget;

type QueryableEngine = BrainEngine & {
  database?: {
    query<T = Record<string, unknown>>(sql: string): {
      all(...params: unknown[]): T[];
    };
  };
  db?: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  sql?: { unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> };
};

async function syncLocalConnector(
  engine: BrainEngine,
  args: string[],
): Promise<LocalConnectorSyncResult> {
  const connectorId = args[0];
  if (!connectorId) {
    throw new Error('Usage: mbrain connectors sync <connector-id> --path <file-or-directory>');
  }
  getConnectorDefinition(connectorId);
  if (!LOCAL_FILE_CONNECTOR_IDS.has(connectorId)) {
    throw new Error('connectors sync only supports meeting_transcripts, chat_exports, and browser_bookmarks');
  }

  const path = readFlag(args, '--path');
  if (!path) {
    throw new Error(`Usage: mbrain connectors sync ${connectorId} --path <file-or-directory>`);
  }
  const dryRun = hasFlag(args, '--dry-run');
  const syncStartedAt = nextConnectorSyncTimestamp();
  const target = resolveConnectorTarget(connectorId, path);
  const blockingSource = await findBlockingConnectorSource(engine, connectorId, target.source_locator);
  if (blockingSource) {
    throw new Error(connectorSourceBlockReason(blockingSource.source) ?? 'source policy prevents connector sync');
  }
  const existing = await findExactConnectorSource(engine, connectorId, target.source_locator);
  let sourceId: string | null = existing?.source.id ?? null;

  let loaded: LoadedLocalConnector;
  try {
    loaded = loadConnectorItems(connectorId, path);
  } catch (error) {
    if (!dryRun && sourceId) {
      await recordConnectorFailure(engine, sourceId, connectorId, error);
    }
    throw error;
  }

  let persisted = 0;
  let skippedUnchanged = 0;
  let deletedArchived = 0;

  if (!dryRun && !sourceId) {
    const registered = await operationsByName.register_connector_source.handler(ctx(engine), {
      connector_id: connectorId,
      display_name: loaded.display_name,
      account_locator: loaded.account_locator,
      consent_state: 'granted',
      credential_ref_id: null,
      metadata_json: {
        source_scope: loaded.source_scope,
        path_display: loaded.path_display,
      },
      now: syncStartedAt,
    }) as any;
    sourceId = registered.source.id;
  }

  if (dryRun && sourceId) {
    deletedArchived = await archiveMissingConnectorItems(engine, sourceId, connectorId, loaded, true, syncStartedAt);
  }

  if (!dryRun && sourceId) {
    try {
      for (const item of loaded.items) {
        const ingested = await operationsByName.ingest_connector_item.handler(ctx(engine), {
          source_id: sourceId,
          connector_id: connectorId,
          external_id: item.external_id,
          locator: item.locator ?? null,
          title: item.title,
          body: item.body,
          source_created_at: item.created_at ?? null,
          source_updated_at: item.updated_at ?? null,
          metadata_json: item.metadata_json,
          parser_version: parserVersionForConnector(connectorId),
          now: syncStartedAt,
        }) as any;
        if (ingested.status === 'skipped') {
          skippedUnchanged++;
        } else {
          persisted++;
        }
      }
      const syncFinishedAt = nextConnectorSyncTimestamp();
      deletedArchived = await archiveMissingConnectorItems(engine, sourceId, connectorId, loaded, false, syncFinishedAt);
      await operationsByName.record_connector_sync_success.handler(ctx(engine), {
        source_id: sourceId,
        connector_id: connectorId,
        cursor_json: {
          source_scope: loaded.source_scope,
          source_locator: loaded.source_locator,
        },
        sync_started_at: syncStartedAt,
        ingested_count: persisted,
        skipped_count: skippedUnchanged,
        now: syncFinishedAt,
        metadata_json: {
          planned_count: loaded.items.length,
          skipped_files_count: loaded.skipped_files.length,
          deleted_archived_count: deletedArchived,
          source_scope: loaded.source_scope,
          path_display: loaded.path_display,
        },
      });
    } catch (error) {
      await recordConnectorFailure(engine, sourceId, connectorId, error);
      throw error;
    }
  }

  return {
    connector_id: connectorId as LocalConnectorSyncResult['connector_id'],
    source_id: sourceId,
    dry_run: dryRun,
    source_scope: loaded.source_scope,
    path_display: loaded.path_display,
    planned: loaded.items.length,
    persisted,
    skipped_unchanged: skippedUnchanged,
    deleted_archived: deletedArchived,
    skipped_files: loaded.skipped_files,
  };
}

function resolveConnectorTarget(connectorId: string, path: string): LocalConnectorTarget {
  if (connectorId === MEETING_TRANSCRIPTS_CONNECTOR_ID) {
    return resolveMeetingTranscriptFilesystemTarget(path);
  }
  return resolveLocalFileConnectorTarget(connectorId as LocalFileConnectorId, path);
}

function loadConnectorItems(connectorId: string, path: string): LoadedLocalConnector {
  if (connectorId === MEETING_TRANSCRIPTS_CONNECTOR_ID) {
    return loadMeetingTranscriptFilesystemItems({ path });
  }
  return loadLocalFileConnectorItems({
    connector_id: connectorId as LocalFileConnectorId,
    path,
  });
}

function parserVersionForConnector(connectorId: string): string {
  if (connectorId === MEETING_TRANSCRIPTS_CONNECTOR_ID) return 'meeting-transcripts-filesystem:v1';
  return `${connectorId}-filesystem:v1`;
}

async function archiveMissingConnectorItems(
  engine: BrainEngine,
  sourceId: string,
  connectorId: string,
  loaded: LoadedLocalConnector,
  dryRun: boolean,
  syncTimestamp: string,
): Promise<number> {
  const presentExternalIds = new Set([
    ...loaded.items.map((item) => item.external_id),
    ...loaded.skipped_files.map((file) => file.relative_path),
  ]);
  const persistedExternalIds = await listPersistedSourceItemExternalIds(engine, sourceId);
  let archived = 0;
  for (const externalId of persistedExternalIds) {
    if (presentExternalIds.has(externalId)) continue;
    const deletion = await operationsByName.record_connector_item_deletion.handler(ctx(engine, dryRun), {
      source_id: sourceId,
      connector_id: connectorId,
      external_id: externalId,
      deleted_at: syncTimestamp,
      now: syncTimestamp,
    }) as any;
    if (deletion.status === 'recorded' || deletion.status === 'dry_run') archived++;
  }
  return archived;
}

function nextConnectorSyncTimestamp(): string {
  const now = Date.now();
  const next = Math.max(now, lastConnectorSyncTimestampMs + 1);
  lastConnectorSyncTimestampMs = next;
  return new Date(next).toISOString();
}

async function listPersistedSourceItemExternalIds(
  engine: BrainEngine,
  sourceId: string,
): Promise<string[]> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT external_id
    FROM source_items
    WHERE source_id = ?
    ORDER BY external_id ASC
  `;
  const rows = candidate.database
    ? candidate.database.query<Record<string, unknown>>(sql).all(sourceId)
    : candidate.sql?.unsafe
      ? await candidate.sql.unsafe(sql.replace('?', '$1'), [sourceId])
      : candidate.db
        ? (await candidate.db.query(sql.replace('?', '$1'), [sourceId])).rows
        : null;
  if (!rows) throw new Error('connectors sync requires a SQL-backed source registry');
  return rows.map((row) => String(row.external_id));
}

async function findBlockingConnectorSource(
  engine: BrainEngine,
  connectorId: string,
  locator: string,
): Promise<any | null> {
  const listed = await operationsByName.list_sources.handler(ctx(engine), {
    connector_id: connectorId,
    locator_overlap: locator,
    blocked_for_ingest: true,
    limit: 1,
  }) as any;
  return listed.sources[0] ?? null;
}

async function findExactConnectorSource(
  engine: BrainEngine,
  connectorId: string,
  locator: string,
): Promise<any | null> {
  const listed = await operationsByName.list_sources.handler(ctx(engine), {
    connector_id: connectorId,
    locator,
    limit: 1,
  }) as any;
  return listed.sources[0] ?? null;
}

function connectorSourceBlockReason(source: any): string | null {
  if (source.consent_state !== 'granted') {
    return `source consent ${source.consent_state} prevents connector sync`;
  }
  if (source.enabled !== true || source.paused_at) {
    return 'source processing is paused for connector sync';
  }
  return null;
}

async function recordConnectorFailure(
  engine: BrainEngine,
  sourceId: string,
  connectorId: string,
  error: unknown,
): Promise<void> {
  await operationsByName.record_connector_failure.handler(ctx(engine), {
    source_id: sourceId,
    connector_id: connectorId,
    error_message: error instanceof Error ? error.message : String(error),
  });
}

function ctx(engine: BrainEngine, dryRun = false): OperationContext {
  return {
    engine,
    config: loadConfig() ?? DEFAULT_RUNTIME_CONFIG,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun,
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
