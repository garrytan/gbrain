/**
 * Refactor wave 1 porting kit (W6 / W7, E2 + O11): scripts/generate-wave-1-moves.ts.
 *
 * Protects: the committed moved-symbol map is usable by an open pull request.
 * Every `new` and `facade` entry in docs/architecture/wave-1-moves.json names
 * a symbol that exists in the tree today, and docs/architecture/wave-1-porting.md
 * is exactly what the generator renders from that JSON (never hand-edited).
 * The generator's classification (move, split, façade delegation, file
 * rename, unchanged, unmapped) is driven on a synthetic base/head pair.
 * Fails when: a later commit renames or deletes a mapped destination without
 * rerunning the generator, the markdown drifts from the JSON, or the matcher
 * stops finding a moved or split body.
 * Seam: computeMoves / renderMarkdown are pure; the map test reads the tree.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  JSON_PATH,
  MARKDOWN_PATH,
  computeMoves,
  renderMarkdown,
  symbolNames,
  type MovesDoc,
} from '../../scripts/generate-wave-1-moves.ts';

const ROOT = join(import.meta.dir, '..', '..');
const doc: MovesDoc = JSON.parse(readFileSync(join(ROOT, JSON_PATH), 'utf-8'));

function splitRef(ref: string): { path: string; name: string } {
  const i = ref.lastIndexOf(':');
  return { path: ref.slice(0, i), name: ref.slice(i + 1) };
}

describe('committed wave-1 moved-symbol map', () => {
  test('every new and facade entry resolves to an existing symbol', () => {
    expect(doc.moves.length).toBeGreaterThan(0);
    const cache = new Map<string, Set<string>>();
    const missing: string[] = [];
    for (const move of doc.moves) {
      expect(move.new.length).toBeGreaterThan(0);
      for (const ref of [...move.new, ...(move.facade ? [move.facade] : [])]) {
        const { path, name } = splitRef(ref);
        const file = join(ROOT, path);
        if (!existsSync(file)) {
          missing.push(`${move.old} -> ${ref} (file missing)`);
          continue;
        }
        if (!cache.has(path)) {
          // test-reads-source-ok[structural]: resolves each porting-map destination against the tree
          cache.set(path, symbolNames({ path, text: readFileSync(file, 'utf-8') }));
        }
        if (!cache.get(path)!.has(name)) missing.push(`${move.old} -> ${ref} (symbol missing)`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `FAIL: ${JSON_PATH} names ${missing.length} symbol(s) that no longer exist:\n  ${missing.slice(0, 20).join('\n  ')}\n` +
        'Why:  the porting map must point open pull requests at code that exists.\n' +
        'Fix:  bun scripts/generate-wave-1-moves.ts   (commit both regenerated files)\n' +
        'See:  docs/architecture/wave-1-porting.md',
      );
    }
  });

  test('the markdown is the rendering of the JSON', () => {
    const committed = readFileSync(join(ROOT, MARKDOWN_PATH), 'utf-8');
    if (committed !== renderMarkdown(doc)) {
      throw new Error(
        `FAIL: ${MARKDOWN_PATH} differs from what the generator renders from ${JSON_PATH}.\n` +
        'Why:  the porting guide is generated; a hand edit drifts from the map.\n' +
        'Fix:  edit the JSON landing block if needed, then: bun scripts/generate-wave-1-moves.ts --render\n' +
        'See:  scripts/generate-wave-1-moves.ts',
      );
    }
  });

  test('landing placeholders and every conflict recipe are present', () => {
    const md = renderMarkdown(doc);
    for (const heading of [
      '### Engine fix (a storage method)', '### Schema migration', '### Doctor check', '### CLI flag or command',
      '### serve-http route', '### Sync closure', '### Jobs handler', '### Hybrid search stage',
      '### Generated-file conflicts: regenerate, never hand-merge', '## Say to your agent', '## Landing window',
    ]) expect(md).toContain(heading);
    for (const generated of [
      'registry.generated.ts', 'schema-embedded.generated.ts', 'pglite-schema.generated.ts', 'cli-flag-registry.generated.ts',
    ]) expect(md).toContain(generated);
    expect(md).toContain(doc.landing.integrationOwner);
  });
});

describe('computeMoves classification', () => {
  const big = (label: string) => `  const ${label}Rows = await engine.executeRaw(\`SELECT id, slug, title, compiled_truth FROM pages WHERE source_id = $1 AND slug LIKE '${label}/%' ORDER BY slug\`, [sourceId]);\n  for (const row of ${label}Rows) { total += row.compiled_truth.length + row.title.length; seen.add(row.slug); }\n`;

  const base = [
    {
      path: 'src/a.ts',
      text: `export function stays(x: number) { return x + 1; }\n`
        + `export async function moved(engine: any, sourceId: string) { let total = 0; const seen = new Set(); \n${big('moved')} return total; }\n`
        + `export async function god(engine: any, sourceId: string) { let total = 0; const seen = new Set();\n${big('alpha')}${big('beta')} return total; }\n`
        + `function gone() { return 42; }\n`,
    },
    { path: 'src/old-dir/mod.ts', text: `export function renamedWith(y: string) { return y.trim(); }\n` },
    {
      path: 'src/engine.ts',
      text: `export class E {\n  async getThing(sourceId: string) { let total = 0; const seen = new Set(); const engine: any = this;\n${big('thing')} return total; }\n}\n`,
    },
  ];
  const head = [
    {
      path: 'src/a.ts',
      text: `export function stays(x: number) { return x + 1; }\n`
        + `export { moved } from './b.ts';\n`
        + `import { alphaPhase, betaPhase } from './phases.ts';\n`
        + `export async function god(engine: any, sourceId: string) { return (await alphaPhase(engine, sourceId)) + (await betaPhase(engine, sourceId)); }\n`,
    },
    { path: 'src/b.ts', text: `export async function moved(engine: any, sourceId: string) { let total = 0; const seen = new Set(); \n${big('moved')} return total; }\n` },
    {
      path: 'src/phases.ts',
      text: `export async function alphaPhase(engine: any, sourceId: string) { let total = 0; const seen = new Set();\n${big('alpha')} return total; }\n`
        + `export async function betaPhase(engine: any, sourceId: string) { let total = 0; const seen = new Set();\n${big('beta')} return total; }\n`,
    },
    { path: 'src/new-dir/mod.ts', text: `export function renamedWith(y: string) { return y.trim(); }\n` },
    {
      path: 'src/engine.ts',
      text: `import * as thingImpl from './engine-sql/thing.ts';\nexport class E {\n  async getThing(sourceId: string) { return thingImpl.getThing(this, sourceId); }\n}\n`,
    },
    { path: 'src/engine-sql/thing.ts', text: `export async function getThing(exec: any, sourceId: string) { let total = 0; const seen = new Set(); const engine = exec;\n${big('thing').replace('engine.executeRaw', 'engine.query')} return total; }\n` },
  ];
  const { moves, unmapped, removedModules } = computeMoves({ base, head, renames: { 'src/old-dir/mod.ts': 'src/new-dir/mod.ts' } });
  const byOld = new Map(moves.map((m) => [m.old, m]));

  test('a whole body found elsewhere is a move with the re-export as façade', () => {
    expect(byOld.get('src/a.ts:moved')).toEqual({
      old: 'src/a.ts:moved', kind: 'moved', facade: 'src/a.ts:moved', wasExported: true, new: ['src/b.ts:moved'],
    });
  });

  test('a body cut into phases is a split listing every phase', () => {
    expect(byOld.get('src/a.ts:god')).toEqual({
      old: 'src/a.ts:god', kind: 'split', facade: 'src/a.ts:god', wasExported: true,
      new: ['src/phases.ts:alphaPhase', 'src/phases.ts:betaPhase'],
    });
  });

  test('an engine method that now delegates maps to the same-named implementation', () => {
    const m = byOld.get('src/engine.ts:E.getThing')!;
    expect(m.facade).toBe('src/engine.ts:E.getThing');
    expect(m.new).toEqual(['src/engine-sql/thing.ts:getThing']);
  });

  test('a renamed file moves its symbols; unchanged symbols are omitted; lost symbols are unmapped', () => {
    expect(byOld.get('src/old-dir/mod.ts:renamedWith')?.new).toEqual(['src/new-dir/mod.ts:renamedWith']);
    expect(byOld.has('src/a.ts:stays')).toBe(false);
    expect(unmapped).toEqual(['src/a.ts:gone']);
    expect(removedModules).toEqual(['src/old-dir/mod.ts']);
  });
});
