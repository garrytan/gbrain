/**
 * The field usage sample read of `gbrain schema detect --fields` (BrainEngine readFieldUsageSamples), served by
 * gbrain-store `field_usage` (rust/docs/store/field-usage.md). The store keeps the same two master behaviours as
 * engine-sql/field-usage.ts: pages of an archived source count, and a segmented page samples a null body.
 */
import type { FieldUsageQuery, FieldUsageTypeSample } from '../../engine-sql/field-usage.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

/** The live page types with their counts and the oldest pages of each, as the PGLite read answers them. */
export const readFieldUsageSamples: StoreMember<[query: FieldUsageQuery], FieldUsageTypeSample[]> = async (brain, query) => {
  const taken = takeOptions('readFieldUsageSamples', query, ['sourceId', 'maxTypes', 'samplePerType', 'type', 'countsOnly']);
  const out: Array<{ type: string; pages: number; rows: Array<{ frontmatter: Record<string, unknown> | null; compiled_truth: string | null }> }> =
    await storeCall({ member: 'readFieldUsageSamples' }, () => brain.readFieldUsageSamples(taken));
  return out.map((t) => ({
    type: String(t.type), pages: Number(t.pages),
    rows: t.rows.map((r) => ({ frontmatter: r.frontmatter ?? {}, compiled_truth: r.compiled_truth ?? null })),
  }));
};
