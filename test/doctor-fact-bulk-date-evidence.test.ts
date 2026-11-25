import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { factBulkDatesCheck } from '../src/commands/doctor/checks/fact-bulk-dates.ts';
import type { Check } from '../src/commands/doctor.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';

const sameLine = 'Event first observed on 2025-04-10.';
const otherLine = 'Event first observed on 2025-04-03.';
const linkLine = 'See [archive](https://example.org/archive/2025-04-10) for details.';
const rev = '10000000-0000-4000-8000-000000000001';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const recorded = '2025-04-10T12:00:00Z';
for (const backend of testBackends()) {
  describe(`bulk fact date evidence (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let tmp: string;
    let origin: number;
    const firstDay = (check: Check | undefined) => (check?.details?.days as Array<Record<string, unknown>> | undefined)?.[0];
    const evidence = (fact: number, originalLine: number, line: string, eventDay = '2025-04-10') => ({
      source_id: 'default', fact_id: fact, entity_slug: 'event-' + (fact % 20), valid_from: recorded, claim_sha256: sha('Event '+fact),
      original_page_id: origin, original_revision: rev, line: originalLine, line_sha256: sha(line), event_day: eventDay,
    });

    beforeAll(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'gbrain-bulk-date-test-'));
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      const [page] = await engine.executeRaw<{id: number}>(`
        INSERT INTO pages (source_id,slug,type,title,compiled_truth,knowledge_revision)
        VALUES ('default','notes/source-events','note','Source events',$1,$2) RETURNING id
      `, [sameLine+'\n'+otherLine+'\n'+linkLine, rev]);
      origin = Number(page.id);
      await engine.executeRaw(`
        INSERT INTO facts(id,source_id,entity_slug,fact,kind,visibility,valid_from,source)
        SELECT i,'default','event-'||(i%20),'Event '||i,'event','world',$1::timestamptz,'fixture'
        FROM generate_series(1,200) i
      `, [recorded]);
    });

    afterAll(async () => { await close?.(); await rm(tmp, { recursive: true, force: true }); });

    test('separates matching independent dates, contradictions, and rows with missing or invalid evidence', async () => {
      const path = join(tmp, 'evidence.json');
      await writeFile(path, JSON.stringify({ version: 1, facts: [
        evidence(1,1,sameLine), evidence(2,2,otherLine,'2025-04-03'),
        { ...evidence(3,1,sameLine), original_revision:'20000000-0000-4000-8000-000000000002' },
        { ...evidence(4,1,sameLine), claim_sha256:sha('superseded claim') },
        evidence(5,3,linkLine),
        evidence(6,1,sameLine), evidence(6,2,otherLine,'2025-04-03'),
        { ...evidence(7,1,sameLine), valid_from:'2025-04-10T00:00:00Z' },
        { ...evidence(8,1,sameLine), entity_slug:'other-entity' },
      ]}));
      const check = await factBulkDatesCheck(engine, ['default'], path);
      expect(check.status).toBe('warn');
      expect(firstDay(check)).toMatchObject({ facts: 200, dated_claims: 0,
        event_date_evidence: { verified_same_day: 1, verified_different_day: 1, unknown: 198 } });
      expect(check.message).not.toContain('These dates record when the facts were loaded');
    });

    test('absent or unreadable evidence makes no affirmative date claims and leaves the raw warning', async () => {
      for (const path of [undefined, join(tmp, 'missing.json')]) {
        const check = await factBulkDatesCheck(engine, ['default'], path);
        expect(check.status).toBe('warn');
        expect(firstDay(check)?.event_date_evidence).toEqual({
          verified_same_day: 0, verified_different_day: 0, unknown: 200,
        });
      }
    });

    test('remote wave checks never consume a host evidence manifest', async () => {
      const path = join(tmp, 'remote-evidence.json');
      await writeFile(path, JSON.stringify({ version: 1, facts: [evidence(1,1,sameLine)] }));
      const [result] = await runWaveChecks(engine, { ids: new Set(['fact_bulk_dates']), sourceIds: ['default'],
        remote: true, factDateEvidencePath: path });
      expect(firstDay(result?.check)?.event_date_evidence).toEqual({
        verified_same_day: 0, verified_different_day: 0, unknown: 200,
      });
    });
  });
}
