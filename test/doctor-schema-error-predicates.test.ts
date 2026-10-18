/**
 * Wave 18b (1.1): doctor handlers read a missing column or table as
 * "pre-migration" only when the error names the object that migration adds.
 * Before, `isUndefinedColumnError(e, col)` ignored `col` whenever a SQLSTATE
 * was present and `isUndefinedTableError(e)` also matched
 * `column "x" of relation "y" does not exist`, so each check below reported
 * ok / skipped for an UNRELATED missing column or table.
 *
 * Each check runs against a real PGLite engine whose SQL reads throw the
 * fixture error; the "named" arm proves the genuine pre-migration degrade
 * still reads ok.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext, DoctorEntry } from '../src/commands/doctor/context.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor/checks/extraction-sync.ts';
import { effectiveDateEntry, factsExtractionEntry, salienceEntry } from '../src/commands/doctor/checks/knowledge-health.ts';
import { checkOauthClientScopeHealth, checkOauthConfidentialHealth, checkStaleLocks } from '../src/commands/doctor/checks/routing-federation.ts';
import { trustScanEntry } from '../src/commands/doctor/checks/trust-scan.ts';
import { trustSourcesUnclaimedEntry } from '../src/commands/doctor/checks/trust-sources-unclaimed.ts';
import { trustTiersEntry } from '../src/commands/doctor/checks/trust-tiers.ts';
import { checkCanonicalContentWrites } from '../src/commands/doctor/checks/canonical-content.ts';
import { checkSharedSkillsSources } from '../src/commands/doctor/checks/shared-skills.ts';
import { checkVolunteerChannels } from '../src/commands/doctor/checks/core-health.ts';

let real: PGLiteEngine;
beforeAll(async () => {
  real = new PGLiteEngine();
  await real.connect({});
  await real.initSchema();
}, 60_000);
afterAll(async () => { await real.disconnect(); }, 60_000);

const missingColumn = (column: string, relation = 'pages') =>
  Object.assign(new Error(`column "${column}" of relation "${relation}" does not exist`), { code: '42703' });
const missingBareColumn = (column: string) => Object.assign(new Error(`column "${column}" does not exist`), { code: '42703' });
const missingTable = (table: string) => Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' });

/** The real engine, except every SQL read (executeRaw, the raw PGLite handle, the stale-page counter) throws `error`. */
function failingEngine(error: Error): BrainEngine {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'executeRaw' || prop === 'countStalePagesForExtraction') return async () => { throw error; };
      if (prop === 'db') return { query: async () => { throw error; } };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

const viaEntry = (entry: DoctorEntry) => async (engine: BrainEngine): Promise<Check> => {
  const checks = await entry.run({ engine, args: [], progress: { heartbeat() {}, finish() {} } } as unknown as DoctorContext) as Check[];
  return checks[0]!;
};

type Case = { check: string; run: (engine: BrainEngine) => Promise<Check | null>; named: Error[] };
const CASES: Case[] = [
  { check: 'links_extraction_lag', run: engine => checkLinksExtractionLag(engine), named: [missingBareColumn('links_extracted_at')] },
  { check: 'facts_extraction_health', run: viaEntry(factsExtractionEntry), named: [missingTable('ingest_log'), missingBareColumn('source_id')] },
  { check: 'effective_date_health', run: viaEntry(effectiveDateEntry), named: [missingBareColumn('effective_date_source')] },
  { check: 'salience_health', run: viaEntry(salienceEntry), named: [missingBareColumn('emotional_weight'), missingTable('takes')] },
  { check: 'oauth_client_scope_health', run: checkOauthClientScopeHealth, named: [missingTable('oauth_clients'), missingBareColumn('federated_read')] },
  { check: 'oauth_confidential_client_health', run: checkOauthConfidentialHealth, named: [missingTable('oauth_clients')] },
  { check: 'stale_locks', run: engine => checkStaleLocks(engine), named: [missingTable('gbrain_cycle_locks')] },
  { check: 'trust_scan', run: viaEntry(trustScanEntry), named: [missingBareColumn('trust_tier'), missingTable('takes')] },
  { check: 'trust_sources_unclaimed', run: viaEntry(trustSourcesUnclaimedEntry), named: [missingBareColumn('trust_tier')] },
  { check: 'trust_tiers', run: viaEntry(trustTiersEntry), named: [missingBareColumn('trust_tier')] },
];

describe('doctor checks fed an unrelated missing column or table report the real error (1.1)', () => {
  for (const c of CASES) {
    test(`${c.check}: an unrelated 42703 is not ok`, async () => {
      const result = await c.run(failingEngine(missingColumn('zz_unrelated')));
      expect(result?.status).not.toBe('ok');
      expect(result?.message).toContain('zz_unrelated');
    });

    test(`${c.check}: an unrelated 42P01 is not ok`, async () => {
      const result = await c.run(failingEngine(missingTable('zz_unrelated_table')));
      expect(result?.status).not.toBe('ok');
      expect(result?.message).toContain('zz_unrelated_table');
    });

    for (const named of c.named) {
      test(`${c.check}: the named pre-migration object (${named.message}) still degrades to ok`, async () => {
        const result = await c.run(failingEngine(named));
        expect(result?.status).toBe('ok');
      });
    }
  }
});

describe('message-only swallows name their objects (1.1)', () => {
  test('canonical_content_writes: an unrelated missing column is reported, a missing persistence table is not', async () => {
    const unrelated = await checkCanonicalContentWrites(failingEngine(missingColumn('zz_unrelated')));
    expect(unrelated?.status).toBe('warn');
    expect(await checkCanonicalContentWrites(failingEngine(missingTable('persistence_brain')))).toBeNull();
  });

  test('shared_skills_sources: an unrelated missing column is reported, a pre-archived sources table is not', async () => {
    const unrelated = await checkSharedSkillsSources(failingEngine(missingColumn('zz_unrelated')));
    expect(unrelated?.status).toBe('warn');
    expect(unrelated?.message).toContain('zz_unrelated');
    expect(await checkSharedSkillsSources(failingEngine(missingBareColumn('archived')))).toBeNull();
  });

  test('volunteer_channels: only a missing context_volunteer_events table reads as a pre-v117 brain', async () => {
    const unrelated = await checkVolunteerChannels(failingEngine(missingColumn('zz_unrelated', 'context_volunteer_events')));
    expect(unrelated.message).toContain('volunteer_channels query failed');
    const absent = await checkVolunteerChannels(failingEngine(missingTable('context_volunteer_events')));
    expect(absent.message).toContain('pre-v117 brain');
  });
});
