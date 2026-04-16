/**
 * Edge Function bundle entry point.
 *
 * Curated exports for Supabase Edge Functions (Deno runtime).
 * Excludes modules that depend on Node.js filesystem APIs:
 * - db.ts (reads schema.sql from disk — now uses schema-embedded.ts)
 * - config.ts (reads ~/.gbrain/config.json via homedir())
 * - import-file.ts (uses readFileSync/statSync)
 * - sync.ts (git-based, local filesystem)
 */
export { operations, operationsByName, OperationError, MCP_INSTRUCTIONS } from './core/operations.ts';
export type { Operation, OperationContext, ParamDef } from './core/operations.ts';
export { PostgresEngine } from './core/postgres-engine.ts';
export type { BrainEngine } from './core/engine.ts';
export * from './core/types.ts';
export { VERSION } from './version.ts';
