/**
 * The writer-version reads (persistence/writer-versions.ts, migration 178): when the brain started stamping the
 * writer versions of its write requests. One SQL implementation for both engines; the statement is the text the
 * doctor's writer_version check always sent, byte for byte. Times come back as ISO text so every engine answers the
 * same shape.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** A timestamp column as ISO text (a Date on Postgres and PGLite, ISO text on Rust); null stays null. */
export function isoTime(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

/** `readWriterVersionCutoff`: the doctor's writer_version check text, byte for byte. */
export const WRITER_VERSION_CUTOFF_SQL = 'SELECT writer_version_cutoff AS cutoff FROM persistence_brain WHERE singleton=1';

/** When the brain started stamping writer versions (migration 178), as ISO text; null when it is not recorded. */
export async function readWriterVersionCutoff(exec: LegacyUnscopedRead): Promise<string | null> {
  const [brain] = await exec.executeRaw<{ cutoff: unknown }>(WRITER_VERSION_CUTOFF_SQL);
  return brain?.cutoff ? isoTime(brain.cutoff) : null;
}
