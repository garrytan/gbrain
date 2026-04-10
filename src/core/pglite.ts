import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { EngineConfig } from './types.ts';

export interface PGliteBridgeHandle {
  connectionString: string;
  stop(): Promise<void>;
}

export function getPGliteDataDir(databasePath: string): string {
  const expandedPath = databasePath.startsWith('~/')
    ? resolve(homedir(), databasePath.slice(2))
    : resolve(databasePath);
  return `${expandedPath}.pglite`;
}

export function isPGliteConfig(config: EngineConfig | null | undefined): boolean {
  return config?.engine === 'pglite';
}

export function resolveImportWorkerCount(requestedWorkers: number, config: EngineConfig | null | undefined): number {
  if (isPGliteConfig(config)) return 1;
  return requestedWorkers;
}

export async function startPGliteBridge(databasePath: string): Promise<PGliteBridgeHandle> {
  const dataDir = getPGliteDataDir(databasePath);
  mkdirSync(dirname(dataDir), { recursive: true });

  const db = await PGlite.create(dataDir, {
    extensions: {
      vector,
      pg_trgm,
    },
  });

  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  `);

  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 4,
  });
  await server.start();

  const rawConn = server.getServerConn();
  const connectionString = rawConn.includes('://')
    ? rawConn
    : `postgresql://postgres@${rawConn}/postgres`;

  return {
    connectionString,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
