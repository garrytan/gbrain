// v0.40.6.0 — mutate.ts contract tests for the 11 primitives + withMutation skeleton.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addAliasToType,
  addLinkTypeToPack,
  addPrefixToType,
  addTypeToPack,
  BUNDLED_PACK_NAMES,
  locateMutablePackFile,
  removeAliasFromType,
  removeLinkTypeFromPack,
  removePrefixFromType,
  removeTypeFromPack,
  SchemaPackMutationError,
  setExpertRoutingOnType,
  setExtractableOnType,
  updateTypeOnPack,
} from '../src/core/schema-pack/mutate.ts';
import { loadPackFromFile, parseYamlMini } from '../src/core/schema-pack/loader.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';

let tmpDir: string;
let auditDir: string;
let lockDir: string;

function seedPack(packName: string, format: 'json' | 'yaml', initial?: Partial<SchemaPackManifest>): string {
  // GBRAIN_HOME=/tmp/x → gbrainPath('schema-packs', 'mine') = /tmp/x/.gbrain/schema-packs/mine
  const dir = join(tmpDir, '.gbrain', 'schema-packs', packName);
  mkdirSync(dir, { recursive: true });
  const manifest: SchemaPackManifest = {
    api_version: 'gbrain-schema-pack-v1',
    name: packName,
    version: '1.0.0',
    description: '',
    gbrain_min_version: '0.38.0',
    extends: null,
    borrow_from: [],
    page_types: [{
      name: 'person', primitive: 'entity', path_prefixes: ['people/'],
      aliases: [], extractable: false, expert_routing: false,
    }],
    link_types: [],
    frontmatter_links: [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: [],
    filing_rules: [],
    ...initial,
  } as SchemaPackManifest;
  const file = format === 'json' ? 'pack.json' : 'pack.yaml';
  const path = join(dir, file);
  const body = format === 'json'
    ? JSON.stringify(manifest, null, 2) + '\n'
    : require('../src/core/schema-pack/mutate.ts').emitYaml?.(manifest) ?? buildSimpleYaml(manifest);
  writeFileSync(path, body, 'utf-8');
  return path;
}

// Tiny YAML fallback for fixtures (the real emitter is inside mutate.ts).
function buildSimpleYaml(m: SchemaPackManifest): string {
  return JSON.stringify(m);  // valid YAML (JSON is a subset)
}

beforeEach(() => {
  _resetPackCacheForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-mutate-test-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-mutate-audit-'));
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-mutate-locks-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  for (const d of [tmpDir, auditDir, lockDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

// ─── BUNDLED-pack guard (D6) ─────────────────────────────────────────────

describe('locateMutablePackFile — bundled guard', () => {
  it('rejects gbrain-base with PACK_READONLY + fork hint', () => {
    expect(() => locateMutablePackFile('gbrain-base')).toThrow(SchemaPackMutationError);
    try { locateMutablePackFile('gbrain-base'); } catch (e) {
      const err = e as SchemaPackMutationError;
      expect(err.code).toBe('PACK_READONLY');
      expect(err.message).toContain('gbrain schema fork');
    }
  });

  it('rejects gbrain-recommended with PACK_READONLY', () => {
    try { locateMutablePackFile('gbrain-recommended'); } catch (e) {
      expect((e as SchemaPackMutationError).code).toBe('PACK_READONLY');
    }
  });

  it('BUNDLED_PACK_NAMES export contains all bundled packs', () => {
    expect(BUNDLED_PACK_NAMES.has('gbrain-base')).toBe(true);
    expect(BUNDLED_PACK_NAMES.has('gbrain-recommended')).toBe(true);
    // v0.42 (T22): gbrain-base-v2 joins the bundled set.
    expect(BUNDLED_PACK_NAMES.has('gbrain-base-v2')).toBe(true);
    expect(BUNDLED_PACK_NAMES.size).toBe(3);
  });

  it('rejects gbrain-base-v2 with PACK_READONLY (bundled guard)', () => {
    try { locateMutablePackFile('gbrain-base-v2'); } catch (e) {
      expect((e as SchemaPackMutationError).code).toBe('PACK_READONLY');
    }
  });
});

// ─── add_type ───────────────────────────────────────────────────────────

describe('addTypeToPack', () => {
  it('appends a new type to JSON pack and writes atomically', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      const result = await addTypeToPack('mine', {
        name: 'researcher', primitive: 'entity', prefix: 'people/researchers/',
        extractable: true, expert: false,
      } as never, { lockDir });
      expect(result.format).toBe('json');
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'researcher')).toBeDefined();
      expect(result.prev_sha8).not.toBe(result.new_sha8);
    });
  });

  it('rejects when type already exists', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(addTypeToPack('mine', {
        name: 'person', primitive: 'entity', prefix: 'people/',
      } as never, { lockDir })).rejects.toThrow('already exists');
    });
  });

  it('rejects invalid primitive', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(addTypeToPack('mine', {
        name: 'bad', primitive: 'invalid_primitive' as never, prefix: 'x/',
      } as never, { lockDir })).rejects.toMatchObject({ code: 'INVALID_PRIMITIVE' });
    });
  });

  it('rejects missing prefix', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(addTypeToPack('mine', {
        name: 'bad', primitive: 'entity', prefix: '',
      } as never, { lockDir })).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    });
  });

  it('rejects invalid slug type name', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(addTypeToPack('mine', {
        name: 'has spaces', primitive: 'entity', prefix: 'x/',
      } as never, { lockDir })).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    });
  });
});

