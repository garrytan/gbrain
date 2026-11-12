import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { accessLineageEntry } from '../src/commands/doctor/checks/access-lineage.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { classifyRulebook, parsePolicyYaml, rulebookDigest, rulesFromJson, serializePolicyYaml, type FolderRule } from '../src/core/access/folder-rules.ts';
import { appliedRules, policyStatus, previewApply } from '../src/core/access/policy.ts';
import { buildLineageBrain, derivedOf, factsOf, type LineageBrain, type Seen } from './helpers/access-lineage-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

/**
 * GBRA-108 Design 4: raw-only folder and page rules (covers_derived: false).
 * 1. Protects: a rule keeps the pages it covers to its readers and, by default, also closes the lineage of the pages and
 *    facts derived from them (unchanged on upgrade, same digest). A raw-only rule keeps only its own pages: the atoms,
 *    derived_from pages, synthesized concepts, Life Chronicle events and facts derived from them are read by whoever
 *    reads those derivatives. Turning a rule raw-only is a widening held for gbrain access apply; turning it back applies
 *    at once. The origin's own readers list still closes its lineage.
 * 2. Fails when: a default rule's digest or reads change; a raw-only proposal widens anything before apply; apply widens
 *    anything beyond the raw-only rule's derived pages and facts, or opens the raw page itself; a derivative of a page
 *    whose readers list names a member opens; the narrowing back is held; or doctor does not list the raw-only rule.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true); the access rule CLI; rules in the database (repo-less) and in a committed access.yml
 *    (git); PGLite, and Postgres with DATABASE_URL; embeddings stubbed.
 */

const ALICE = 'member:alice-example';
const COVERING: FolderRule[] = [
  { id: 'transcripts', prefix: 'transcripts/', readable_by: [ALICE] },
  { id: 'vault', prefix: 'vault/', readable_by: [ALICE, 'group:team-a'] },
];
const RAW_ONLY: FolderRule[] = [{ ...COVERING[0]!, covers_derived: false }, COVERING[1]!];

describe('raw-only rule grammar, digest and classification', () => {
  test('covers_derived: false parses, serializes and round-trips; true is the default and is not carried', () => {
    const yml = serializePolicyYaml(RAW_ONLY);
    expect(yml).toContain('covers_derived: false');
    const parsed = parsePolicyYaml(yml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rules.find(r => r.id === 'transcripts')?.covers_derived).toBe(false);
    expect('covers_derived' in parsed.rules.find(r => r.id === 'vault')!).toBe(false);
    const explicitTrue = parsePolicyYaml(yml.replace('covers_derived: false', 'covers_derived: true'));
    expect(explicitTrue.ok && explicitTrue.rules.every(r => !('covers_derived' in r))).toBe(true);
    expect(serializePolicyYaml(COVERING)).not.toContain('covers_derived');
    expect(parsePolicyYaml(yml.replace('covers_derived: false', 'covers_derived: maybe')).ok).toBe(false);
    expect(rulesFromJson(JSON.stringify(RAW_ONLY))).toEqual(rulesFromJson(JSON.stringify(RAW_ONLY)).map(r => r.id === 'transcripts' ? { ...r, covers_derived: false } : r));
  });

  test('a covering rulebook keeps the digest it had before raw-only rules existed; a raw-only rule changes it', () => {
    // The digest v0.60.682.0 computed for COVERING, before covers_derived existed.

    expect(rulebookDigest(COVERING)).toBe('7921ac7ce30f5bfc93ebcf0abe88bd4262337ff0a2c6fb003f0f9251281dfd04');
    expect(rulebookDigest(RAW_ONLY)).not.toBe(rulebookDigest(COVERING));
  });

  test('covering to raw-only is a held widening; raw-only to covering is a narrowing', () => {
    const widen = classifyRulebook(COVERING, RAW_ONLY);
    expect(widen.kind).toBe('widening');
    expect(widen.held.map(c => [c.rule, c.kind])).toEqual([['transcripts', 'derived_released']]);
    expect(rulebookDigest(widen.target)).toBe(rulebookDigest(COVERING));
    const narrow = classifyRulebook(RAW_ONLY, COVERING);
    expect(narrow.kind).toBe('narrowing');
    expect(narrow.changes.map(c => [c.rule, c.kind, c.narrowing])).toEqual([['transcripts', 'derived_covered', true]]);
    expect(narrow.held).toEqual([]);
    expect(rulebookDigest(narrow.target)).toBe(rulebookDigest(COVERING));
  });
});

const ORIGINS = {
  raw: { slug: 'transcripts/raw-example', fm: [] as string[], derive: true },
  rdr: { slug: 'transcripts/rdr-example', fm: ['readable_by: [alice-example]'], derive: true },
  cov: { slug: 'vault/cov-example', fm: [] as string[], derive: true },
  open: { slug: 'notes/open-example', fm: [] as string[], derive: true },
};
const CALLERS = ['alice', 'bob', 'unbound', 'granted'] as const;

