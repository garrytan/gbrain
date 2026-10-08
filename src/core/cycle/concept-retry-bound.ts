/**
 * #6260: bounded paid retries for a concept whose narrative keeps failing.
 *
 * A concept narrative that fails (a response stopped before the end, an empty
 * response, a per-concept model error) is not stamped with its member hash, so
 * the next pass pays for it again. The bound counts those failures per concept
 * and member hash in the DB-only config key `dream.concepts.failed_attempts`
 * (`{ "<source>:<concept slug>": { member_hash, attempts, at } }`): after
 * MAX_CONCEPT_ATTEMPTS failures on unchanged members the concept is skipped
 * before any spend until its members change, a narrative succeeds, or the
 * operator unsets the key.
 */
import type { BrainEngine } from '../engine.ts';

export const CONCEPT_FAILED_ATTEMPTS_KEY = 'dream.concepts.failed_attempts';
export const MAX_CONCEPT_ATTEMPTS = 3;

interface Entry { member_hash: string; attempts: number; at: string }

export class ConceptRetryBound {
  private dirty = false;
  private constructor(private readonly entries: Record<string, Entry>) {}

  static async load(engine: BrainEngine): Promise<ConceptRetryBound> {
    try {
      const parsed = JSON.parse((await engine.getConfig(CONCEPT_FAILED_ATTEMPTS_KEY)) ?? '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new ConceptRetryBound({});
      const entries: Record<string, Entry> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, Partial<Entry>>)) {
        if (value && typeof value.member_hash === 'string' && Number.isSafeInteger(value.attempts)) {
          entries[key] = { member_hash: value.member_hash, attempts: value.attempts!, at: String(value.at ?? '') };
        }
      }
      return new ConceptRetryBound(entries);
    } catch {
      return new ConceptRetryBound({});
    }
  }

  exhausted(key: string, memberHash: string): boolean {
    const entry = this.entries[key];
    return !!entry && entry.member_hash === memberHash && entry.attempts >= MAX_CONCEPT_ATTEMPTS;
  }

  fail(key: string, memberHash: string): void {
    const prior = this.entries[key];
    this.entries[key] = { member_hash: memberHash, attempts: prior?.member_hash === memberHash ? prior.attempts + 1 : 1, at: new Date().toISOString() };
    this.dirty = true;
  }

  succeed(key: string): void {
    if (!(key in this.entries)) return;
    delete this.entries[key];
    this.dirty = true;
  }

  async save(engine: BrainEngine): Promise<void> {
    if (!this.dirty) return;
    await engine.setConfig(CONCEPT_FAILED_ATTEMPTS_KEY, JSON.stringify(this.entries)).catch((error: unknown) => {
      console.error(`[synthesize_concepts] could not record failed concept attempts: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
