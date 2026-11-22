import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { v331 } from '../src/core/schema-migrations/v331-subagent-transcript-index.ts';

const originalSchema = `
  CREATE TABLE subagent_messages (
    job_id bigint NOT NULL, message_idx integer NOT NULL,
    CONSTRAINT uniq_subagent_messages_idx UNIQUE (job_id, message_idx)
  );
  CREATE INDEX idx_subagent_messages_job ON subagent_messages (job_id, message_idx);
`;

describe('transcript index migration', () => {
  test('retires only the original duplicate and preserves user changes', async () => {
    const db = await PGlite.create();
    try {
      await db.exec(originalSchema);
      const indexPresent = async () => {
        const { rows } = await db.query<{ present: boolean }>(
          "SELECT to_regclass('public.idx_subagent_messages_job') IS NOT NULL AS present",
        );
        return rows[0]!.present;
      };
      for (const change of [
        "COMMENT ON INDEX idx_subagent_messages_job IS 'operator managed'",
        'ALTER TABLE subagent_messages DROP CONSTRAINT uniq_subagent_messages_idx',
        'DROP INDEX idx_subagent_messages_job; CREATE INDEX idx_subagent_messages_job ON subagent_messages(message_idx, job_id)',
      ]) {
        await db.exec('BEGIN');
        await db.exec(change);
        await db.exec(v331.sql!);
        expect(await indexPresent()).toBe(true);
        await db.exec('ROLLBACK');
      }

      await db.exec(v331.sql!);
      await db.exec(v331.sql!);
      expect(await indexPresent()).toBe(false);
      await db.exec('INSERT INTO subagent_messages VALUES (3, 9)');
      await expect(db.exec('INSERT INTO subagent_messages VALUES (3, 9)')).rejects.toThrow(/unique constraint/);
    } finally {
      await db.close();
    }
  }, 30_000);
});
