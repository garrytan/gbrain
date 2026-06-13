import {
  CONNECTOR_DEFINITIONS,
  getConnectorDefinition,
} from '../core/connectors/connector-registry.ts';
import {
  loadMeetingTranscriptFilesystemItems,
  resolveMeetingTranscriptFilesystemTarget,
  type MeetingTranscriptFilesystemLoad,
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
  const existing = await findMeetingTranscriptSource(engine, target.source_locator);
  const blockReason = existing ? connectorSourceBlockReason(existing.source) : null;
  if (blockReason) {
    throw new Error(blockReason);
  }

  const loaded = loadMeetingTranscriptFilesystemItems({ path });
  let sourceId: string | null = existing?.source.id ?? null;
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
      await operationsByName.record_connector_failure.handler(ctx(engine), {
        source_id: sourceId,
        connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
        error_message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
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

async function findMeetingTranscriptSource(
  engine: BrainEngine,
  locator: string,
): Promise<any | null> {
  const listed = await operationsByName.list_sources.handler(ctx(engine), {
    connector_id: MEETING_TRANSCRIPTS_CONNECTOR_ID,
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
