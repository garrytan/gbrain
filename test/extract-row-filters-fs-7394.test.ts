/**
 * #7394: `gbrain extract <links|timeline|all> --type T` (and `--since`, `--infer-dates`) on the file walk.
 *
 * 1. Protects: the default `--source fs` walk reads files, not page rows, so it cannot apply a page-row filter; it refuses
 *    with exit 2 and the paste-ready `--source db` command instead of walking every file and reporting it as a
 *    filtered pass. On `--source db` the filter applies: a type no page has processes no page.
 * 2. Fails when: a row filter on the file walk is silently dropped again, or the db path stops honoring `--type`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { setCliOptions } from '../src/core/cli-options.ts';

let engine: PGLiteEngine;
let dir: string;

async function runCli(args: string[]): Promise<{ exit: number | null; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  let exit: number | null = null;
  const orig = { log: console.log, error: console.error, exit: process.exit, write: process.stdout.write };
  console.log = (m?: unknown) => { out.push(String(m)); };
  console.error = (m?: unknown) => { err.push(String(m)); };
  (process.stdout as unknown as { write: unknown }).write = (c: unknown) => { out.push(String(c)); return true; };
  (process as { exit: unknown }).exit = (code?: number) => { exit = code ?? 0; throw new Error('__test_exit'); };
  try { await runExtract(engine, args); } catch (e) { if (!(e instanceof Error && e.message === '__test_exit')) throw e; } finally {
    console.log = orig.log; console.error = orig.error; (process as { exit: unknown }).exit = orig.exit;
    (process.stdout as unknown as { write: unknown }).write = orig.write;
  }
  return { exit, out: out.join('\n'), err: err.join('\n') };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-7394-'));
  writeFileSync(join(dir, 'alice-example.md'), '---\ntype: person\ntitle: Alice Example\n---\n\n## Timeline\n\n- **2026-01-15** | Met with acme-example\n');
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice.',
    timeline: '- **2026-01-15** | Met with acme-example', frontmatter: {} });
}, 60_000);

afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

describe('page-row filters on extract (#7394)', () => {
  for (const sub of ['links', 'timeline', 'all']) {
    test(`extract ${sub} --type on the file walk refuses with the --source db command and walks nothing`, async () => {
      const r = await runCli([sub, '--dir', dir, '--type', 'banana', '--dry-run', '--json']);
      expect(r.exit).toBe(2);
      expect(r.err).toContain('--type filters synced pages, so it requires --source db');
      expect(r.err).toContain(`gbrain extract ${sub} --source db --type banana --dry-run --json`);
      expect(r.out).not.toContain('pages_processed');
    });
  }

  test('--since and --infer-dates on the file walk refuse the same way, naming every filter', async () => {
    const r = await runCli(['timeline', '--dir', dir, '--since', '2026-01-01', '--infer-dates', '--dry-run']);
    expect(r.exit).toBe(2);
    expect(r.err).toContain('--since, --infer-dates filter synced pages, so they require --source db');
    expect(r.err).toContain('gbrain extract timeline --source db --since 2026-01-01 --infer-dates --dry-run');
  });

  test('the file walk without a row filter still runs', async () => {
    const r = await runCli(['timeline', '--dir', dir, '--dry-run', '--json']);
    expect(r.exit).toBeNull();
    expect(JSON.parse(r.out.slice(r.out.lastIndexOf('{\n')))).toMatchObject({ pages_processed: 1 });
  });

  test('on --source db a type no page has processes no page; the page type processes its page', async () => {
    const none = await runCli(['timeline', '--source', 'db', '--type', 'banana', '--dry-run', '--json']);
    expect(none.exit).toBeNull();
    expect(JSON.parse(none.out.slice(none.out.lastIndexOf('{\n')))).toMatchObject({ pages_processed: 0, timeline_entries_created: 0 });
    const person = await runCli(['timeline', '--source', 'db', '--type', 'person', '--dry-run', '--json']);
    expect(JSON.parse(person.out.slice(person.out.lastIndexOf('{\n')))).toMatchObject({ pages_processed: 1 });
  });
});
