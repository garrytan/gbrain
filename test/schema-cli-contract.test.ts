// v0.39 T6 — schema CLI contract, driven through runSchema.
//
// Every v0.39+ schema verb prints a `schema_version: 1` JSON envelope under
// --json; the experimental-tier verbs tag that envelope `tier:
// 'experimental'`; the engine-backed verbs honor --source, --source-id and
// their `=` forms. Each case runs the real dispatcher against a temporary
// GBRAIN_HOME with a file-backed PGLite brain.

import { describe, test, expect, spyOn, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSchema } from '../src/commands/schema.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-contract-'));
  const brain = join(home, '.gbrain');
  mkdirSync(brain, { recursive: true });
  const databasePath = join(brain, 'brain.pglite');
  writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.initSchema();
    for (const slug of ['projects/alpha', 'projects/beta', 'projects/gamma']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Fixture page.' });
    }
  } finally {
    await engine.disconnect();
  }
}, 60_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function runJson(args: string[]): Promise<{ json: Record<string, unknown>; exitCode: number | undefined }> {
  const lines: string[] = [];
  let exitCode: number | undefined;
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code; throw new Error('__exit__'); }) as never);
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => runSchema(args));
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    log.mockRestore(); err.mockRestore(); exit.mockRestore();
  }
  const out = lines.join('\n');
  expect(out.trimStart().startsWith('{'), `${args.join(' ')} printed non-JSON:\n${out}`).toBe(true);
  return { json: JSON.parse(out), exitCode };
}

describe('v0.39 T6 — schema CLI contract', () => {
  const cases: Array<{ args: string[]; experimental: boolean }> = [
    { args: ['detect'], experimental: false },
    { args: ['suggest'], experimental: false },
    { args: ['review-candidates'], experimental: false },
    { args: ['init', 'contract-pack'], experimental: true },
    { args: ['fork', 'gbrain-base', 'contract-fork'], experimental: true },
    { args: ['edit', 'contract-fork'], experimental: true },
    { args: ['diff', 'gbrain-base', 'contract-fork'], experimental: true },
    { args: ['graph'], experimental: true },
    { args: ['lint'], experimental: false },
    { args: ['explain', 'writing'], experimental: true },
    { args: ['review-orphans'], experimental: false },
    { args: ['downgrade', '--to', 'gbrain-base'], experimental: false },
    { args: ['usage'], experimental: false },
  ];

  test('every v0.39+ verb prints a schema_version 1 JSON envelope, tagged experimental exactly for the experimental tier', async () => {
    for (const { args, experimental } of cases) {
      const { json, exitCode } = await runJson([...args, '--json']);
      expect(exitCode ?? 0, args.join(' ')).toBe(0);
      expect(json.schema_version, args.join(' ')).toBe(1);
      expect(json.tier, args.join(' ')).toBe(experimental ? 'experimental' : undefined);
    }
  }, 60_000);

  test('engine-backed verbs scope to --source, --source-id and their = forms', async () => {
    expect((await runJson(['detect', '--json'])).json.total_pages).toBe(3);
    for (const flag of [['--source', 'contract-empty'], ['--source-id', 'contract-empty'], ['--source=contract-empty'], ['--source-id=contract-empty']]) {
      expect((await runJson(['detect', '--json', ...flag])).json.total_pages, flag.join(' ')).toBe(0);
    }
    for (const verb of ['suggest', 'review-candidates', 'review-orphans']) {
      expect((await runJson([verb, '--json', '--source-id', 'contract-empty'])).json.source_id, verb).toBe('contract-empty');
    }
  }, 60_000);

  test('schema usage reports and tags exactly the D14 experimental verbs', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-schema-usage-'));
    try {
      const ts = new Date().toISOString();
      writeFileSync(join(auditDir, 'schema-events-fixture.jsonl'), ['init', 'explain', 'lint', 'detect']
        .map(verb => JSON.stringify({ ts, verb, outcome: 'success' })).join('\n') + '\n');
      const lines: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
          await runSchema(['usage', '--json']);
          const json = JSON.parse(lines.join('\n'));
          expect([...json.experimental_verbs].sort()).toEqual(['diff', 'edit', 'explain', 'fork', 'graph', 'init']);
          lines.length = 0;
          await runSchema(['usage']);
        });
      } finally {
        spy.mockRestore();
      }
      const row = (verb: string) => lines.find(l => l.trim().startsWith(verb + ' ')) ?? '';
      expect(row('init')).toContain('(experimental)');
      expect(row('explain')).toContain('(experimental)');
      expect(row('lint')).not.toContain('(experimental)');
      expect(row('detect')).not.toContain('(experimental)');
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
