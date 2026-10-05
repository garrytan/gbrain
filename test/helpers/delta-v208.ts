import { v208 } from '../../src/core/schema-migrations/v208-delta-per-arm-cursor.ts';

/** The v208 migration's statements, split for executeRaw (one statement per call on both engines). */
export const V208_SQL_FOR_TESTS: string[] = v208.sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
