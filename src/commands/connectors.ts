import {
  CONNECTOR_DEFINITIONS,
  getConnectorDefinition,
} from '../core/connectors/connector-registry.ts';
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
    const result = await syncMeetingTranscripts(engine, args.slice(1));
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
`);
}

interface MeetingTranscriptSyncResult {
  connector_id: 'meeting_transcripts';
  source_id: string | null;
  dry_run: boolean;
  source_scope: MeetingTranscriptFilesystemLoad['source_scope'];
  path_display: string;
  planned: number;
  persisted: number;
  skipped_unchanged: number;
  skipped_files: MeetingTranscriptFilesystemLoad['skipped_files'];
}

async function syncMeetingTranscripts(
  engine: BrainEngine,
  args: string[],
): Promise<MeetingTranscriptSyncResult> {
  const connectorId = args[0];
  if (!connectorId) {
    throw new Error('Usage: mbrain connectors sync meeting_transcripts --path <file-or-directory>');
  }
  getConnectorDefinition(connectorId);
  if (connectorId !== MEETING_TRANSCRIPTS_CONNECTOR_ID) {
    throw new Error('connectors sync only supports meeting_transcripts');
  }

  const path = readFlag(args, '--path');
  if (!path) {
    throw new Error('Usage: mbrain connectors sync meeting_transcripts --path <file-or-directory>');
  }
  const dryRun = hasFlag(args, '--dry-run');
  const target = resolveMeetingTranscriptFilesystemTarget(path);
  const sources = await listMeetingTranscriptSources(engine);
  const blockingSource = findBlockingMeetingTranscriptSource(sources, target);
  if (blockingSource) {
    throw new Error(connectorSourceBlockReason(blockingSource.source) ?? 'source policy prevents connector sync');
  }
  const existing = findExactMeetingTranscriptSource(sources, target.source_locator);
  let sourceId: string | null = existing?.source.id ?? null;

  let loaded: MeetingTranscriptFilesystemLoad;
  try {
    loaded = loadMeetingTranscriptFilesystemItems({ path });
  } catch (error) {
    if (!dryRun && sourceId) {
      await recordConnectorFailure(engine, sourceId, error);
    }
    throw error;
  }

  let persisted = 0;
  let skippedUnchanged = 0;

  if (!dryRun && !sourceId) {
    const registered = await operationsByName.register_connector_source.handler(ctx(engine), {
      connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
      display_name: loaded.display_name,
      account_locator: loaded.account_locator,
      consent_state: 'granted',
      credential_ref_id: null,
      metadata_json: {
        source_scope: loaded.source_scope,
        path_display: loaded.path_display,
      },
    }) as any;
    sourceId = registered.source.id;
  }

  if (!dryRun && sourceId) {
    try {
      for (const item of loaded.items) {
        const ingested = await operationsByName.ingest_connector_item.handler(ctx(engine), {
          source_id: sourceId,
          connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
          external_id: item.external_id,
          locator: item.locator ?? null,
          title: item.title,
          body: item.body,
          source_created_at: item.created_at ?? null,
          source_updated_at: item.updated_at ?? null,
          metadata_json: item.metadata_json,
          parser_version: 'meeting-transcripts-filesystem:v1',
        }) as any;
        if (ingested.status === 'skipped') {
          skippedUnchanged++;
        } else {
          persisted++;
        }
      }
      await operationsByName.record_connector_sync_success.handler(ctx(engine), {
        source_id: sourceId,
        connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
        cursor_json: {
          source_scope: loaded.source_scope,
          source_locator: loaded.source_locator,
        },
        ingested_count: persisted,
        skipped_count: skippedUnchanged,
        metadata_json: {
          planned_count: loaded.items.length,
          skipped_files_count: loaded.skipped_files.length,
          source_scope: loaded.source_scope,
          path_display: loaded.path_display,
        },
      });
    } catch (error) {
      await recordConnectorFailure(engine, sourceId, error);
      throw error;
    }
  }

  return {
    connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
    source_id: sourceId,
    dry_run: dryRun,
    source_scope: loaded.source_scope,
    path_display: loaded.path_display,
    planned: loaded.items.length,
    persisted,
    skipped_unchanged: skippedUnchanged,
    skipped_files: loaded.skipped_files,
  };
}

async function listMeetingTranscriptSources(
  engine: BrainEngine,
): Promise<any[]> {
  const listed = await operationsByName.list_sources.handler(ctx(engine), {
    connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
    limit: 1000,
  }) as any;
  return listed.sources ?? [];
}

function findExactMeetingTranscriptSource(
  rows: any[],
  locator: string,
): any | null {
  return rows.find((row) => row.source?.locator === locator) ?? null;
}

function findBlockingMeetingTranscriptSource(
  rows: any[],
  target: MeetingTranscriptFilesystemTarget,
): any | null {
  return rows.find((row) => {
    if (!row.source || !sourceOverlapsTarget(row, target)) return false;
    return connectorSourceBlockReason(row.source) !== null;
  }) ?? null;
}

function sourceOverlapsTarget(row: any, target: MeetingTranscriptFilesystemTarget): boolean {
  const sourceLocator = row.source?.locator;
  if (typeof sourceLocator !== 'string') return false;
  if (sourceLocator === target.source_locator) return true;
  if (!sourceLocator.startsWith('file://') || !target.source_locator.startsWith('file://')) {
    return false;
  }

  const sourceScope = meetingTranscriptSourceScope(row);
  if (target.source_scope === 'directory' && fileUrlContains(target.source_locator, sourceLocator)) {
    return true;
  }
  if ((sourceScope === 'directory' || sourceScope === null)
    && fileUrlContains(sourceLocator, target.source_locator)) {
    return true;
  }
  return false;
}

function meetingTranscriptSourceScope(row: any): MeetingTranscriptFilesystemLoad['source_scope'] | null {
  const scope = row.connector_account?.metadata_json?.source_scope;
  return scope === 'file' || scope === 'directory' ? scope : null;
}

function fileUrlContains(container: string, candidate: string): boolean {
  if (container === candidate) return true;
  const prefix = container.endsWith('/') ? container : `${container}/`;
  return candidate.startsWith(prefix);
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
  error: unknown,
): Promise<void> {
  await operationsByName.record_connector_failure.handler(ctx(engine), {
    source_id: sourceId,
    connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
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
