/**
 * The op_checkpoints `op` name of an uncommitted fence-repair notice. It lives
 * in this leaf module so the op-checkpoint purge (reached from the Postgres
 * engine) can name the op without loading the git commit path, which keeps
 * the engine loadable under Node (test/openclaw-compact-node-loadable.test.ts).
 */
export const FENCE_UNCOMMITTED_OP = 'fence-repair-uncommitted';
