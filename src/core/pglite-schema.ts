/**
 * PGLite schema façade. The bootstrap template is generated from src/schema.sql
 * and the TS schema fragments by scripts/build-schema.ts (`bun run build:schema`)
 * into pglite-schema.generated.ts; edit those sources, never the generated file.
 * Canonical-source graph and the PGLite capability rules: docs/ENGINES.md
 * ("Canonical schema sources").
 */
export { getPGLiteSchema, PGLITE_SCHEMA_SQL } from './pglite-schema.generated.ts';
