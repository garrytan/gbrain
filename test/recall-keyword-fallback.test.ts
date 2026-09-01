/**
 * #4720 — `gbrain recall <term>` keyword fallback in keyless mode.
 *
 * The bare positional is entity-first (listFactsByEntity). resolveEntitySlug
 * never returns null for non-empty input (slugify is the floor), so a literal
 * word from fact text ("commas") became a phantom entity slug that matched
 * nothing: recall printed zero results while `recall --all` listed the fact.
 * Post-fix contract, pinned here:
 *   - an entity-arm miss on a bare positional falls back to the SQL-level
 *     fact-text grep (same arm --grep uses) and returns the matching facts,
 *     with a one-line stderr note (stdout stays clean for --json);
 *   - a positional that IS a real entity slug keeps entity-only semantics;
 *   - a term matching nothing still returns empty (no crash, no note);
 *   - explicit --grep is untouched (no fallback second-guessing).
 *
 * Hermetic PGLite, keyless (no API keys touched).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runRecall } from '../src/commands/recall.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function captureRecall(args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await runRecall(engine, args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout, stderr };
}

describe('#4720 recall bare positional — fact-text fallback', () => {
  test('a literal word from fact text recalls the fact (the issue repro)', async () => {
    await engine.insertFact(
      {
        fact: 'The style guide forbids commas before conjunctions.',
        kind: 'fact',
        entity_slug: 'people/example',
        source: 'chat',
      },
      { source_id: 'default' },
    );

    const { stdout, stderr } = await captureRecall(['commas', '--json']);
    const payload = JSON.parse(stdout);
    expect(payload.total).toBe(1);
    expect(payload.facts[0].fact).toContain('commas');
    // The fallback is announced on stderr, never stdout (JSON stays clean).
    expect(stderr).toContain("no facts for entity 'commas'");
  });

  test('a real entity slug keeps entity-only semantics (no fallback note)', async () => {
    await engine.insertFact(
      { fact: 'Prefers dark roast.', kind: 'preference', entity_slug: 'people/example', source: 'unit' },
      { source_id: 'default' },
    );

    const { stdout, stderr } = await captureRecall(['people/example', '--json']);
    const payload = JSON.parse(stdout);
    expect(payload.total).toBe(1);
    expect(payload.facts[0].entity_slug).toBe('people/example');
    expect(stderr).not.toContain('matched');
  });

  test('a term matching neither entity nor fact text returns empty, no note', async () => {
    await engine.insertFact(
      { fact: 'Something unrelated.', kind: 'fact', entity_slug: 'people/example', source: 'unit' },
      { source_id: 'default' },
    );

    const { stdout, stderr } = await captureRecall(['zxqvnope', '--json']);
    const payload = JSON.parse(stdout);
    expect(payload.total).toBe(0);
    expect(payload.facts).toEqual([]);
    expect(stderr).not.toContain('matched');
  });

  test('explicit --grep alongside the positional suppresses the fallback', async () => {
    await engine.insertFact(
      { fact: 'The style guide forbids commas before conjunctions.', kind: 'fact', entity_slug: 'people/example', source: 'unit' },
      { source_id: 'default' },
    );

    // Positional resolves to no entity facts; --grep filter also misses.
    // Pre-#4720 semantics preserved: empty result, no fallback second-guess.
    const { stdout } = await captureRecall(['commas', '--grep', 'semicolons', '--json']);
    const payload = JSON.parse(stdout);
    expect(payload.total).toBe(0);
  });

  test('expired facts stay hidden from the fallback unless --include-expired', async () => {
    const row = await engine.insertFact(
      { fact: 'Old rule about commas.', kind: 'fact', entity_slug: 'people/example', source: 'unit' },
      { source_id: 'default' },
    );
    await engine.expireFact(row.id);

    const hidden = await captureRecall(['commas', '--json']);
    expect(JSON.parse(hidden.stdout).total).toBe(0);

    const shown = await captureRecall(['commas', '--include-expired', '--json']);
    expect(JSON.parse(shown.stdout).total).toBe(1);
  });
});

describe('#4720 fallback never crosses the source boundary', () => {
  test('a fact in ANOTHER source is not returned for the default source, and IS returned with --source other', async () => {
    // TWO non-default sources: with exactly one, the resolver's
    // sole_non_default tier would auto-route an unqualified recall to it and
    // the test would measure routing, not the fallback's source scope.
    for (const id of ['other', 'another']) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, '/nonexistent/' || $1) ON CONFLICT (id) DO NOTHING`,
        [id],
      );
    }
    await engine.insertFact(
      {
        fact: 'The style guide forbids commas before conjunctions.',
        kind: 'fact',
        entity_slug: 'people/example',
        source: 'chat',
      },
      { source_id: 'other' },
    );

    // Default source: the entity arm misses AND the text fallback stays inside
    // 'default' — the other source's fact must not leak across.
    const scoped = await captureRecall(['commas', '--json']);
    expect(JSON.parse(scoped.stdout).total).toBe(0);
    expect(scoped.stderr).not.toContain('matched');

    // Explicitly targeting the other source finds it through the fallback.
    const other = await captureRecall(['commas', '--source', 'other', '--json']);
    const payload = JSON.parse(other.stdout);
    expect(payload.total).toBe(1);
    expect(payload.facts[0].fact).toContain('commas');
    expect(other.stderr).toContain("no facts for entity 'commas'");
  });
});
