// #6432 — schema pack mutations must not rewrite quoted YAML scalars.
// The emitter (mutate.ts) and the mini YAML parser (loader.ts) have to
// round-trip: a string loaded from a pack, written back by a mutation and
// loaded again must be byte-identical, however many mutations run.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAliasToType, removeAliasFromType } from '../src/core/schema-pack/mutate.ts';
import { loadPackFromFile, parseYamlMini } from '../src/core/schema-pack/loader.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let tmpDir: string;
let auditDir: string;
let lockDir: string;

const REGEX = String.raw`\b(works? at|employed by)\b`;
// Every character the emitter quotes for, plus the escape characters of
// both YAML quote styles.
const TRICKY = String.raw`back\slash "dq" it's a|b #hash \"esc\" ''two'' end\\`;

function packYaml(name: string, regexLine: string, descriptionLine: string): string {
  return `api_version: gbrain-schema-pack-v1
name: ${name}
version: 1.0.0
description: ${descriptionLine}
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
  - name: company
    primitive: entity
    path_prefixes:
      - companies/
    aliases: []
    extractable: false
    expert_routing: false
link_types:
  - name: works_at
    inverse: employs
    inference:
      page_type: person
      target_type: company
      regex: ${regexLine}
frontmatter_links: []
takes_kinds:
  - fact
enrichable_types: []
filing_rules: []
`;
}

function seedYaml(name: string, body: string): string {
  const dir = join(tmpDir, '.gbrain', 'schema-packs', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, body, 'utf-8');
  return path;
}

function regexOf(path: string, linkName: string): string | undefined {
  const pack = loadPackFromFile(path);
  return pack.link_types.find((l) => l.name === linkName)?.inference?.regex;
}

beforeEach(() => {
  _resetPackCacheForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-6432-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-6432-audit-'));
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-6432-locks-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  for (const d of [tmpDir, auditDir, lockDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('#6432 quoted scalars survive pack mutations', () => {
  for (const [label, regexLine] of [
    ['bare', REGEX],
    ['single-quoted', `'${REGEX}'`],
  ] as const) {
    it(`three add-alias mutations keep a ${label} regex value unchanged`, async () => {
      await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const path = seedYaml('mine', packYaml('mine', regexLine, '""'));
        expect(regexOf(path, 'works_at')).toBe(REGEX);
        const sizes: number[] = [];
        for (let n = 1; n <= 3; n++) {
          await addAliasToType('mine', 'person', `probe-${n}`, { lockDir });
          _resetPackCacheForTests();
          expect(regexOf(path, 'works_at')).toBe(REGEX);
          sizes.push(readFileSync(path, 'utf-8').length);
        }
        // Each mutation adds one fixed-length alias line; nothing else grows.
        expect(sizes[2] - sizes[1]).toBe(sizes[1] - sizes[0]);
      });
    });
  }

  it('emit, parse, emit is a fixed point for strings with \\ " \' | #', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Seed as a single-quoted YAML scalar ('' is the only escape there).
      const seedDescription = `'${TRICKY.replace(/'/g, "''")}'`;
      const path = seedYaml('mine', packYaml('mine', `'${REGEX}'`, seedDescription));
      expect(loadPackFromFile(path).description).toBe(TRICKY);

      await addAliasToType('mine', 'person', 'probe-a', { lockDir });
      _resetPackCacheForTests();
      const first = readFileSync(path, 'utf-8');
      expect(loadPackFromFile(path).description).toBe(TRICKY);
      expect(regexOf(path, 'works_at')).toBe(REGEX);

      await addAliasToType('mine', 'person', 'probe-b', { lockDir });
      _resetPackCacheForTests();
      await removeAliasFromType('mine', 'person', 'probe-b', { lockDir });
      _resetPackCacheForTests();
      expect(readFileSync(path, 'utf-8')).toBe(first);
      expect(loadPackFromFile(path).description).toBe(TRICKY);
    });
  });

  it('the bundled company-brain single-quoted regexes survive a mutation', async () => {
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // A YAML pack that copies these lines verbatim is the affected path
      // (`schema fork` writes JSON). Reuse the exact authored bytes.
      const bundled = join(import.meta.dir, '..', 'src', 'core', 'schema-pack', 'base', 'company-brain.yaml');
      const regexLines = [...readFileSync(bundled, 'utf-8').matchAll(/^\s+regex: ('.*')$/gm)].map((m) => m[1]);
      const expected = loadPackFromFile(bundled).link_types
        .map((l) => l.inference?.regex)
        .filter((r): r is string => typeof r === 'string');
      expect(regexLines.length).toBeGreaterThan(0);
      expect(regexLines.length).toBe(expected.length);
      for (const [idx, line] of regexLines.entries()) {
        const name = `cb-${idx}`;
        const path = seedYaml(name, packYaml(name, line, '""'));
        expect(regexOf(path, 'works_at')).toBe(expected[idx]);
        expect(expected[idx]).toContain('\\b');
        await addAliasToType(name, 'person', 'probe-alias', { lockDir });
        _resetPackCacheForTests();
        expect(regexOf(path, 'works_at')).toBe(expected[idx]);
      }
    });
  });
});

describe('#6432 parseYamlMini quoted scalars', () => {
  it("single-quoted scalars unescape '' to '", () => {
    const parsed = parseYamlMini(`a: 'it''s'\nb: ''''\nc: 'x''#y'\n`) as Record<string, unknown>;
    expect(parsed).toEqual({ a: "it's", b: "'", c: "x'#y" });
  });

  it('an escaped double quote does not end the string for comment stripping', () => {
    const parsed = parseYamlMini(`a: "5\\" # not a comment" # a comment\n`) as Record<string, unknown>;
    // Whether double-quoted escapes are decoded is not pinned here; only that
    // the escaped quote did not close the string and drop the rest.
    expect([String.raw`5\" # not a comment`, '5" # not a comment']).toContain(parsed.a as string);
  });

  it('a # inside a single-quoted scalar after an escaped quote is kept', () => {
    const parsed = parseYamlMini(`a: 'it''s # kept' # dropped\n`) as Record<string, unknown>;
    expect(parsed.a).toBe("it's # kept");
  });
});
