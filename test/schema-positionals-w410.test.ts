/**
 * Wave 12 W4.10: pack-authoring `schema` subcommands read their names from the
 * first positionals that are not flag values. `remove-type --pack mine people`
 * used to name the type `mine`, and `add-link-type --inverse founded_by founded`
 * silently wrote a link type called `founded_by`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { schemaPositionals } from '../src/commands/schema-add-type.ts';

let home: string;
let auditDir: string;
let packPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-positionals-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-schema-positionals-audit-'));
  const dir = join(home, '.gbrain', 'schema-packs', 'mine');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    api_version: 'gbrain-schema-pack-v1', name: 'mine', version: '1.0.0', description: '',
    gbrain_min_version: '0.38.0', extends: null, borrow_from: [],
    page_types: [
      { name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: ['human'], extractable: false, expert_routing: false },
      { name: 'company', primitive: 'entity', path_prefixes: ['companies/'], aliases: [], extractable: false, expert_routing: false },
    ],
    link_types: [], frontmatter_links: [], takes_kinds: ['fact', 'take', 'bet', 'hunch'], enrichable_types: [], filing_rules: [],
  } as unknown as SchemaPackManifest;
  packPath = join(dir, 'pack.json');
  writeFileSync(packPath, JSON.stringify(manifest, null, 2) + '\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(auditDir, { recursive: true, force: true }); });

const cli = (...args: string[]) => runCli(['schema', ...args], { home, cwd: home, env: { GBRAIN_AUDIT_DIR: auditDir }, timeoutMs: 60_000 });
const pack = () => loadPackFromFile(packPath);

describe('W4.10: schema subcommands skip flag values when reading names', () => {
  test('add-link-type with --inverse before the name writes the named link type', async () => {
    expect((await cli('add-link-type', '--inverse', 'founded_by', 'founded', '--pack', 'mine')).exitCode).toBe(0);
    const link = pack().link_types.find(l => l.name === 'founded');
    expect(link).toBeTruthy();
    expect(link!.inverse).toBe('founded_by');
    expect(pack().link_types.find(l => l.name === 'founded_by')).toBeUndefined();
  }, 90_000);

  test('remove-type with --pack before the name removes that type', async () => {
    expect((await cli('remove-type', '--pack', 'mine', 'company')).exitCode).toBe(0);
    expect(pack().page_types.map(t => t.name)).toEqual(['person']);
  }, 90_000);

  test('remove-alias with --pack before the type and alias', async () => {
    expect((await cli('remove-alias', '--pack', 'mine', 'person', 'human')).exitCode).toBe(0);
    expect(pack().page_types.find(t => t.name === 'person')!.aliases).toEqual([]);
  }, 90_000);

  test('the parser skips the value of each value flag and keeps flags after the name working', () => {
    expect(schemaPositionals(['--pack', 'mine', 'people'], [])).toEqual(['people']);
    expect(schemaPositionals(['people', '--pack', 'mine', '--json'], [])).toEqual(['people']);
    expect(schemaPositionals(['--inverse', 'founded_by', 'founded', '--page-type', 'person'], ['--inverse', '--page-type'])).toEqual(['founded']);
    expect(schemaPositionals(['--pack=mine', 'people'], [])).toEqual(['people']);
  });
});