// ─── remove_type with codex C14 alias-ref check ─────────────────────────

describe('removeTypeFromPack', () => {
  it('removes the type when no references exist', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json', {
        page_types: [
          { name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: [], extractable: false, expert_routing: false },
          { name: 'company', primitive: 'entity', path_prefixes: ['companies/'], aliases: [], extractable: false, expert_routing: false },
        ],
      });
      await removeTypeFromPack('mine', 'company', { lockDir });
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'company')).toBeUndefined();
    });
  });

  it('TYPE_NOT_FOUND when type does not exist', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(removeTypeFromPack('mine', 'ghost', { lockDir }))
        .rejects.toMatchObject({ code: 'TYPE_NOT_FOUND' });
    });
  });

  it('CODEX C14: refuses removal when another type aliases the target', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json', {
        page_types: [
          { name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: [], extractable: false, expert_routing: false },
          { name: 'researcher', primitive: 'entity', path_prefixes: ['people/r/'], aliases: ['person'], extractable: false, expert_routing: false },
        ],
      });
      await expect(removeTypeFromPack('mine', 'person', { lockDir }))
        .rejects.toMatchObject({ code: 'STILL_REFERENCED' });
    });
  });

  it('CODEX C14: refuses removal when link_type inference references the target', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json', {
        page_types: [
          { name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: [], extractable: false, expert_routing: false },
          { name: 'company', primitive: 'entity', path_prefixes: ['c/'], aliases: [], extractable: false, expert_routing: false },
        ],
        link_types: [
          { name: 'works_at', inference: { page_type: 'person', target_type: 'company' } },
        ],
      });
      await expect(removeTypeFromPack('mine', 'person', { lockDir }))
        .rejects.toMatchObject({ code: 'STILL_REFERENCED' });
    });
  });

  it('CODEX C14: refuses when enrichable_types references the target', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json', {
        page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['p/'], aliases: [], extractable: false, expert_routing: false }],
        enrichable_types: [{ type: 'person', rubric: 'r' }],
      });
      await expect(removeTypeFromPack('mine', 'person', { lockDir }))
        .rejects.toMatchObject({ code: 'STILL_REFERENCED' });
    });
  });
});

// ─── update_type ───────────────────────────────────────────────────────

describe('updateTypeOnPack', () => {
  it('patches a single field while leaving others untouched', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      await updateTypeOnPack('mine', { name: 'person', patch: { extractable: true } }, { lockDir });
      const after = loadPackFromFile(path);
      const t = after.page_types.find((pt) => pt.name === 'person')!;
      expect(t.extractable).toBe(true);
      expect(t.primitive).toBe('entity');
      expect(t.path_prefixes).toEqual(['people/']);
    });
  });

  it('name field on patch is ignored (name is identity)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      await updateTypeOnPack('mine', { name: 'person', patch: { name: 'renamed', extractable: true } as never }, { lockDir });
      const after = loadPackFromFile(path);
      // 'person' kept its name; not renamed.
      expect(after.page_types.find((t) => t.name === 'person')).toBeDefined();
      expect(after.page_types.find((t) => t.name === 'renamed')).toBeUndefined();
    });
  });

  it('TYPE_NOT_FOUND on patch target missing', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(updateTypeOnPack('mine', { name: 'ghost', patch: { extractable: true } }, { lockDir }))
        .rejects.toMatchObject({ code: 'TYPE_NOT_FOUND' });
    });
  });
});

