/**
 * The two reads a labelled-only create and a write over a deleted page used to send as raw statements
 * (persistence/page-visibility.ts), now typed members: the old and the new answers match on PGLite and Postgres.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) assertLabelledOnlyCreate asked `SELECT COALESCE(gbrain_access_folder_rules($1, $2) && $3::text[], false)`; it now reads
 *    the rules over the slug (readSlugFolderRules) and judges the overlap in TypeScript, and the answer is the same for no rule, a
 *    satisfied rule, an unsatisfied rule, two rules with one satisfied, an empty satisfied set and a slug no rule covers.
 *    (2) hiddenUnder's fallback `SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND NOT (<policy>) LIMIT 1` is
 *    readPageHiddenFromWriter, which sends the same text and answers the same for live, soft-deleted and absent rows.
 *  - Regression: both statements ran through executeRaw, which the Rust engine refuses, so a labelled-only member's create and a
 *    plain member's write over a deleted page ended on engine_capability_missing there (rows 32e-b-3 and 32e-d-2).
 *  - Why existing coverage misses it: the parity cases compare outcomes; none compares the new typed read with the statement it
 *    replaced on a real SQL engine.
 *  - Seam: none. Real PGLite, and real Postgres when DATABASE_URL is set; the old statements are written out here verbatim.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { renderWriterReadPolicy, type WriterReadPolicy } from '../src/core/engine-sql/remote-links.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'work';
const rule = (id: string, prefix: string, ...readable_by: string[]) => ({ id, prefix, readable_by });

for (const kind of testBackends()) {
  describe(`the typed reads of a labelled-only create and of a write over a deleted page (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await proposeRevision(engine, SRC, [rule('team', 'ruled/', 'member:carol-example'), rule('others', 'ruled/', 'member:alice-example'),
        rule('only-others', 'oth/', 'member:alice-example'), rule('exact', 'exact/page', 'member:carol-example')], { origin: 'cli', store: 'database' });
      const put = (slug: string, frontmatter: Record<string, unknown>) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter }, { sourceId: SRC });
      for (const [name, frontmatter] of Object.entries({ open: {}, 'names-bob': { readable_by: ['bob-example'] }, 'names-alice': { readable_by: ['alice-example'] }, private: { visibility: 'private' } })) {
        await put(`notes/${name}`, frontmatter);
        await put(`gone/${name}`, frontmatter);
        await engine.softDeletePage(`gone/${name}`, { sourceId: SRC });
      }
    }, 120_000);

    afterAll(async () => { await close?.(); });

    test('the folder rules over a slug and the overlap judged in TypeScript answer what the SQL overlap answered', async () => {
      const old = async (slug: string, satisfied: string[]) =>
        (await engine.executeRaw<{ named: boolean }>('SELECT COALESCE(gbrain_access_folder_rules($1, $2) && $3::text[], false) AS named', [SRC, slug, satisfied]))[0]?.named === true;
      const now = async (slug: string, satisfied: string[]) => ((await engine.readSlugFolderRules(SRC, slug)) ?? []).some(id => satisfied.includes(id));
      const satisfiedSets = [[], [`${SRC}:team`], [`${SRC}:others`], [`${SRC}:team`, `${SRC}:others`], [`${SRC}:only-others`], [`${SRC}:exact`], ['other:team'], ['']];
      const answers: Record<string, [boolean, boolean]> = {};
      for (const slug of ['ruled/a', 'oth/a', 'exact/page', 'exact/page/child', 'elsewhere/a', 'notes/open'])
        for (const satisfied of satisfiedSets) answers[`${slug} ${JSON.stringify(satisfied)}`] = [await old(slug, satisfied), await now(slug, satisfied)];
      for (const [name, [was, is]] of Object.entries(answers)) expect({ name, is }).toEqual({ name, is: was });
      // The shapes the contract names: not every answer is false, and the two-rule case is the overlap.
      expect(answers[`ruled/a ${JSON.stringify([`${SRC}:team`])}`]).toEqual([true, true]);
      expect(answers[`ruled/a ${JSON.stringify([`${SRC}:only-others`])}`]).toEqual([false, false]);
      expect(answers[`ruled/a ${JSON.stringify([`${SRC}:team`, `${SRC}:others`])}`]).toEqual([true, true]);
      expect(answers['ruled/a []']).toEqual([false, false]);
      expect(answers['elsewhere/a ["work:team"]']).toEqual([false, false]);
    });

    const policy = (over: Partial<WriterReadPolicy>): WriterReadPolicy => ({ identities: [['member:bob-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false, ...over });
    const writers: Record<string, WriterReadPolicy> = {
      bob: policy({}),
      carol: policy({ identities: [['member:carol-example']], labelledOnly: true }),
      'carol under a rule': policy({ identities: [['member:carol-example']], satisfiedRuleIds: [`${SRC}:team`], labelledOnly: true }),
      nobody: policy({ identities: [] }),
      owner: policy({ identities: [['member:alice-example']], owner: true }),
    };

    test('readPageHiddenFromWriter answers what the statement it replaced answered, for live, soft-deleted and absent rows', async () => {
      const old = async (slug: string, p: WriterReadPolicy, hide: boolean) => (await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2
      AND NOT (${renderWriterReadPolicy(p, 'pages', hide)}) LIMIT 1`, [SRC, slug])).length > 0;
      const slugs = ['open', 'names-bob', 'names-alice', 'private'].flatMap(n => [`notes/${n}`, `gone/${n}`]).concat('notes/absent');
      const hiddenSomewhere = new Set<boolean>();
      for (const [name, p] of Object.entries(writers)) for (const hide of [true, false]) for (const slug of slugs) {
        const was = await old(slug, p, hide);
        hiddenSomewhere.add(was);
        expect({ name, hide, slug, hidden: await engine.readPageHiddenFromWriter(SRC, slug, p, hide) }).toEqual({ name, hide, slug, hidden: was });
      }
      // The comparison is not vacuous: some rows hide and some do not, and a soft-deleted row is judged like a live one.
      expect([...hiddenSomewhere].sort()).toEqual([false, true]);
      expect(await engine.readPageHiddenFromWriter(SRC, 'gone/names-alice', writers.bob!, true)).toBe(true);
      expect(await engine.readPageHiddenFromWriter(SRC, 'gone/names-bob', writers.bob!, true)).toBe(false);
      expect(await engine.readPageHiddenFromWriter(SRC, 'notes/absent', writers.bob!, true)).toBe(false);
      expect(await engine.readPageHiddenFromWriter('other', 'notes/names-alice', writers.bob!, true)).toBe(false);
    });
  });
}
