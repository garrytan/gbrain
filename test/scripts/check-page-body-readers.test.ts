/**
 * Wave B segmented storage (spec 1.5 layer 4): scripts/check-page-body-readers.ts
 * fails on a new whole-body page reader with no baseline row, on stale,
 * duplicate and malformed rows, and lets boundedBodyPrefixSql through by
 * name. The repo's own tree passes against the committed baseline.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { namesBodyColumn } from '../../scripts/check-page-body-readers.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-page-body-readers.ts');
const BASELINE = 'scripts/page-body-readers-baseline.tsv';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>, baseline: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-page-body-readers-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries({ [BASELINE]: ['# baseline', ...baseline, ''].join('\n'), ...files })) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function run(root: string, args: string[] = []) {
  const r = spawnSync('bun', [GUARD, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const flagged = (out: string) => [...out.matchAll(/new page body reader in (\S+) \((\S+)\)/g)].map((m) => `${m[1]} ${m[2]}`).sort();

describe('check-page-body-readers.ts: detection', () => {
  test('every reader form is flagged, keyed by unit and kind', () => {
    const root = tree({
      'src/core/readers.ts': [
        'export function field(p: { compiled_truth: string }) { return p.compiled_truth; }',
        'export function element(p: Record<string, string>) { return p["timeline"]; }',
        'export function destructure(p: { compiled_truth: string; timeline: string }) { const { timeline } = p; return timeline; }',
        'export function qualifiedColumn() { return "left(p.compiled_truth, 10)"; }',
        'export function bareColumn() { return "SELECT compiled_truth FROM pages WHERE id = $1"; }',
        'export function starFromPages() { return "SELECT p.* FROM pages p WHERE p.slug = $1"; }',
        'declare const engine: { putPage(...a: unknown[]): void };',
        'export function writer() { engine.putPage("a", {}); }',
        'declare function serializePageToMarkdown(...a: unknown[]): string;',
        'export class Engine { render() { return serializePageToMarkdown({}, []); } }',
        'if (import.meta.main) console.log("x".length, ({} as { timeline: string }).timeline);',
      ].join('\n'),
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(flagged(r.out)).toEqual([
      '<module> field', 'Engine.render call:serializePageToMarkdown', 'bareColumn sql', 'destructure field', 'element field', 'field field',
      'qualifiedColumn sql', 'starFromPages sql', 'writer call:putPage',
    ]);
  });

  test('quoted values, other tables, prose and generated files are not readers; boundedBodyPrefixSql is allowed by name', () => {
    expect(namesBodyColumn("SELECT id FROM content_chunks WHERE chunk_source = 'compiled_truth'")).toBe(false);
    expect(namesBodyColumn("SELECT * FROM timeline_entries WHERE page_id = $1")).toBe(false);
    expect(namesBodyColumn('compiled_truth')).toBe(false);
    expect(namesBodyColumn('the timeline of a page')).toBe(false);
    expect(namesBodyColumn('SELECT timeline FROM pages WHERE id = $1')).toBe(true);
    const root = tree({
      'src/core/lead.ts': [
        'export function boundedBodyPrefixSql(alias: string): string {',
        '  return `left(coalesce(${alias}.compiled_truth, ${alias}.truth_lead), 65536)`;',
        '}',
        "export const leadSql = `SELECT ${boundedBodyPrefixSql('p')} AS lead FROM pages p WHERE p.id = $1`;",
        "export const chunkSql = \"SELECT id FROM content_chunks WHERE chunk_source = 'timeline' AND page_id = $1\";",
      ].join('\n'),
      'src/core/schema.generated.ts': 'export const s = "SELECT compiled_truth FROM pages WHERE id = $1";',
    });
    const r = run(root);
    expect(r.out).toContain('check-page-body-readers: ok (0 baseline rows)');
    expect(r.code).toBe(0);
  });
});

describe('check-page-body-readers.ts: baseline rules', () => {
  const reader = { 'src/core/reader.ts': 'export function readBody(p: { compiled_truth: string }) { return p.compiled_truth; }\n' };

  test('a listed reader passes', () => {
    const r = run(tree(reader, ['src/core/reader.ts\treadBody\tfield\tINLINE\tinline by construction']));
    expect(r.out).toContain('check-page-body-readers: ok (1 baseline rows)');
    expect(r.code).toBe(0);
  });

  test('a new unlisted reader fails and names its file, line and unit', () => {
    const r = run(tree({ ...reader, 'src/core/new.ts': 'export function grow(p: { timeline: string }) {\n  return p.timeline;\n}\n' },
      ['src/core/reader.ts\treadBody\tfield\tINLINE\t']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/new.ts:2 new page body reader in grow (field)');
    expect(r.out).toContain('See:  docs/TESTING.md#page-body-readers');
  });

  test('a removed reader leaves a stale row that fails; --prune drops it and nothing else', () => {
    const root = tree(reader, ['src/core/reader.ts\treadBody\tfield\tINLINE\t', 'src/core/reader.ts\tgone\tcall:putPage\tSEGW\t']);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${BASELINE}:3 stale row: src/core/reader.ts gone call:putPage no longer reads the body`);
    expect(run(root, ['--prune']).code).toBe(0);
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe('# baseline\nsrc/core/reader.ts\treadBody\tfield\tINLINE\t\n');
    expect(run(root).code).toBe(0);
  });

  test('duplicate, malformed, unknown-action and note-less NONE rows fail', () => {
    const r = run(tree(reader, [
      'src/core/reader.ts\treadBody\tfield\tINLINE\t',
      'src/core/reader.ts\treadBody\tfield\tINLINE\t',
      'src/core/reader.ts\treadBody',
      'src/core/reader.ts\tother\tfield\tMAYBE\t',
      'src/core/reader.ts\tthird\tfield\tNONE\t',
    ]));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${BASELINE}:3 duplicate row`);
    expect(r.out).toContain(`${BASELINE}:4 malformed row`);
    expect(r.out).toContain("unknown action 'MAYBE'");
    expect(r.out).toContain('a NONE row needs a note');
  });

  test('the repository tree passes against the committed baseline', () => {
    const r = spawnSync('bun', [GUARD], { encoding: 'utf8', cwd: REPO, env: { ...process.env, GBRAIN_GUARD_ROOT: REPO } });
    expect(`${r.stdout}${r.stderr}`).toContain('check-page-body-readers: ok');
    expect(r.status).toBe(0);
  });
});
