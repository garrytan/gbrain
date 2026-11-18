/**
 * #9653: a version a purge hid (needs_rederive, derived_table 'page_versions') stays hidden on every read of history:
 * get_versions, get_page known_as_of, get_page as_of and revert_version. The page itself stays live and readable. PGLite,
 * and Postgres with DATABASE_URL. Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import { hideDerivedRows } from '../src/core/facts/derivation-inputs.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const at = async (b: BeliefBrain) => { await pause(); const [r] = await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`); await pause(); return new Date(r!.t).toISOString(); };
const read = (b: BeliefBrain, params: Record<string, unknown>) => operationsByName.get_page!.handler(b.ctx, params) as Promise<Record<string, any>>;
const versions = (b: BeliefBrain, params: Record<string, unknown>) => operationsByName.get_versions!.handler(b.ctx, params) as Promise<any>;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'error');
const slug = 'concepts/harbor-example';
const draft = (prose: string, validFrom: string) => beliefPage({ type: 'concept', title: 'Harbor', prose, frontmatter: { valid_from: validFrom } });

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`#9653 a purge-marked version stays hidden on every history read (${engineCase.name})`, () => {
    test('get_versions, known_as_of, as_of and revert_version never return it', () => beliefBrain(async b => {
      await b.put(slug, draft('Narrative canaryone built with a purged atom.', '2026-01-01'));
      const t1 = await at(b);
      await b.put(slug, draft('Narrative canarytwo rebuilt without it.', '2026-03-01'));
      const all = await b.engine.getVersions(slug, { sourceId: b.sourceId });
      const old = all.find(v => String(v.compiled_truth).includes('canaryone'))!;
      expect(old).toBeDefined();
      expect((await read(b, { slug, known_as_of: t1 })).compiled_truth).toContain('canaryone');
      expect((await read(b, { slug, as_of: '2026-02-01' })).compiled_truth).toContain('canaryone');
      await b.engine.transaction(tx => hideDerivedRows(tx, [{ table: 'page_versions', id: String(old.id), depth: 1 }], { sourceId: b.sourceId, requestId: null, reason: 'purge:test' }));
      expect(JSON.stringify(await versions(b, { slug, include_body: true }))).not.toContain('canaryone');
      const atT1 = await read(b, { slug, known_as_of: t1 });
      expect(atT1).toMatchObject({ body: 'unavailable', body_reason: 'purged' });
      expect(JSON.stringify(atT1)).not.toContain('canaryone');
      expect(JSON.stringify(await refusal(read(b, { slug, as_of: '2026-02-01' })))).not.toContain('canaryone');
      expect(JSON.stringify(await read(b, { slug, as_of: '2026-02-01' }).catch(e => e))).not.toContain('canaryone');
      const page = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
      expect(await refusal(b.op('revert_version', { slug, version_id: Number(old.id), expected_revision: page!.revision, request_id: randomUUID() }))).toBe('not_found');
      expect((await read(b, { slug })).compiled_truth).toContain('canarytwo');
    }, { managed: true, databaseUrl: engineCase.databaseUrl }), 120_000);
  });
}