// ─── alias + prefix primitives ─────────────────────────────────────────

describe('addAliasToType', () => {
  it('appends a new alias (alias does NOT shadow another declared type)', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      // Alias 'individual' is NOT another declared type, so alias_shadows_type does not fire.
      // alias_references_undeclared_type is a WARNING (not error), so validation gate passes.
      await addAliasToType('mine', 'person', 'individual', { lockDir });
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'person')!.aliases).toEqual(['individual']);
    });
  });

  it('idempotent on existing alias', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json', {
        page_types: [
          { name: 'person', primitive: 'entity', path_prefixes: ['p/'], aliases: ['individual'], extractable: false, expert_routing: false },
        ],
      });
      const r1 = await addAliasToType('mine', 'person', 'individual', { lockDir });
      const r2 = await addAliasToType('mine', 'person', 'individual', { lockDir });
      expect(r1.new_sha8).toBe(r2.new_sha8);
    });
  });
});

describe('removeAliasFromType', () => {
  it('removes an existing alias', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json', {
        page_types: [
          { name: 'person', primitive: 'entity', path_prefixes: ['p/'], aliases: ['individual'], extractable: false, expert_routing: false },
        ],
      });
      await removeAliasFromType('mine', 'person', 'individual', { lockDir });
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'person')!.aliases).toEqual([]);
    });
  });

  it('idempotent on missing alias', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      const r1 = await removeAliasFromType('mine', 'person', 'never-was', { lockDir });
      const r2 = await removeAliasFromType('mine', 'person', 'never-was', { lockDir });
      expect(r1.new_sha8).toBe(r2.new_sha8);
    });
  });
});

describe('addPrefixToType / removePrefixFromType', () => {
  it('addPrefix appends', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      await addPrefixToType('mine', 'person', 'people-archive/', { lockDir });
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'person')!.path_prefixes).toEqual(['people/', 'people-archive/']);
    });
  });

  it('addPrefix idempotent on existing', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      const r1 = await addPrefixToType('mine', 'person', 'people/', { lockDir });
      const r2 = await addPrefixToType('mine', 'person', 'people/', { lockDir });
      expect(r1.new_sha8).toBe(r2.new_sha8);
    });
  });

  it('removePrefix removes', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json', {
        page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/', 'people-archive/'], aliases: [], extractable: false, expert_routing: false }],
      });
      await removePrefixFromType('mine', 'person', 'people-archive/', { lockDir });
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'person')!.path_prefixes).toEqual(['people/']);
    });
  });
});

// ─── link_type primitives ───────────────────────────────────────────────

describe('addLinkTypeToPack / removeLinkTypeFromPack', () => {
  it('addLinkType creates a new link verb', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json', {
        page_types: [
          { name: 'person', primitive: 'entity', path_prefixes: ['p/'], aliases: [], extractable: false, expert_routing: false },
          { name: 'company', primitive: 'entity', path_prefixes: ['c/'], aliases: [], extractable: false, expert_routing: false },
        ],
      });
      await addLinkTypeToPack('mine', {
        name: 'works_at',
        inference: { page_type: 'person', target_type: 'company' },
      }, { lockDir });
      const after = loadPackFromFile(path);
      expect(after.link_types.length).toBe(1);
      expect(after.link_types[0]!.name).toBe('works_at');
    });
  });

  it('addLinkType rejects duplicate name', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json', {
        link_types: [{ name: 'attended' }],
      });
      await expect(addLinkTypeToPack('mine', { name: 'attended' }, { lockDir }))
        .rejects.toMatchObject({ code: 'TYPE_EXISTS' });
    });
  });

  it('removeLinkType removes when no fm refs exist', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json', { link_types: [{ name: 'attended' }] });
      await removeLinkTypeFromPack('mine', 'attended', { lockDir });
      const after = loadPackFromFile(path);
      expect(after.link_types.length).toBe(0);
    });
  });

  it('removeLinkType refuses when frontmatter_links references it', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json', {
        page_types: [{ name: 'meeting', primitive: 'temporal', path_prefixes: ['m/'], aliases: [], extractable: false, expert_routing: false }],
        link_types: [{ name: 'attended' }],
        frontmatter_links: [{ page_type: 'meeting', fields: ['attendees'], link_type: 'attended' }],
      });
      await expect(removeLinkTypeFromPack('mine', 'attended', { lockDir }))
        .rejects.toMatchObject({ code: 'STILL_REFERENCED' });
    });
  });
});

