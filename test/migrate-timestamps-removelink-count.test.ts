/**
 * #4527 — two silent-data defects in the migrate/link plane:
 *
 *  1. `copyPageToTarget` handed `target.putPage` only the 6 PageInput fields,
 *     so `created_at` / `updated_at` on every migrated page reset to now() —
 *     an engine migration silently destroyed the whole brain's chronology
 *     (recency ranking, `--since` filters, timeline ordering all keyed on
 *     those columns). The copy must preserve the source row's timestamps.
 *
 *  2. `removeLink` returned `Promise<void>` in both engines and the
 *     `remove_link` op answered an unconditional `{ status: 'ok' }`, so a
 *     delete that matched ZERO rows (typo'd slug, wrong link_type, already
 *     removed) was indistinguishable from a real removal. The engines now
 *     return the deleted-row count (RETURNING) and the op reports it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget } from '../src/commands/migrate-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  target = new PGLiteEngine();
  await target.connect({});
  await target.initSchema();
});

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
});

describe('copyPageToTarget — timestamp preservation (#4527)', () => {
  test('created_at / updated_at survive the copy instead of resetting to now()', async () => {
    await source.putPage('history/old-page', {
      type: 'note', title: 'Old Page', compiled_truth: 'ancient body', timeline: '', frontmatter: {},
    });
    // Backdate the source row the way a years-old brain would look.
    const createdAt = '2021-03-04T05:06:07.000Z';
    const updatedAt = '2023-08-09T10:11:12.000Z';
    await source.executeRaw(
      `UPDATE pages SET created_at = $1, updated_at = $2 WHERE slug = $3 AND source_id = 'default'`,
      [createdAt, updatedAt, 'history/old-page'],
    );

    const page = await source.getPage('history/old-page');
    expect(page).not.toBeNull();
    await copyPageToTarget(source, target, page!);

    const copied = await target.getPage('history/old-page');
    expect(copied).not.toBeNull();
    expect(new Date(copied!.created_at).toISOString()).toBe(createdAt);
    expect(new Date(copied!.updated_at).toISOString()).toBe(updatedAt);
  });
});

describe('removeLink returns the deleted-row count (#4527)', () => {
  test('engine.removeLink reports how many edges actually died', async () => {
    await source.putPage('people/alice-example', {
      type: 'person', title: 'Alice', compiled_truth: 'a person', timeline: '', frontmatter: {},
    });
    await source.putPage('companies/acme-example', {
      type: 'company', title: 'Acme', compiled_truth: 'a company', timeline: '', frontmatter: {},
    });
    await source.addLink('people/alice-example', 'companies/acme-example', 'works there', 'works_at');
    await source.addLink('people/alice-example', 'companies/acme-example', 'founded it', 'founded');

    // A miss (no such type) removes nothing and says so.
    const missed = await source.removeLink('people/alice-example', 'companies/acme-example', 'invested_in');
    expect(missed).toBe(0);

    // A typed hit removes exactly the one row.
    const typed = await source.removeLink('people/alice-example', 'companies/acme-example', 'works_at');
    expect(typed).toBe(1);

    // Untyped removal reports the remaining edge count.
    const rest = await source.removeLink('people/alice-example', 'companies/acme-example');
    expect(rest).toBe(1);

    // Fully-gone pair: zero again.
    const gone = await source.removeLink('people/alice-example', 'companies/acme-example');
    expect(gone).toBe(0);
  });

  test('remove_link op surfaces removed count instead of an unconditional ok', async () => {
    await source.putPage('people/bob-example', {
      type: 'person', title: 'Bob', compiled_truth: 'a person', timeline: '', frontmatter: {},
    });
    await source.putPage('companies/widget-co', {
      type: 'company', title: 'Widget Co', compiled_truth: 'a company', timeline: '', frontmatter: {},
    });
    await source.addLink('people/bob-example', 'companies/widget-co', 'advises', 'advises');

    const op = operationsByName['remove_link'];
    expect(op).toBeDefined();
    const ctx = { engine: source, remote: false } as unknown as OperationContext;

    const hit = await op!.handler(ctx, { from: 'people/bob-example', to: 'companies/widget-co' }) as Record<string, unknown>;
    expect(hit.status).toBe('ok');
    expect(hit.removed).toBe(1);

    // Second identical call matches nothing — the caller can now tell.
    const miss = await op!.handler(ctx, { from: 'people/bob-example', to: 'companies/widget-co' }) as Record<string, unknown>;
    expect(miss.status).toBe('ok');
    expect(miss.removed).toBe(0);
  });
});
