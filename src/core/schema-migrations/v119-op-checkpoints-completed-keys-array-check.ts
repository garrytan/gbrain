import type { Migration } from './types.ts';

export const v119: Migration = {
  version: 119,
  name: 'op_checkpoints_completed_keys_array_check',
  // v0.42.x — make the op_checkpoints scalar-corruption class structurally
  // impossible. completed_keys is JSONB and the loader runs
  // jsonb_array_elements_text(completed_keys); a non-array (scalar) value
  // makes that throw "cannot extract elements from a scalar", which takes
  // down the whole UNION load (including the valid op_checkpoint_paths child
  // rows) and loses all checkpoint progress for that key. No current writer
  // can produce a scalar, but an older binary / external script / future bug
  // could — the CHECK is a DB-enforced, always-on guard (the correct pattern
  // vs a migration verify-hook, which would not run on already-stamped
  // brains). LOCK first so an out-of-band scalar write can't land between the
  // repair and the ADD CONSTRAINT (no-op on single-connection PGLite). The
  // repair resets any pre-existing scalar to '[]'; op_checkpoint_paths child
  // rows are the append-only source of truth, so the reset loses nothing.
  // Mirrored in src/schema.sql, src/core/pglite-schema.ts, and the generated
  // src/core/schema-embedded.ts so fresh installs carry the same CHECK.
  idempotent: true,
  sql: `
      LOCK TABLE op_checkpoints IN SHARE ROW EXCLUSIVE MODE;

      UPDATE op_checkpoints
         SET completed_keys = '[]'::jsonb, updated_at = now()
       WHERE jsonb_typeof(completed_keys) <> 'array';

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'op_checkpoints_completed_keys_array'
             AND conrelid = 'op_checkpoints'::regclass
        ) THEN
          ALTER TABLE op_checkpoints
            ADD CONSTRAINT op_checkpoints_completed_keys_array
            CHECK (jsonb_typeof(completed_keys) = 'array');
        END IF;
      END $$;
    `,
};
