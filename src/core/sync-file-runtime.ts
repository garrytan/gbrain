import type { ImportResult } from './import-file.ts';

export const SYNC_FILE_FORMAT_VERSION = 1;

export type SyncFileOptions = {
  noEmbed: boolean;
  forceRechunk?: boolean;
  sourceId?: string;
  includeOffice?: boolean;
  includeImages?: boolean;
  documentOcr?: boolean;
  structured?: boolean;
  session?: boolean;
  activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
};

export interface SyncFileRuntime {
  signal: AbortSignal;
  importFile(path: string, relativePath: string, options: SyncFileOptions): Promise<ImportResult & { deferred?: boolean }>;
  finish(): Promise<void>;
}

export class SyncFilesDeferred extends Error {
  constructor() { super('sync_files_deferred'); this.name = 'SyncFilesDeferred'; }
}
