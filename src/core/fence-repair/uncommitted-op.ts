/**
 * The op_checkpoints `op` of the fence repair's uncommitted-file notices (fence-repair/uncommitted.ts). A leaf module:
 * the checkpoint purge SQL (op-checkpoint-purge-sql.ts, loaded by the Postgres engine) needs only the name, and
 * importing it from uncommitted.ts would pull the git and chunker modules (and their Bun-only assets) into every
 * engine load.
 */
export const FENCE_UNCOMMITTED_OP = 'fence-repair-uncommitted';
