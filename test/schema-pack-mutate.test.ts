// Schema cathedral v2 — mutate.ts unit tests.
//
// Verifies the add-type / remove-type primitives:
//   - round-trip JSON pack
//   - round-trip YAML pack (preserves shape, re-parses, re-validates)
//   - duplicate name rejection
//   - unknown type removal rejection
//   - bundled pack read-only guard
//   - validation gate before write

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTypeToPack,
  removeTypeFromPack,
  SchemaPackMutationError,
  loadPackFromFile,
} from '../src/core/schema-pack/index.ts';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-mutate-test-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function seedJsonPack(name: string): string {
  const dir = join(home, '.gbrain', 'schema-packs', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.json');
  writeFileSync(path, JSON.stringify({
    api_version: 'gbrain-schema-pack-v1',
    name,
    version: '0.0.1',
    extends: 'gbrain-base',
    description: 'unit test pack',
    page_types: [
      {
        name: 'seed-type',
        primitive: 'entity',
        path_prefixes: ['seed/'],
        aliases: [],
        extractable: false,
        expert_routing: false,
      },
    ],
    link_types: [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    borrow_from: [],
    frontmatter_links: [],
    enrichable_types: [],
    filing_rules: [],
  }, null, 2));
  return path;
}

function seedYamlPack(name: string): string {
  const dir = join(home, '.gbrain', 'schema-packs', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, `api_version: gbrain-schema-pack-v1
name: ${name}
version: 0.0.1
extends: gbrain-base
description: yaml unit test pack

takes_kinds:
  - fact
  - take

borrow_from: []

page_types:
  - name: seed-type
    primitive: entity
    path_prefixes:
      - seed/
    aliases: []
    extractable: false
    expert_routing: false

link_types: []
frontmatter_links: []
enrichable_types: []
filing_rules: []
`);
  return path;
}

describe('schema-pack mutate', () => {
  test('addTypeToPack appends a new type and re-validates', () => {
    seedJsonPack('test-pack');
    const result = addTypeToPack('test-pack', {
      name: 'recipe',
      primitive: 'media',
      prefix: 'cooking/recipes/',
      extractable: true,
      aliases: ['food'],
    });
    expect(result.type).toBe('recipe');
    expect(result.format).toBe('json');
    const manifest = loadPackFromFile(result.path);
    expect(manifest.page_types.map((t) => t.name)).toContain('recipe');
    const recipe = manifest.page_types.find((t) => t.name === 'recipe');
    expect(recipe?.primitive).toBe('media');
    expect(recipe?.path_prefixes).toEqual(['cooking/recipes/']);
    expect(recipe?.aliases).toEqual(['food']);
    expect(recipe?.extractable).toBe(true);
    expect(recipe?.expert_routing).toBe(false);
  });

  test('addTypeToPack rejects duplicate type name', () => {
    seedJsonPack('test-pack');
    expect(() => addTypeToPack('test-pack', {
      name: 'seed-type',
      primitive: 'entity',
      prefix: 'x/',
    })).toThrow(SchemaPackMutationError);
  });

  test('addTypeToPack rejects invalid primitive', () => {
    seedJsonPack('test-pack');
    expect(() => addTypeToPack('test-pack', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      name: 'bogus',
      primitive: 'not-a-primitive' as any,
      prefix: 'x/',
    })).toThrow(SchemaPackMutationError);
  });

  test('addTypeToPack rejects bundled packs', () => {
    expect(() => addTypeToPack('gbrain-base', {
      name: 'evil',
      primitive: 'entity',
      prefix: 'evil/',
    })).toThrow(/read-only/);
    expect(() => addTypeToPack('gbrain-recommended', {
      name: 'evil',
      primitive: 'entity',
      prefix: 'evil/',
    })).toThrow(/read-only/);
  });

  test('addTypeToPack errors when pack does not exist', () => {
    expect(() => addTypeToPack('ghost', {
      name: 'x',
      primitive: 'entity',
      prefix: 'x/',
    })).toThrow(/PACK_NOT_FOUND|No pack file/);
  });

  test('removeTypeFromPack removes the named type', () => {
    seedJsonPack('test-pack');
    addTypeToPack('test-pack', {
      name: 'recipe',
      primitive: 'media',
      prefix: 'cooking/recipes/',
    });
    const result = removeTypeFromPack('test-pack', { name: 'recipe' });
    expect(result.type).toBe('recipe');
    const manifest = loadPackFromFile(result.path);
    expect(manifest.page_types.map((t) => t.name)).not.toContain('recipe');
  });

  test('removeTypeFromPack rejects unknown type', () => {
    seedJsonPack('test-pack');
    expect(() => removeTypeFromPack('test-pack', { name: 'never-existed' }))
      .toThrow(SchemaPackMutationError);
  });

  test('YAML pack add → remove → add round-trips and revalidates', () => {
    const path = seedYamlPack('yaml-pack');
    addTypeToPack('yaml-pack', {
      name: 'podcast',
      primitive: 'media',
      prefix: 'media/podcasts/',
      aliases: ['audio', 'episode'],
    });
    // File on disk must still be valid YAML and parse through loader.
    const afterAdd = loadPackFromFile(path);
    expect(afterAdd.page_types.map((t) => t.name).sort()).toEqual(['podcast', 'seed-type']);
    expect(afterAdd.page_types.find((t) => t.name === 'podcast')?.aliases).toEqual(['audio', 'episode']);

    removeTypeFromPack('yaml-pack', { name: 'seed-type' });
    const afterRemove = loadPackFromFile(path);
    expect(afterRemove.page_types.map((t) => t.name)).toEqual(['podcast']);

    addTypeToPack('yaml-pack', {
      name: 'note',
      primitive: 'annotation',
      prefix: 'notes/',
      expertRouting: true,
    });
    const afterAdd2 = loadPackFromFile(path);
    expect(afterAdd2.page_types.find((t) => t.name === 'note')?.expert_routing).toBe(true);
  });

  test('addTypeToPack rejects malformed slugs', () => {
    seedJsonPack('test-pack');
    expect(() => addTypeToPack('test-pack', {
      name: '',
      primitive: 'entity',
      prefix: 'x/',
    })).toThrow(SchemaPackMutationError);
    expect(() => addTypeToPack('test-pack', {
      name: 'Spaces Bad',
      primitive: 'entity',
      prefix: 'x/',
    })).toThrow(SchemaPackMutationError);
  });

  test('addTypeToPack requires a prefix', () => {
    seedJsonPack('test-pack');
    expect(() => addTypeToPack('test-pack', {
      name: 'x',
      primitive: 'entity',
      prefix: '',
    })).toThrow(SchemaPackMutationError);
  });
});
