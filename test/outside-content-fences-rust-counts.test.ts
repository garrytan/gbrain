/**
 * #9427 on a Rust brain: outside_content_fences reads the importer provenance and fingerprints the fence rows through raw
 * SQL (core/transcripts/fence-acceptance.ts), which the Rust engine does not serve, and `gbrain transcripts accept-fences`
 * refuses there, so no page can have been accepted. The check keeps serving the per-page counts it served before #9427
 * (typed member listOutsideContentFenceCounts) instead of failing with engine_capability_missing raw_sql.
 *
 * 1. Protects: an engine without raw_sql lists every page with fence rows through the typed member, never through the
 *    raw SQL read; an engine with raw_sql still takes the acceptance path.
 * 2. Fails when: the check calls listOutsideFencePages (raw SQL) on an engine that lacks raw_sql.
 */
import { describe, expect, test } from 'bun:test';
import { outsideContentFencesEntry } from '../src/commands/doctor/checks/outside-content-fences.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

const ROW = { source_id: 'default', slug: 'conversations/sessions/2026-01-02-example-a', type: 'conversation', facts: 1, world_facts: 0, takes: 0, links: 0 };

describe('outside_content_fences on an engine without raw SQL', () => {
  test('lists the typed per-page counts and never reaches for raw SQL', async () => {
    const raw: string[] = [];
    const engine = {
      capabilities: new Set<string>(['typed_members']),
      executeRaw: async (sql: string) => { raw.push(sql); throw new Error('engine_capability_missing raw_sql'); },
      transaction: async () => { raw.push('transaction'); throw new Error('engine_capability_missing raw_sql'); },
      getConfig: async () => { raw.push('getConfig'); return null; },
      listOutsideContentFenceCounts: async () => [ROW],
    };
    const checks = await outsideContentFencesEntry.run({ engine } as unknown as DoctorContext) as Check[];
    expect(raw).toEqual([]);
    expect(checks[0]!.status).toBe('warn');
    expect((checks[0]!.details as { items: unknown[]; pages: number }).items).toEqual([ROW]);
    expect((checks[0]!.details as { pages: number }).pages).toBe(1);
    expect((checks[0]!.fix as { argv: string[] }).argv).toEqual(['gbrain', 'get', '--source', 'default', '--', ROW.slug]);
  });

  test('no fence rows is ok', async () => {
    const engine = { capabilities: new Set<string>(['typed_members']), listOutsideContentFenceCounts: async () => [] };
    const checks = await outsideContentFencesEntry.run({ engine } as unknown as DoctorContext) as Check[];
    expect(checks[0]!.status).toBe('ok');
  });
});
