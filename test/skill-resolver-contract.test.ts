/**
 * GBRA-377 PR A: the checked-in JSON Schemas (docs/schemas/skill-resolver.v1.*)
 * match what the library and the CLI produce and accept.
 *
 * 1. Protects: the schema_version 1 contract adapters code against (turn
 *    input, turn output, the --from-json catalog, the build receipt).
 * 2. Fails when: an output gains, drops or retypes a field without the
 *    schema moving with it, or the schema accepts an input the resolver
 *    refuses (or the reverse).
 * 3. Seam: test/helpers/json-schema-lite.ts (no new dependency).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, normalizeTurnInput, resolveSkills, ResolverError } from '../src/core/skills/resolver/index.ts';
import { readJsonSource } from '../src/core/skills/resolver/sources.ts';
import { loadSchema, validate } from './helpers/json-schema-lite.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'skres-contract-')); dirs.push(d); return d; };

const INPUT = loadSchema('skill-resolver.v1.turn-input');
const OUTPUT = loadSchema('skill-resolver.v1.turn-output');
const CATALOG = loadSchema('skill-resolver.v1.build-input');
const RECEIPT = loadSchema('skill-resolver.v1.build-receipt');
const SKILLS = [
  { id: 'gbrain:deploy', name: 'deploy', description: 'Ship a service to production after the tests pass', path: '/skills/deploy/SKILL.md' },
  { id: 'gbrain:reports', name: 'reports', description: 'Write weekly status reports', triggers: ['status report'] },
  { id: 'x:off', name: 'off', eligible: false },
];

describe('turn input', () => {
  const good = [{ message: 'deploy' }, { message: '', top_k: 8, exclude: [], shadow: false, reset_session: true }, { message: 'x', session_id: 'a'.repeat(256), harness: 'codex', expected_catalog_hash: 'a'.repeat(64), previous_user_message: 'y' }, { message: 'x', exclude: Array(1024).fill('a'), min_match_strength: 'description', harness: 'pi' }, { message: 'x', top_gate: 1.5 }, { message: 'x', top_gate: 0 }];
  const bad = [{}, { message: 1 }, { message: 'x', top_k: 0 }, { message: 'x', top_k: 9 }, { message: 'x', top_k: 2.5 }, { message: 'x', extra: true }, { message: 'x', harness: 'vim' },
    { message: 'x', session_id: '' }, { message: 'x', session_id: 'a b' }, { message: 'x', exclude: Array(1025).fill('a') }, { message: 'x', min_match_strength: 'weak' }, { message: 'x', top_gate: 101 }, { message: 'x', top_gate: -0.5 }, { message: 'x', exclude: [1] }, { message: 'x', expected_catalog_hash: 'ABC' }, { message: 'x', shadow: 'yes' }];
  test('the schema and the resolver accept and refuse the same inputs', () => {
    for (const g of good) { expect(validate(INPUT, g)).toEqual([]); expect(() => normalizeTurnInput(g)).not.toThrow(); }
    for (const b of bad) {
      expect({ b, schema: validate(INPUT, b).length > 0 }).toEqual({ b, schema: true });
      let code = '';
      try { normalizeTurnInput(b); } catch (e) { code = (e as ResolverError).code; }
      expect({ b, code }).toEqual({ b, code: 'skill_resolve_invalid_input' });
    }
  });
});

describe('build input (the --from-json catalog)', () => {
  test('accepted catalogs validate; refused ones do not', () => {
    const openclaw = { workspaceDir: '/work/acme-example', managedSkillsDir: '/work/acme-example/skills', skills: [{ name: 'deploy', description: 'Ship it', eligible: true, disabled: false, modelVisible: true, emoji: 'x' }] };
    for (const g of [SKILLS, { skills: SKILLS }, [], openclaw]) { expect(validate(CATALOG, g)).toEqual([]); expect(() => readJsonSource(JSON.stringify(g))).not.toThrow(); }
    for (const b of [{ workspaceDir: '/w', skills: [{ description: 'no name' }] }, { workspaceDir: '/w', skills: [{ name: 'a', disabled: 'yes' }] }]) {
      expect(validate(CATALOG, b).length).toBeGreaterThan(0);
      expect(() => readJsonSource(JSON.stringify(b))).toThrow();
    }
    for (const b of [[{ id: 'a' }], [{ id: '', name: 'b' }], [{ id: 'a', name: 'b', triggers: 'x' }], [{ id: 'a', name: 'b', eligible: 'no' }], { list: [] }, 'x']) {
      expect(validate(CATALOG, b).length).toBeGreaterThan(0);
      expect(() => readJsonSource(JSON.stringify(b))).toThrow();
    }
  });
});

describe('turn output and build receipt', () => {
  test('every result shape validates: suggestions, ack, no_match, shadow, merged, explain, fail-open error', async () => {
    const home = tmp();
    const f = join(tmp(), 'cat.json');
    writeFileSync(f, JSON.stringify(SKILLS));
    const r1 = await buildSkillIndex({ catalog: 'one', fromJson: f }, { home });
    const root = join(tmp(), 'skills');
    mkdirSync(join(root, 'lint'), { recursive: true });
    writeFileSync(join(root, 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Run the linters before a deploy\n---\nSteps.\n');
    const r2 = await buildSkillIndex({ catalog: 'two', dirs: [root], scope: 'project', harness: 'codex' }, { home });
    const r3 = await buildSkillIndex({ catalog: 'three', fromJson: JSON.stringify(SKILLS), fromJsonStdin: true }, { home });
    const r4 = await buildSkillIndex({ catalog: 'four', fromJson: f, dirs: [root] }, { home });
    mkdirSync(join(root, '..', 'claude', 'plugins'), { recursive: true });
    const r5 = await buildSkillIndex({ catalog: 'five', claudePlugins: join(root, '..', 'claude') }, { home });
    for (const r of [r1, r2, r3, r4, r5]) expect(validate(RECEIPT, JSON.parse(JSON.stringify(r)))).toEqual([]);
    const results = [
      await resolveSkills({ message: 'deploy the service', session_id: 's', harness: 'codex' }, { home, catalogs: ['one'] }),
      await resolveSkills({ message: 'thanks' }, { home, catalogs: ['one'] }),
      await resolveSkills({ message: 'zzqxv' }, { home, catalogs: ['one'] }),
      await resolveSkills({ message: 'deploy', shadow: true, session_id: 's' }, { home, catalogs: ['one'] }),
      await resolveSkills({ message: 'lint then deploy' }, { home, catalogs: ['one', 'two'], explainTarget: 'x:off' }),
      await resolveSkills({ message: 'deploy' }, { home, catalogs: ['missing'], failOpen: true }),
    ];
    for (const r of results) {
      const docs = [r.output, ...(r.shadowOutput ? [r.shadowOutput] : []), ...(r.explain ? [{ ...r.output, explain: r.explain }] : [])];
      for (const d of docs) expect(validate(OUTPUT, JSON.parse(JSON.stringify(d)))).toEqual([]);
    }
    expect(results[0]!.output.suggestions[0]!.path).toBe('/skills/deploy/SKILL.md');
    expect(results[4]!.output.ranker.variant).toBe('T+D');
    expect(results[5]!.output.error!.code).toBe('skill_index_missing');
  });

  test('the schemas reject a document with an extra or missing field', async () => {
    const home = tmp();
    await buildSkillIndex({ catalog: 'one', fromJson: JSON.stringify(SKILLS), fromJsonStdin: true }, { home });
    const out = JSON.parse(JSON.stringify((await resolveSkills({ message: 'deploy' }, { home })).output));
    expect(validate(OUTPUT, { ...out, surprise: 1 })).toEqual(['$: unexpected property surprise']);
    const { block: _drop, ...noBlock } = out;
    expect(validate(OUTPUT, noBlock)).toEqual(['$: missing block']);
  });
});
