/**
 * #5988 prevention: every gbrain frontmatter writer serializes caller strings
 * through a YAML-safe scalar, so a hostile value (`: `, `#`, `[x]`, quotes,
 * newlines, `---`, YAML keywords) strict-parses back to exactly the string it
 * was given. A strict parse (js-yaml with gbrain's FRONTMATTER_SCHEMA, no
 * pre-quoting, no recovery) is the bar: what an external YAML reader sees.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { FRONTMATTER_SCHEMA } from '../src/core/data-frontmatter.ts';
import { serializeFrontmatter, yamlScalar } from '../src/core/frontmatter-inference.ts';
import { skillMdTemplate } from '../src/core/skillify/templates.ts';
import { stubEntityPage } from '../src/core/facts/fence-write.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { runSchema } from '../src/commands/schema.ts';
import { withEnv } from './helpers/with-env.ts';

const HOSTILE = [
  'a: b', 'ends with colon:', '#1 thing', 'tag #inline', '[x]', '{y: z}', '"quoted" trailing', "it's", 'say "hi"',
  'line one\nline two', '---', 'a\n---\nb', '- item', 'yes', 'null', '2026', ' leading space', 'trailing space ',
  '@handle', '`tick`', '| pipe', '> folded', '*alias', '&anchor', '!tag', '%directive', 'back\\slash', 'tab\there', 'emoji ✓',
];

/** The YAML block between the opening and closing fences, strictly parsed. */
function strictFrontmatter(doc: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(doc);
  if (!m) throw new Error(`no frontmatter block in:\n${doc}`);
  return load(m[1]!, { schema: FRONTMATTER_SCHEMA }) as Record<string, unknown>;
}

describe('frontmatter writers round-trip hostile strings under a strict YAML parse', () => {
  const writers: Array<{ name: string; write: (value: string) => string; read: (fm: Record<string, unknown>) => unknown[]; expect: (value: string) => unknown[] }> = [
    { name: 'yamlScalar', write: v => `---\nvalue: ${yamlScalar(v)}\n---\n`, read: fm => [fm.value], expect: v => [v] },
    { name: 'serializeFrontmatter (frontmatter generate)', write: v => serializeFrontmatter({ title: v, type: 'note' }),
      read: fm => [fm.title], expect: v => [v] },
    { name: 'skillMdTemplate (skillify scaffold)', write: v => skillMdTemplate({ name: v, description: v, triggers: [v], writesTo: [v], writesPages: true, mutating: false }),
      read: fm => [fm.name, fm.description, (fm.triggers as unknown[])[0], (fm.writes_to as unknown[])[0]], expect: v => [v, v, v, v] },
    { name: 'stubEntityPage (facts fence stub)', write: v => stubEntityPage(`concepts/${v}`, null),
      read: fm => [fm.slug, typeof fm.title], expect: v => [`concepts/${v}`, 'string'] },
    { name: 'serializeMarkdown (put_page write-through)', write: v => serializeMarkdown({ summary: v }, 'body', '', { type: 'note', title: v, tags: [v] }),
      read: fm => [fm.title, fm.summary, (fm.tags as unknown[])[0]], expect: v => [v, v, v] },
  ];

  for (const writer of writers) {
    test(writer.name, () => {
      for (const value of HOSTILE) {
        const doc = writer.write(value);
        let fm: Record<string, unknown>;
        try {
          fm = strictFrontmatter(doc);
        } catch (error) {
          throw new Error(`${writer.name} wrote unparseable YAML for ${JSON.stringify(value)}: ${(error as Error).message}\n${doc}`);
        }
        expect({ value, got: writer.read(fm) }).toEqual({ value, got: writer.expect(value) });
      }
    });
  }
});

describe('schema init pack.yaml', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fm-writers-schema-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test('a hostile pack name strict-parses back to itself', async () => {
    const logOrig = console.log;
    console.log = () => {};
    try {
      for (const name of ['a: b #c', '[x]', '"q" tail', '---', 'yes']) {
        await withEnv({ GBRAIN_HOME: home }, () => runSchema(['init', name, '--json']));
        const yaml = readFileSync(join(home, '.gbrain', 'schema-packs', name, 'pack.yaml'), 'utf8');
        expect((load(yaml, { schema: FRONTMATTER_SCHEMA }) as { name: unknown }).name).toBe(name);
      }
    } finally {
      console.log = logOrig;
    }
  });
});
