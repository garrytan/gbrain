/**
 * GBRA-200 (harness ask 6): the degraded stamp through the real CLI on a
 * keyless PGLite brain (keyword-only by choice, so every search and recall is
 * degraded with `embed_unavailable`). A `--json` object carries a `degraded`
 * key; a bare `--json` array and human output keep stdout unchanged and put
 * the one-line marker on stderr; a page read that is not degraded carries none.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gb } from './helpers/agent-journey.ts';

const MARKER = '[gbrain degraded: ';
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-degraded-cli-'));
  const init = await gb(home, ['init', '--pglite', '--no-embedding', '--json']);
  expect(init.exitCode).toBe(0);
  const notes = join(home, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'alice-example.md'), '---\ntitle: Alice Example\ntype: person\n---\nAlice Example is a builder working on degraded stamps.\n');
  const imported = await gb(home, ['import', notes, '--no-embed', '--json']);
  expect(imported.exitCode).toBe(0);
}, 120_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('CLI degraded stamp', () => {
  test('search --json: stdout stays the bare row array; the marker is on stderr', async () => {
    const r = await gb(home, ['search', 'builder', '--json']);
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ slug: string }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map(row => row.slug)).toContain('alice-example');
    expect(r.stderr).toContain(`${MARKER}embed_unavailable`);
    expect(r.stdout).not.toContain(MARKER);
  }, 60_000);

  test('search, human output: the marker is on stderr', async () => {
    const r = await gb(home, ['search', 'builder']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('alice-example');
    expect(r.stderr.split('\n').filter(l => l.startsWith(MARKER))).toHaveLength(1);
  }, 60_000);

  test('recall --json: the document carries degraded.reasons', async () => {
    const r = await gb(home, ['recall', '--query', 'builder', '--json']);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout) as { degraded?: { reasons: string[] }; search_degraded?: string };
    expect(doc.search_degraded).toBe('keyword_only_embedding_disabled');
    expect(doc.degraded?.reasons).toContain('embed_unavailable');
  }, 60_000);

  test('get --json on a clean page: no degraded key, no marker', async () => {
    const r = await gb(home, ['get', 'alice-example', '--json']);
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as Record<string, unknown>).degraded).toBeUndefined();
    expect(r.stderr).not.toContain(MARKER);
  }, 60_000);
});
