/**
 * GBRA-200 (harness ask 6): the degraded stamp through the real CLI. On a
 * PGLite brain with an embedding model configured but no provider key (no
 * embedding provider) every search and recall is degraded
 * with `embed_unavailable`: a `--json` object carries a `degraded` key; a bare
 * `--json` array and human output keep stdout unchanged and put the one-line
 * marker on stderr; a page read that is not degraded carries none. A brain
 * keyless on purpose (`init --no-embedding`) searches keyword-only by design,
 * so its results carry no stamp and an empty one is a true negative.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gb } from './helpers/agent-journey.ts';

const MARKER = '[gbrain degraded: ';
let home: string;
let chosen: string;

async function brain(prefix: string, initArgs: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const init = await gb(dir, ['init', '--pglite', ...initArgs, '--json']);
  expect(init.exitCode).toBe(0);
  const notes = join(dir, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'alice-example.md'), '---\ntitle: Alice Example\ntype: person\n---\nAlice Example is a builder working on degraded stamps.\n');
  const imported = await gb(dir, ['import', notes, '--no-embed', '--json']);
  expect(imported.exitCode).toBe(0);
  return dir;
}

beforeAll(async () => {
  home = await brain('gbrain-degraded-cli-', ['--embedding-model', 'openai:text-embedding-3-small', '--skip-embed-check']);
  chosen = await brain('gbrain-keyless-cli-', ['--no-embedding']);
}, 180_000);

afterAll(() => { for (const dir of [home, chosen]) rmSync(dir, { recursive: true, force: true }); });

describe('CLI degraded stamp (no embedding provider)', () => {
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
    expect(doc.search_degraded).toBe('keyword_only_no_embedding_provider');
    expect(doc.degraded?.reasons).toContain('embed_unavailable');
  }, 60_000);

  test('get --json on a clean page: no degraded key, no marker', async () => {
    const r = await gb(home, ['get', 'alice-example', '--json']);
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as Record<string, unknown>).degraded).toBeUndefined();
    expect(r.stderr).not.toContain(MARKER);
  }, 60_000);
});

describe('CLI on a brain keyless on purpose (init --no-embedding)', () => {
  test('search --json and human output carry no marker, found or not', async () => {
    for (const args of [['search', 'builder', '--json'], ['search', 'builder'], ['search', 'zebraflamingo', '--json']]) {
      const r = await gb(chosen, args);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain(MARKER);
      expect(r.stdout).not.toContain(MARKER);
      expect(r.stdout + r.stderr).not.toContain('degraded_recall');
      expect(r.stderr).toContain('search is keyword-only');
    }
  }, 60_000);

  test('an empty human search says it was keyword-only on purpose and a true negative, not degraded', async () => {
    const r = await gb(chosen, ['search', 'zebraflamingo']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Search was keyword-only because embeddings are off on this brain on purpose, and no page this caller can read holds these words');
    expect(r.stdout).not.toContain('degraded:');
  }, 60_000);

  test('recall --json: no degraded key; search_degraded still says the search was keyword-only on purpose', async () => {
    const r = await gb(chosen, ['recall', '--query', 'builder', '--json']);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout) as { degraded?: unknown; search_degraded?: string };
    expect(doc.search_degraded).toBe('keyword_only_embedding_disabled');
    expect(doc.degraded).toBeUndefined();
    expect(r.stderr).not.toContain(MARKER);
    expect(r.stdout + r.stderr).not.toContain('degraded_recall');
  }, 60_000);
});