for (const kind of testBackends()) {
  for (const store of ['database', 'git'] as const) {
    describe(`raw-only rules (${kind}, rules in ${store === 'git' ? 'access.yml' : 'the database, repo-less'})`, () => {
      let b: LineageBrain;
      const SRC = 'raw-src';
      const off: Record<string, Seen> = {};

      async function cli(args: string[]): Promise<any> {
        const lines: string[] = [];
        const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
        try { await runAccessRules(b.engine, args[0]!, args.slice(1), args.includes('--json')); } finally { spy.mockRestore(); }
        return JSON.parse(lines.join('\n'));
      }
      const doctor = async () => Object.fromEntries((await accessLineageEntry.run({ engine: b.engine } as unknown as DoctorContext) as Array<{ name: string; status: string; message: string; details?: any }>).map(c => [c.name, c]));
      const views = async () => Object.fromEntries(await Promise.all(CALLERS.map(async c => [c, await b.seenBy(c)] as const))) as Record<string, Seen>;

      beforeAll(async () => {
        b = await buildLineageBrain({
          kind, store, src: SRC, tag: 'raw', origins: ORIGINS, rules: COVERING,
          members: ['alice-example', 'bob-example'], groups: { 'team-a': ['bob-example'] },
          callers: [{ name: 'alice', member: 'alice-example' }, { name: 'bob', member: 'bob-example' }, { name: 'unbound' }, { name: 'granted', grantedSources: true }],
        });
      }, 300_000);
      afterAll(async () => { await b?.close(); }, 60_000);

      test('by default a rule also keeps the pages and facts derived from its pages to its readers', async () => {
        Object.assign(off, await views());
        expect(off.alice).toEqual(b.expected(['raw', 'rdr', 'cov', 'open', ...derivedOf(b.keys, ['open'])], factsOf(b.keys, ['open'])));
        expect(off.bob).toEqual(b.expected(['cov', 'open', ...derivedOf(b.keys, ['open'])], factsOf(b.keys, ['open'])));
        expect(off.unbound).toEqual(b.expected(['open', ...derivedOf(b.keys, ['open'])], factsOf(b.keys, ['open'])));
        expect(off.granted).toEqual(off.unbound);
        expect((await doctor()).access_raw_only_rules.status).toBe('ok');
        expect((await doctor()).access_raw_only_rules.message).toStartWith('Not applicable');
      }, 120_000);

      test('rule add --raw-only is a widening held for access apply: nothing changes until it is approved', async () => {
        const result = await cli(['rule', 'add', '--id', 'transcripts', '--prefix', 'transcripts/', '--readers', 'alice-example', '--raw-only', '--source', SRC, '--yes', '--json']);
        expect(JSON.stringify(result)).toContain('derived_released');
        const status = await policyStatus(b.engine, SRC);
        expect(status.held.map(c => [c.rule, c.kind])).toEqual([['transcripts', 'derived_released']]);
        expect(rulebookDigest(status.rules)).toBe(rulebookDigest(COVERING));
        expect(status.desired?.rules.find(r => r.id === 'transcripts')?.covers_derived).toBe(false);
        const preview = await previewApply(b.engine, SRC);
        const widening = preview.widening.find(w => w.change.rule === 'transcripts');
        expect(widening?.lineage).toBe(true);
        expect(widening?.gains).toBe('every_source_reader');
        expect(widening?.sample.sort()).toEqual([ORIGINS.raw.slug, ORIGINS.rdr.slug]);
        expect(await views()).toEqual(off);
      }, 120_000);

      test('after apply the only change for any caller is the derived pages and facts of the raw-only rule\'s own pages', async () => {
        await b.approve();
        expect((await appliedRules(b.engine, SRC)).find(r => r.id === 'transcripts')?.covers_derived).toBe(false);
        const on = await views();
        const raw = derivedOf(b.keys, ['raw']);
        expect(on.alice).toEqual(b.expected(['raw', 'rdr', 'cov', 'open', ...derivedOf(b.keys, ['open', 'raw'])], factsOf(b.keys, ['open', 'raw'])));
        expect(on.bob).toEqual(b.expected(['cov', 'open', ...derivedOf(b.keys, ['open', 'raw'])], factsOf(b.keys, ['open', 'raw'])));
        for (const who of ['unbound', 'granted']) expect(on[who]).toEqual(b.expected(['open', ...derivedOf(b.keys, ['open', 'raw'])], factsOf(b.keys, ['open', 'raw'])));
        for (const who of CALLERS) {
          for (const label of Object.keys(on[who]!)) {
            const gained = on[who]![label]!.filter(k => !off[who]![label]!.includes(k));
            expect(gained.every(k => raw.includes(k) || k === 'raw.fact')).toBe(true);
            expect(off[who]![label]!.every(k => on[who]![label]!.includes(k))).toBe(true);
          }
        }
        const checks = await doctor();
        expect(checks.access_raw_only_rules.message).toContain(`${SRC}:transcripts (transcripts/)`);
        expect(checks.access_raw_only_rules.message).toContain('never for a folder whose content is itself the secret');
      }, 120_000);

      test('turning the rule back to covering is a narrowing that applies at once', async () => {
        const result = await cli(['rule', 'add', '--id', 'transcripts', '--prefix', 'transcripts/', '--readers', 'alice-example', '--source', SRC, '--yes', '--json']);
        expect(JSON.stringify(result)).toContain('derived_covered');
        expect(rulebookDigest(await appliedRules(b.engine, SRC))).toBe(rulebookDigest(COVERING));
        expect((await policyStatus(b.engine, SRC)).held).toEqual([]);
        expect(await views()).toEqual(off);
        expect((await doctor()).access_raw_only_rules.message).toStartWith('Not applicable');
      }, 120_000);
    });
  }
}
