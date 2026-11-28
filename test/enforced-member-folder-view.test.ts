/**
 * The enforced member CLI judges a new slug by the folder rules it would sit under (memberPageView, GBRA-108 design 1).
 * Until the engine members of ec-05 it asked SQL (`gbrain_access_folder_rules` with `folderRulesAllowedSql` and, for a
 * labelled-only member, `labelledOnlyForSql`); now it reads the covering rule ids (`readSlugFolderRules`) and judges them
 * in TypeScript on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: the TypeScript judgment equals the SQL it replaced, for every mix of covering rules, satisfied rules,
 *     pending-coverage prefixes of the member's record (valid, whole-source, other source, malformed) and the labelled-only flag.
 *  2. Fails when: the judgment admits a slug the SQL hid or hides one it admitted (a create the member may not make, or one it may).
 *  3. Existing coverage: test/engine-parity/enforced-member-reads.test.ts compares the engines, not the TypeScript to the old SQL.
 *  4. Seams: none; PGLite with a real rule, the old statements verbatim.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { memberPageView, type EnforcedAccess } from '../src/cli/enforced-member.ts';
import { folderRulesAllowedSql, labelledOnlyForSql, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { proposeRevision } from '../src/core/access/policy.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await proposeRevision(engine, 'default', [{ id: 'team-a', prefix: 'team-a/', readable_by: ['group:team-a'] }] as never, { origin: 'cli', store: 'database' } as never);
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

/** The statement memberPageView ran for a slug with no row, before the typed members. */
async function sqlView(access: EnforcedAccess['access'], sourceId: string, slug: string): Promise<'hidden' | 'missing'> {
  const folder = withCallerAccess(access, () => folderRulesAllowedSql('p', access.satisfiedRuleIds))
    + (access.labelledOnly ? ' AND ' + labelledOnlyForSql('p', [access.identity], access.satisfiedRuleIds, false) : '');
  const [rule] = await engine.executeRaw<{ ok: boolean }>('SELECT (' + folder + ') AS ok FROM (SELECT $1::text AS source_id, $2::text AS slug, gbrain_access_folder_rules($1, $2) AS folder_rule_ids) p', [sourceId, slug]);
  return rule?.ok ? 'missing' : 'hidden';
}

const SATISFIED = [[], ['default:team-a'], ['default:team-a', 'default:team-a'], ['not a rule id'], ['other:team-a']];
const COVERAGE = [[], [{ source_id: 'default', prefix: 'team-a/' }], [{ source_id: 'default', prefix: '' }], [{ source_id: 'other', prefix: '' }],
  [{ source_id: 'default', prefix: 'notes/' }], [{ source_id: 'Bad Id', prefix: 'x/' }], [{ source_id: 'default', prefix: 'no slash' }]];
const SLUGS = [['default', 'team-a/new'], ['default', 'notes/new'], ['default', 'team-a'], ['other', 'team-a/new']] as const;

describe('a new slug under folder rules: the TypeScript judgment equals the SQL it replaced', () => {
  test('every mix of satisfied rules, coverage and the labelled-only flag', async () => {
    const differ: string[] = [];
    let judged = 0;
    for (const satisfiedRuleIds of SATISFIED) for (const folderCoverage of COVERAGE) for (const labelledOnly of [false, true]) {
      const access = { identity: ['member:tess-example'], satisfiedRuleIds, folderCoverage, labelledOnly, hidePrivate: true, owner: false, privateReadableSources: [], restricted: true } as EnforcedAccess['access'];
      for (const [sourceId, slug] of SLUGS) {
        const ea: EnforcedAccess = { member: 'tess-example', access, hiddenSources: new Set() };
        const [typed, sql] = [await memberPageViewNoRow(ea, sourceId, slug), await sqlView(access, sourceId, slug)];
        judged++;
        if (typed !== sql) differ.push(JSON.stringify({ satisfiedRuleIds, folderCoverage, labelledOnly, sourceId, slug, typed, sql }));
      }
    }
    expect({ judged, differ }).toEqual({ judged: SATISFIED.length * COVERAGE.length * 2 * SLUGS.length, differ: [] });
  }, 120_000);
});

/** memberPageView for a slug that has no row: only the folder rules judge it. */
async function memberPageViewNoRow(ea: EnforcedAccess, sourceId: string, slug: string) {
  return await memberPageView(engine, ea, sourceId, slug) as 'hidden' | 'missing';
}
