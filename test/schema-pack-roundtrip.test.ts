/**
 * Schema-pack YAML round trip (#6432, wave 14 P1.2).
 *
 * Protects: a pack mutation leaves every scalar it did not touch
 * byte-identical. Before the fix the emitter JSON-quoted any string with a
 * `|` and the parser read a double-quoted scalar back with its escapes
 * intact, so a link-type regex holding `\b` doubled its backslashes on
 * every `add-alias` (2 → 4 → 8; a reporter's pack.yaml reached 1 GB and
 * every CLI process 50 GB RSS). Existing coverage drives single primitives
 * and never re-reads the regex. No production seam: the real
 * `addAliasToType` path, the real file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAliasToType, emitYaml } from '../src/core/schema-pack/mutate.ts';
import { loadPackFromFile, parseYamlMini } from '../src/core/schema-pack/loader.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

const REGEX = '\\b(works? at|employed by)\\b';
const PACK_YAML = `api_version: gbrain-schema-pack-v1
name: mine
version: 1.0.0
description: 'it''s a "quoted" # pack'
gbrain_min_version: 0.38.0
extends: null
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases: []
    extractable: false
    expert_routing: false
link_types:
  - name: works_at
    inverse: employs
    inference:
      regex: ${REGEX}
`;

let tmpDir: string;
let auditDir: string;
let lockDir: string;

beforeEach(() => {
  _resetPackCacheForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-roundtrip-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-roundtrip-audit-'));
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-roundtrip-locks-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  for (const d of [tmpDir, auditDir, lockDir]) rmSync(d, { recursive: true, force: true });
});

function seed(): string {
  const dir = join(tmpDir, '.gbrain', 'schema-packs', 'mine');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, PACK_YAML, 'utf-8');
  return path;
}

describe('mutations keep untouched scalars byte-identical', () => {
  test('three add-alias runs leave the regex and the quoted description unchanged', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seed();
      expect(loadPackFromFile(path).link_types![0]!.inference!.regex).toBe(REGEX);
      let previous: string | null = null;
      for (const alias of ['zz-probe-1', 'zz-probe-2', 'zz-probe-3']) {
        await addAliasToType('mine', 'person', alias, { lockDir });
        const manifest = loadPackFromFile(path);
        expect(manifest.link_types![0]!.inference!.regex).toBe(REGEX);
        expect(manifest.description).toBe('it\'s a "quoted" # pack');
        expect(manifest.page_types[0]!.aliases).toContain(alias);
        const regexLine = readFileSync(path, 'utf-8').split('\n').find(l => l.includes('regex:'))!;
        expect(regexLine.length).toBeLessThan(80);
        if (previous) expect(regexLine).toBe(previous);
        previous = regexLine;
      }
    });
  });
});

describe('emit → parse → emit is the identity for every string shape', () => {
  test.each([
    ['\\b(works? at|employed by)\\b'],
    ['a\\"b'],
    ['a\\\\"b'],
    ["it's # not a comment"],
    ['x"#y'],
    ['tab\there'],
    ['new\nline'],
    ['trailing backslash \\'],
    ['  leading and trailing  '],
    ['true'],
    ['42'],
    ['[not, a, list]'],
    [''],
  ])('%j survives a round trip', (s) => {
    const manifest = { description: s, items: [s], nested: { deep: s } };
    const once = emitYaml(manifest);
    const parsed = parseYamlMini(once) as typeof manifest;
    expect(parsed).toEqual(manifest);
    expect(emitYaml(parsed)).toBe(once);
  });
});
