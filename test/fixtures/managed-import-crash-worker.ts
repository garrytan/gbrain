// Executed only in an owned subprocess by test/e2e/managed-import-crash.test.ts (GBRA-69).
// Imports one file into a managed source and SIGKILLs itself at a boundary:
// `admitted` (the request is durable and nothing has claimed it) or
// `closing_write` (inside the publication transaction, at the import's one closing page write).
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';

const [kind, target, file, sourcePath, sourceId, boundary] = process.argv.slice(2) as [string, string, string, string, string, 'admitted' | 'closing_write'];
const Engine = kind === 'pglite' ? PGLiteEngine : PostgresEngine;
const marker = boundary === 'admitted' ? 'FOR UPDATE OF r SKIP LOCKED' : 'UPDATE pages SET chunker_version=$5';
const original = Engine.prototype.executeRaw;
Engine.prototype.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
  if (sql.includes(marker)) {
    process.stdout.write(`${JSON.stringify({ event: 'boundary', boundary })}\n`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  return original.call(this, sql, params);
} as typeof original;
const engine = new Engine();
await engine.connect(kind === 'pglite' ? { database_path: target } : { database_url: target, poolSize: 4 });
await importManagedFile(engine, file, sourcePath, { sourceId, noEmbed: true });
process.stdout.write(`${JSON.stringify({ event: 'completed' })}\n`);
process.exit(0);
