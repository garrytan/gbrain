/**
 * #8814: the stale_mentions hint told users to run
 * `gbrain unlink <from> <to> --link-type mentions --link-source mentions` for
 * every stale row, but typed_ner rows are stored under a verb link_type
 * (e.g. `founded`), so that command removed nothing. Each example now
 * carries its exact unlink command with the stored link_type.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { staleMentionsCheck } from '../src/commands/doctor/checks/stale-mentions.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('the suggested unlink removes a stale typed_ner link', async () => {
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example is a company.', timeline: '', frontmatter: {} });
  await engine.putPage('notes/meeting', { type: 'note', title: 'notes/meeting', compiled_truth: 'Quiet day.', timeline: '', frontmatter: {} });
  await engine.addLinksBatch([{ from_slug: 'notes/meeting', to_slug: 'companies/acme-example', link_type: 'founded', link_source: 'mentions', link_kind: 'typed_ner' }]);

  const check = await staleMentionsCheck(engine);
  expect(check.status).toBe('warn');
  const suggested = check.message.match(/--link-type (\S+) --link-source (\S+?)\.?(?:\s|$)/);
  expect(suggested).not.toBeNull();

  const ctx = { engine, remote: false, config: {}, logger: console, dryRun: false } as unknown as OperationContext;
  const removed = await operationsByName.remove_link!.handler(ctx, { from: 'notes/meeting', to: 'companies/acme-example', link_type: suggested![1], link_source: suggested![2] });
  expect(removed).toMatchObject({ removed: 1 });
  expect(check.message).toContain('gbrain unlink notes/meeting companies/acme-example --link-type founded --link-source mentions');
  expect(await engine.executeRaw("SELECT 1 FROM links WHERE link_source = 'mentions'")).toHaveLength(0);
});
