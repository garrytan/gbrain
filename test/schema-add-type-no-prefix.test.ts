/**
 * #6135: `schema add-type --no-prefix` declares a type pages get only from
 * frontmatter (`path_prefixes: []`). Leaving out both `--prefix` and
 * `--no-prefix` is still refused, and the refusal names both choices;
 * `--no-prefix` with `--extractable` / `--expert` is refused naming the flag and
 * the lint rule. The type name is the first positional, never a flag value.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTypeToPack, applyMutationsAtomic } from '../src/core/schema-pack/mutate.ts';
import { computeMutateAuditPath } from '../src/core/schema-pack/mutate-audit.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { parseAddTypeArgs } from '../src/commands/schema-add-type.ts';
import type { OperationError } from '../src/core/ops/contract.ts';

let home: string;
let auditDir: string;
let lockDir: string;
let packPath: string;

function seedPack(): string {
  const dir = join(home, '.gbrain', 'schema-packs', 'my-pack');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    api_version: 'gbrain-schema-pack-v1', name: 'my-pack', version: '1.0.0', description: '',
    gbrain_min_version: '0.38.0', extends: null, borrow_from: [],
    page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: [], extractable: false, expert_routing: false }],
    link_types: [], frontmatter_links: [], takes_kinds: ['fact', 'take', 'bet', 'hunch'], enrichable_types: [], filing_rules: [],
  } as unknown as SchemaPackManifest;
  const path = join(dir, 'pack.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return path;
}

const typeNamed = (name: string) => loadPackFromFile(packPath).page_types.find(t => t.name === name);

beforeEach(() => {
  _resetPackCacheForTests();
  home = mkdtempSync(join(tmpdir(), 'gbrain-add-type-no-prefix-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-add-type-audit-'));
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-add-type-locks-'));
  packPath = seedPack();
});

afterEach(() => {
  _resetPackCacheForTests();
  for (const d of [home, auditDir, lockDir]) rmSync(d, { recursive: true, force: true });
});

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: auditDir }, fn);

describe('#6135 addTypeToPack noPrefix (core)', () => {
  test('writes path_prefixes: [], validates and records an audit row', async () => {
    await inHome(async () => {
      await addTypeToPack('my-pack', { name: 'archive', primitive: 'concept', noPrefix: true }, { lockDir });
      expect(typeNamed('archive')).toMatchObject({ primitive: 'concept', path_prefixes: [] });
      const rows = readFileSync(computeMutateAuditPath(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows.some(r => r.op === 'add_type' && r.outcome === 'success' && r.prefix_first_seg === null)).toBe(true);
    });
  });

  test('refuses noPrefix with extractable or expert routing, naming the lint rule', async () => {
    await inHome(async () => {
      await expect(addTypeToPack('my-pack', { name: 'archive', primitive: 'concept', noPrefix: true, extractable: true }, { lockDir }))
        .rejects.toThrow(/extractable_empty_corpus/);
      await expect(addTypeToPack('my-pack', { name: 'archive', primitive: 'concept', noPrefix: true, expertRouting: true }, { lockDir }))
        .rejects.toThrow(/expert_routing_without_prefix/);
      await expect(addTypeToPack('my-pack', { name: 'archive', primitive: 'concept', noPrefix: true, prefix: 'archive/' }, { lockDir }))
        .rejects.toThrow(/not both/);
      expect(typeNamed('archive')).toBeUndefined();
    });
  });

  test('the batch path accepts no_prefix through the same mutator', async () => {
    await inHome(async () => {
      await applyMutationsAtomic('my-pack', [{ op: 'add_type', name: 'archive', primitive: 'concept', no_prefix: true }], { lockDir });
      expect(typeNamed('archive')).toMatchObject({ path_prefixes: [] });
    });
  });
});

describe('#6135 schema add-type CLI', () => {
  const cli = (args: string[]) => runCli(['schema', 'add-type', ...args, '--pack', 'my-pack'],
    { home, cwd: home, env: { GBRAIN_AUDIT_DIR: auditDir }, timeoutMs: 60_000 });

  test('--no-prefix adds a frontmatter-only type and says so', async () => {
    const r = await cli(['archive', '--primitive', 'concept', '--no-prefix', '--json']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).note).toContain('frontmatter');
    expect(typeNamed('archive')).toMatchObject({ primitive: 'concept', path_prefixes: [] });
  }, 90_000);

  test('the type name is the positional, not a flag value', async () => {
    const r = await cli(['--primitive', 'concept', 'archive', '--prefix', 'archive/']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(typeNamed('archive')).toMatchObject({ primitive: 'concept', path_prefixes: ['archive/'] });
    expect(typeNamed('concept')).toBeUndefined();
  }, 90_000);

  test('missing both --prefix and --no-prefix is refused naming both choices', async () => {
    const r = await cli(['archive', '--primitive', 'concept', '--json']);
    expect(r.exitCode).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc.code).toBe('invalid_params');
    const text = `${doc.message} ${doc.suggestion}`;
    expect(text).toContain('--prefix people/researchers/');
    expect(text).toContain('--no-prefix');
    expect(typeNamed('archive')).toBeUndefined();
  }, 90_000);

  test('--no-prefix with --extractable or --expert is refused naming the flag and lint rule', async () => {
    for (const [flag, rule] of [['--extractable', 'extractable_empty_corpus'], ['--expert', 'expert_routing_without_prefix']]) {
      const r = await cli(['archive', '--primitive', 'concept', '--no-prefix', flag, '--json']);
      expect(r.exitCode, flag).toBe(2);
      const doc = JSON.parse(r.stdout);
      expect(doc.code).toBe('invalid_params');
      expect(doc.message).toContain(flag);
      expect(`${doc.message} ${doc.why}`).toContain(rule);
    }
    expect(typeNamed('archive')).toBeUndefined();
  }, 90_000);
});

describe('#6135 add-type refusal fixes are runnable commands', () => {
  const fill: Record<string, string> = { '<NAME>': 'archive', '<PRIMITIVE>': 'concept', '<PREFIX>': 'archive/' };
  const refusals: string[][] = [
    ['--primitive', 'concept'],
    ['archive'],
    ['archive', '--primitive', 'concept'],
    ['archive', '--primitive', 'concept', '--no-prefix', '--extractable'],
    ['archive', '--primitive', 'concept', '--no-prefix', '--expert'],
    ['archive', '--primitive', 'concept', '--no-prefix', '--prefix', 'archive/'],
  ];
  for (const args of refusals) {
    test(`fix for [${args.join(' ')}] parses under the same parser`, () => {
      let err: OperationError | undefined;
      try { parseAddTypeArgs(args); } catch (e) { err = e as OperationError; }
      expect(err?.code).toBe('invalid_params');
      const argv = err!.fix!.argv!;
      expect(argv.slice(0, 3)).toEqual(['gbrain', 'schema', 'add-type']);
      for (const input of err!.fix!.inputs ?? []) expect(argv).toContain(`<${input.name}>`);
      expect(() => parseAddTypeArgs(argv.slice(3).map(a => fill[a] ?? a))).not.toThrow();
    });
  }
});