// ─── flag setters ──────────────────────────────────────────────────────

describe('setExtractableOnType / setExpertRoutingOnType', () => {
  it('setExtractable flips the flag', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      await setExtractableOnType('mine', 'person', true, { lockDir });
      expect(loadPackFromFile(path).page_types[0]!.extractable).toBe(true);
      await setExtractableOnType('mine', 'person', false, { lockDir });
      expect(loadPackFromFile(path).page_types[0]!.extractable).toBe(false);
    });
  });

  it('setExpertRouting flips the flag', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      await setExpertRoutingOnType('mine', 'person', true, { lockDir });
      expect(loadPackFromFile(path).page_types[0]!.expert_routing).toBe(true);
    });
  });

  it('TYPE_NOT_FOUND on missing type', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      await expect(setExtractableOnType('mine', 'ghost', true, { lockDir }))
        .rejects.toMatchObject({ code: 'TYPE_NOT_FOUND' });
    });
  });
});

// ─── YAML round-trip ──────────────────────────────────────────────────

describe('YAML round-trip', () => {
  it('mutating a YAML pack preserves YAML format and reparses cleanly', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const dir = join(tmpDir, '.gbrain', 'schema-packs', 'yaml-pack');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'pack.yaml');
      // Seed valid YAML (use the manifest validator round-trip).
      // Seed actual block-style YAML (parseYamlMini is hand-rolled and prefers
      // block-style; flow-style JSON-in-YAML isn't fully supported).
      const yamlBody = `api_version: gbrain-schema-pack-v1
name: yaml-pack
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases: []
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`;
      writeFileSync(path, yamlBody, 'utf-8');

      const result = await addTypeToPack('yaml-pack', {
        name: 'researcher', primitive: 'entity', prefix: 'people/r/',
      } as never, { lockDir });
      expect(result.format).toBe('yaml');
      // File still parses as YAML AND as a valid manifest.
      const reparsed = parseYamlMini(readFileSync(path, 'utf-8'));
      expect(reparsed).toBeDefined();
      const after = loadPackFromFile(path);
      expect(after.page_types.find((t) => t.name === 'researcher')).toBeDefined();
    });
  });
});

// ─── atomicity ────────────────────────────────────────────────────────

describe('atomicity invariants', () => {
  it('crash-mid-write does not leave the pack file in a partial state', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = seedPack('mine', 'json');
      const before = readFileSync(path, 'utf-8');
      try {
        // Force a mutator throw mid-pipeline AFTER lock acquire + read.
        await addTypeToPack('mine', {
          // Invalid: primitive is wrong type. Validation should fail BEFORE write.
          name: 'researcher', primitive: 'nope' as never, prefix: 'x/',
        } as never, { lockDir });
      } catch { /* expected */ }
      // Original file untouched.
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });
  });

  it('lock is released after a mutator throws', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      try {
        await addTypeToPack('mine', {
          name: 'has spaces', primitive: 'entity', prefix: 'x/',
        } as never, { lockDir });
      } catch { /* expected */ }
      // A second call should succeed (lock not held).
      const result = await addTypeToPack('mine', {
        name: 'valid', primitive: 'entity', prefix: 'v/',
      } as never, { lockDir });
      expect(result.pack).toBe('mine');
    });
  });
});

// ─── validation gate ─────────────────────────────────────────────────

describe('validation gate (file-plane lint integration)', () => {
  it('refuses mutation that would create prefix collision', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      seedPack('mine', 'json');
      // Adding a second type with the SAME prefix → prefix_collision (error).
      await expect(addTypeToPack('mine', {
        name: 'human', primitive: 'entity', prefix: 'people/',  // same as person
      } as never, { lockDir })).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    });
  });
});
